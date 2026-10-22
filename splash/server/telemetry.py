"""Precise, payload-free JSONL lifecycle events (enabled by the launcher)."""

import atexit
import datetime
import json
import os
import queue
import re
import sys
import threading
import time
import uuid

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
