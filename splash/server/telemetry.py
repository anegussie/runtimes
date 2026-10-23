"""Precise, payload-free JSONL lifecycle events (enabled by the launcher)."""

import atexit
import datetime
import hashlib
import json
import math
import os
import platform
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

INSTANCE_ID = str(uuid.uuid4())
_lock = threading.Lock()
_failures = 0
_dropped = 0
_events = queue.Queue(maxsize=2048)
_writer = None


def correlation(headers):
    """Accept only bounded identifiers, never arbitrary header values."""
    result = {}
    for name in (
        "request-id",
        "session-id",
        "parent-session-id",
        "agent",
        "request-kind",
    ):
        value = headers.get("x-opencode-" + name)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
            result[name.replace("-", "_")] = value
    return result


def clocks():
    return {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "wallTimeNs": str(time.time_ns()),
        "monotonicNs": str(time.monotonic_ns()),
    }


def emit(record, path=None):
    """Write one atomic event; telemetry failure never fails inference."""
    global _failures
    path = path or os.environ.get("SPLASH_TELEMETRY_PATH")
    if not path:
        return
    try:
        data = (
            json.dumps(
                {
                    "schemaVersion": 2,
                    "eventID": str(uuid.uuid4()),
                    "processInstanceID": INSTANCE_ID,
                    "pid": os.getpid(),
                    **clocks(),
                    **record,
                },
                allow_nan=False,
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        # Timestamped capture fields in record survive asynchronous finalization.
        with _lock:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                remaining = memoryview(data)
                while remaining:
                    written = os.write(fd, remaining)
                    if written <= 0:
                        raise OSError("zero-length telemetry write")
                    remaining = remaining[written:]
            finally:
                os.close(fd)
    except (OSError, TypeError, ValueError) as error:
        with _lock:
            _failures += 1
            if _failures == 1:
                print(
                    f"Telemetry write failed ({type(error).__name__}); inference continues",
                    file=sys.stderr,
                    flush=True,
                )


def health():
    with _lock:
        return {
            "enabled": bool(os.environ.get("SPLASH_TELEMETRY_PATH")),
            "write_failures": _failures,
            "dropped_events": _dropped,
            "queued_events": _events.qsize(),
            "process_instance_id": INSTANCE_ID,
        }


def run_manifest(args, model_root, native_command, status, instance_id):
    """Record reproducible startup metadata without argv secrets or weight I/O.

    The assembly's content digests were recorded by the installer. Startup
    validates file metadata; this does not claim a fresh full weight hash.
    Every failure here is diagnostic only and must not prevent serving.
    """
    if not os.environ.get("SPLASH_TELEMETRY_PATH"):
        return
    record = {"event": "run_manifest", "instance_id": instance_id}
    try:
        root = Path(model_root).resolve()
        options = (
            "model",
            "model_root",
            "binary",
            "tokenizer",
            "host",
            "port",
            "max_context",
            "max_memory",
            "max_cache_disk",
            "max_cache_disk_writes",
            "persistent_cache",
            "cache_dir",
            "kv_format",
            "state_format",
            "prefill_chunk_tokens",
            "max_active_requests",
            "queue_size",
            "expert_memory",
            "ple_memory",
            "sparse_kv_memory",
            "verify_rows",
            "disable_ane",
            "decode_share",
            "resource_wait_timeout",
            "idle_release",
            "allow_idle_sleep",
            "language_only",
            "default_reasoning_effort",
            "thinking_token_budget",
            "served_model_name",
            "request_timeout",
        )
        record.update(
            model_root=str(root),
            launch_options={
                key: (
                    "off"
                    if key == "idle_release" and value == math.inf
                    else str(value)
                    if isinstance(value, Path)
                    else value
                )
                for key in options
                if hasattr(args, key)
                for value in (getattr(args, key),)
            },
            native_command=[str(value) for value in native_command],
            python_version=platform.python_version(),
            platform=platform.platform(),
        )
        source_root = Path(__file__).resolve().parents[1]
        record["server_source_sha256"] = {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((source_root / "server").glob("*.py"))
        }
        try:
            record["checkout_commit"] = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=source_root,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2,
            ).strip()
            changed = subprocess.run(
                ["git", "diff", "--quiet", "HEAD", "--", "server", "install"],
                cwd=source_root,
                timeout=2,
                capture_output=True,
            )
            record["serving_sources_dirty"] = (
                bool(changed.returncode) if changed.returncode in (0, 1) else None
            )
        except (OSError, subprocess.SubprocessError):
            record["checkout_commit"] = None
        try:
            with (root / "model.json").open("rb") as stream:
                data = stream.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError("assembly record exceeds metadata limit")
            assembly = json.loads(data)
            record["assembly"] = {
                key: assembly.get(key)
                for key in ("model", "family", "target_format", "vision_format")
            }
            record["assembly"]["sources"] = {
                role: {key: source.get(key) for key in ("repo", "revision")}
                for role, source in assembly.get("sources", {}).items()
                if role in ("target", "draft")
            }
            record["assembly"]["files"] = {
                name: {key: entry.get(key) for key in ("path", "bytes", "digest")}
                for name, entry in assembly.get("files", {}).items()
            }
            record["assembly_record_sha256"] = hashlib.sha256(data).hexdigest()
            record["artifact_digest_scope"] = (
                "installer_recorded_not_rehashed_at_telemetry_start"
            )
        except (OSError, ValueError, TypeError) as error:
            record["assembly_unavailable"] = type(error).__name__
        try:
            snapshot = status()
            record["initial_status"] = {
                key: snapshot.get(key)
                for key in (
                    "identity",
                    "memory_plan",
                    "maximum_context_tokens",
                    "prefill_chunk_tokens",
                    "verify_rows",
                    "streamed_experts",
                    "disk",
                    "cache",
                    "requests",
                    "thermal_state",
                    "memory_pressure",
                )
            }
        except Exception as error:
            record["initial_status_unavailable"] = type(error).__name__
    except Exception as error:
        record["manifest_error"] = type(error).__name__
    emit(record)


def _write_loop():
    while True:
        item = _events.get()
        try:
            if isinstance(item, threading.Event):
                item.set()
            else:
                record, path = item
                emit(record, path)
        finally:
            _events.task_done()


def enqueue(record):
    """Never block the native reader on disk I/O; expose any queue loss."""
    global _writer, _dropped
    path = os.environ.get("SPLASH_TELEMETRY_PATH")
    if not path:
        return
    with _lock:
        if _writer is None:
            _writer = threading.Thread(
                target=_write_loop, name="splash-telemetry", daemon=True
            )
            _writer.start()
    try:
        _events.put_nowait((record, path))
    except queue.Full:
        with _lock:
            _dropped += 1
            if _dropped == 1:
                print(
                    "Telemetry queue full; dropped_events exposed in /status",
                    file=sys.stderr,
                    flush=True,
                )


def flush(timeout=2):
    if _writer is None:
        return True
    done = threading.Event()
    try:
        _events.put(done, timeout=timeout)
    except queue.Full:
        return False
    return done.wait(timeout)


atexit.register(flush)
