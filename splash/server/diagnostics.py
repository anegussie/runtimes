"""Concise console diagnostics without request-body logging."""

import math
import sys
import time


def log_unexpected(error):
    try:
        print_status(
            f"Error · internal_server_error · {type(error).__name__}", error=True
        )
    except Exception:
        pass


def print_status(message, *, error=False):
    # One write per line, newline included, so that lines written at once by
    # request threads, or by the native runtime on the shared stderr, stay
    # whole in a terminal or in one log file.
    stream = sys.stderr if error else sys.stdout
    stream.write(f"{time.strftime('%H:%M:%S')} {message}\n")
    stream.flush()


def print_request(record):
    outcome = record["outcome"]
    if outcome == "error":
        suffix = f" · request={record['request_id']}" if "request_id" in record else ""
        print_status(
            f"Error · {record.get('error_code', 'runtime_error')}{suffix} · frontend_queue={record.get('frontend_queue_ms', 0) / 1000:.3f}s",
            error=True,
        )
        return
    metrics = record.get("metrics", {})
    latency = metrics.get("request_latency", {})
    parts = [
        "Cancelled" if outcome == "cancelled" else "Done",
        f"input {record['prompt_tokens']:,}",
        f"cached {metrics.get('cache', {}).get('matched_tokens', 0):,}",
        f"output {record.get('completion_tokens', 0):,}",
    ]
    tools = record.get("tools")
    if isinstance(tools, dict) and tools.get("count"):
        parts.append(f"tools {tools['count']}·{tools.get('signature', '')}")
    prefill = metrics.get("prefill", {})
    prefill_tokens = prefill.get("tokens")
    prefill_ms = latency.get("start_to_first_token_ms")
    if (
        isinstance(prefill_tokens, int)
        and isinstance(prefill_ms, (int, float))
        and math.isfinite(prefill_ms)
    ):
        parts.append(f"prefill {prefill_tokens:,}/{prefill_ms / 1000:.2f}s")
        if prefill_ms > 0:
            parts.append(f"PP {prefill_tokens * 1000 / prefill_ms:.1f} tok/s")
    decode = metrics.get("decode", {})
    decode_tokens = decode.get("tokens")
    decode_ms = latency.get("first_token_to_done_ms")
    if (
        isinstance(decode_tokens, int)
        and isinstance(decode_ms, (int, float))
        and math.isfinite(decode_ms)
    ):
        parts.append(f"decode {decode_tokens:,}/{decode_ms / 1000:.2f}s")
    ttft = latency.get("ttft_ms")
    speed = latency.get("stream_tokens_per_second")
    if ttft is not None:
        parts.append(f"TTFT {ttft / 1000:.1f}s")
        parts.append(
            f"TTFT_with_frontend_queue {(ttft + record.get('frontend_queue_ms', 0)) / 1000:.1f}s"
        )
    if isinstance(speed, (int, float)) and math.isfinite(speed):
        parts.append(f"TPS {speed:.1f} tok/s")
    if "request_id" in record:
        parts.extend((f"request={record['request_id']}", f"finish={outcome}"))
        parts.append(f"frontend_queue={record.get('frontend_queue_ms', 0) / 1000:.3f}s")
        queued = latency.get("queue_to_start_ms")
        if isinstance(queued, (int, float)) and math.isfinite(queued):
            parts.append(f"native_queue={queued / 1000:.3f}s")
        wall = latency.get("wall_ms")
        if isinstance(wall, (int, float)) and math.isfinite(wall):
            parts.append(f"native_wall={wall / 1000:.3f}s")
    print_status(" · ".join(parts))
