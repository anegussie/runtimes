#!/usr/bin/env bash
set -uo pipefail

PORT="${LLAMA_PORT:-1235}"
HOST="${LLAMA_HOST:-127.0.0.1}"
METRICS_URL="http://${HOST}:${PORT}/v1/metrics"
LOG_DIR="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
LATEST_LOG="$LOG_DIR/qwen-mlx-reasoning-latest.log"
METRICS_JSONL="$LOG_DIR/qwen-mlx-reasoning-metrics.jsonl"
OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
PYTHON="${MLX_VLM_PYTHON:-$HOME/.mlx-qwen-mtp/venv/bin/python}"
SPLASH_MONITOR="${RUNTIME_ROOT}/scripts/monitorsplash.sh"

if [[ "${1:-}" == "--splash" ]]; then
  shift
  exec bash "$SPLASH_MONITOR" "$@"
fi
if [[ "${1:-}" == "--mlx" ]]; then
  shift
elif command -v jq >/dev/null 2>&1 &&
     curl --max-time 2 -fsS "http://${HOST}:${PORT}/status" 2>/dev/null |
       jq -e '.memory_governor != null and .metrics != null' >/dev/null 2>&1; then
  exec bash "$SPLASH_MONITOR" "$@"
fi

usage() {
  cat <<'EOF'
Usage: monitorllamacpp.sh [mode]

  --splash [mode]   Force the Splash monitor (auto-detected when serving)
  --mlx [mode]      Force the MLX monitor

  --watch [seconds]  Refresh formatted live statistics (default, 2 seconds)
  --once             Print one formatted statistics snapshot
  --status           Alias for --once
  --json             Print the raw /v1/metrics JSON
  --log              Follow the current option 8 server log
  --history [count]  Print recent durable request records (default 10)
  --report [hours]   Aggregate server and OpenCode performance (default 24)
  --help              Show this help
EOF
}

fetch_metrics() {
  curl -fsS --max-time 2 "$METRICS_URL"
}

listener_pid() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

print_busy_server() {
  local pid="$1"
  local activity=""

  echo "SERVER"
  echo "  status=busy  pid=$pid  endpoint=$METRICS_URL"
  echo "  The server is listening, but the metrics endpoint did not respond within 2 seconds."
  echo "  This normally means a long prefill or decode is occupying the single MLX worker."
  if [[ -e "$LATEST_LOG" ]]; then
    activity="$(tail -n 250 "$LATEST_LOG" 2>/dev/null | grep -E 'Request started:|Prefill progress:|Decode progress:|Request completed:' | tail -n 1 || true)"
    if [[ -n "$activity" ]]; then
      echo "  latest_activity: $activity"
    fi
  fi
}

render_metrics() {
  "$PYTHON" -c '
import datetime
import json
import sys
import time

d = json.load(sys.stdin)
latest = d.get("latest") or {}
summary = d.get("summary") or {}
server = d.get("server") or {}
apc = (server.get("apc") or {}).get("enabled", False)

print("SERVER")
print("  model=%s  context=%s/%s  in_flight=%s  queue=%s  APC=%s" % (
    server.get("loaded_model", "n/a"),
    server.get("effective_context_limit", "n/a"),
    server.get("loaded_context_size", "n/a"),
    summary.get("in_flight", 0),
    server.get("request_queue_depth", 0),
    "on" if apc else "off",
))

if latest:
    stamp = float(latest.get("timestamp_unix") or 0)
    age = max(0.0, time.time() - stamp) if stamp else 0.0
    when = datetime.datetime.fromtimestamp(stamp).strftime("%Y-%m-%d %H:%M:%S") if stamp else "n/a"
    prompt = int(latest.get("prompt_tokens") or 0)
    cached = int(latest.get("cached_prompt_tokens") or 0)
    cache_pct = 100.0 * cached / prompt if prompt else 0.0
    print("LATEST  %s  age=%.1fs  run=%s  seq=%s" % (
        when, age, latest.get("run_id", "legacy"), latest.get("request_sequence", "n/a")))
    print("  request: profile=%s  model=%s  thinking=%s  finish=%s" % (
        latest.get("profile", "unknown"), latest.get("model", "n/a"),
        "on" if latest.get("thinking_enabled") else "off", latest.get("finish_reason", "n/a")))
    generated = int(latest.get("generated_tokens") or 0)
    reasoning = int(latest.get("reasoning_tokens") or 0)
    final_tokens = int(latest.get("final_tokens") or 0)
    uncached = int(latest.get("uncached_prompt_tokens") if latest.get("uncached_prompt_tokens") is not None else max(0, prompt - cached))
    print("  tokens: prompt=%d  cached=%d (%.1f%%, %s)  uncached=%d  generated=%d  reasoning=%d  final=%d" % (
        prompt, cached, cache_pct, latest.get("cache_bucket", "legacy"), uncached,
        generated, reasoning, final_tokens))
    if latest.get("prompt_budget_tokens"):
        print("  usage:  prompt=%d/%d (%.1f%%)  output=%d/%d (%.1f%%)  context=%.1f%%  reasoning=%.1f%%" % (
            prompt, int(latest.get("prompt_budget_tokens") or 0),
            float(latest.get("prompt_utilization_pct") or 0), generated,
            int(latest.get("max_output_tokens_configured") or 0),
            float(latest.get("output_utilization_pct") or 0),
            float(latest.get("context_utilization_pct") or 0),
            float(latest.get("reasoning_share_pct") or 0)))
        print("          reserved_headroom=%d  finish_headroom=%d  thinking=%d (%.1f%%)" % (
            int(latest.get("reserved_context_headroom_tokens") or 0),
            int(latest.get("context_headroom_at_finish_tokens") or 0),
            int(latest.get("thinking_budget_tokens_configured") or 0),
            float(latest.get("reasoning_utilization_pct") or 0)))
    print("  speed:  apparent_PP=%.1f  uncached_PP=%.1f tok/s  TPS=%.1f tok/s  generated_E2E=%.1f tok/s" % (
        float(latest.get("prefill_tok_s") or 0),
        float(latest.get("uncached_prefill_tok_s") or 0),
        float(latest.get("decode_tok_s") or 0),
        float(latest.get("generated_request_tok_s") or latest.get("request_tok_s") or 0)))
    print("  timing: prefill=%.3fs  TTFT=%.3fs  TTFT_overhead=%.3fs  decode=%.3fs  other=%.3fs  total=%.3fs" % (
        float(latest.get("prompt_eval_time_s") or 0),
        float(latest.get("ttft_s") or 0),
        float(latest.get("ttft_overhead_s") or 0),
        float(latest.get("decode_elapsed_s") or 0),
        float(latest.get("non_compute_overhead_s") or 0),
        float(latest.get("request_elapsed_s") or 0)))
    first32 = float(latest.get("sliding_decode_tok_s_first_32") or 0)
    last32 = float(latest.get("sliding_decode_tok_s_last_32") or 0)
    if first32 or last32:
        print("  decode: first32=%.1f  last32=%.1f tok/s  slowdown=%.1f%%" % (
            first32, last32, float(latest.get("decode_slowdown_pct") or 0)))
    if int(latest.get("mtp_drafted") or 0) > 0:
        print("  MTP:    accept=%.1f%% (%d/%d)  rejected=%d  accepted/round=%.2f" % (
            float(latest.get("mtp_acceptance_pct") or 0),
            int(latest.get("mtp_accepted") or 0),
            int(latest.get("mtp_drafted") or 0),
            int(latest.get("mtp_rejected") or 0),
            float(latest.get("mtp_accepted_per_round") or 0)))
        print("          draft_width=%.2f  output/verification=%.2f  target_steps_saved=%.1f%%" % (
            float(latest.get("mtp_draft_width") or 0),
            float(latest.get("mtp_tokens_per_verification") or 0),
            float(latest.get("mtp_target_step_reduction_pct") or 0)))
    else:
        print("  MTP:    disabled for enforced reasoning budget")
    print("  memory: peak=%.2f GB" % float(latest.get("peak_memory_gb") or 0))
    warnings = latest.get("warnings") or []
    print("  flags:  %s" % (", ".join(warnings) if warnings else "none"))
else:
    print("LATEST  no completed requests")

print("SESSION TOTALS")
print("  requests: completed=%d  failed=%d  active=%d" % (
    int(summary.get("requests_completed") or 0),
    int(summary.get("requests_failed") or 0),
    int(summary.get("in_flight") or 0)))
print("  weighted: apparent_PP=%.1f  uncached_PP=%.1f tok/s  TPS=%.1f tok/s  E2E=%.1f tok/s  avg_TTFT=%.3fs" % (
    float(summary.get("avg_prefill_tok_s") or 0),
    float(summary.get("avg_uncached_prefill_tok_s") or 0),
    float(summary.get("avg_decode_tok_s") or 0),
    float(summary.get("avg_request_tok_s") or 0),
    float(summary.get("avg_ttft_s") or 0)))
if int(latest.get("mtp_drafted") or 0) > 0:
    print("  MTP: accept=%.1f%%  accepted/round=%.2f  output/verification=%.2f" % (
        float(summary.get("mtp_acceptance_pct") or 0),
        float(summary.get("mtp_accepted_per_round") or 0),
        float(summary.get("mtp_tokens_per_verification") or 0)))
print("  tokens: prompt=%d  cached=%d  output=%d  peak=%.2f GB" % (
    int(summary.get("prompt_tokens_total") or 0),
    int(summary.get("cached_prompt_tokens_total") or 0),
    int(summary.get("generated_tokens_total") or 0),
    float(summary.get("peak_memory_gb") or 0)))
print("  risk: context>=90%%=%d  reasoning-cap=%d  output-cap=%d  other-time=%.1fs" % (
    int(summary.get("context_risk_requests") or 0),
    int(summary.get("reasoning_budget_hit_requests") or 0),
    int(summary.get("output_limit_hit_requests") or 0),
    float(summary.get("non_compute_overhead_total_s") or 0)))
'
}

print_once() {
  local payload=""
  local pid=""
  if ! payload="$(fetch_metrics 2>/dev/null)"; then
    pid="$(listener_pid || true)"
    if [[ -n "$pid" ]]; then
      print_busy_server "$pid"
      return 0
    fi
    echo "Option 8 is not running at $METRICS_URL" >&2
    echo "Start it with ${RUNTIME_ROOT}/startllamacpp.sh and choose option 8." >&2
    return 1
  fi
  printf '%s\n' "$payload" | render_metrics
}

mode="${1:---watch}"
case "$mode" in
  --watch)
    interval="${2:-2}"
    if ! [[ "$interval" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      echo "Watch interval must be a positive number." >&2
      exit 2
    fi
    while true; do
      if [[ -t 1 && -n "${TERM:-}" ]]; then
        clear
      fi
      date '+Option 8 monitor — %Y-%m-%d %H:%M:%S'
      echo
      print_once || true
      echo
      echo "Refresh: ${interval}s | Ctrl-C stops only this monitor"
      sleep "$interval"
    done
    ;;
  --once|--status)
    print_once
    ;;
  --json)
    fetch_metrics
    echo
    ;;
  --log)
    if [[ ! -e "$LATEST_LOG" ]]; then
      echo "No option 8 log exists yet: $LATEST_LOG" >&2
      exit 1
    fi
    echo "Following $LATEST_LOG (Ctrl-C stops only this viewer)"
    exec tail -F "$LATEST_LOG"
    ;;
  --history)
    count="${2:-10}"
    if ! [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
      echo "History count must be a positive integer." >&2
      exit 2
    fi
    if [[ ! -f "$METRICS_JSONL" ]]; then
      echo "No durable option 8 metrics exist yet: $METRICS_JSONL" >&2
      exit 1
    fi
    "$PYTHON" -c '
import collections, datetime, json, sys
rows = collections.deque(maxlen=int(sys.argv[2]))
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        try: rows.append(json.loads(line))
        except json.JSONDecodeError: pass
for row in rows:
    x = row.get("request") or {}
    stamp = float(x.get("timestamp_unix") or 0)
    when = datetime.datetime.fromtimestamp(stamp).strftime("%Y-%m-%d %H:%M:%S") if stamp else "n/a"
    event = row.get("event") or "request_completed"
    if event == "request_failed":
        print("%s  FAIL run=%s  profile=%s  model=%s  kind=%s  prompt=%s  output=%s  overflow=%s  error=%s" % (
            when, x.get("run_id", "legacy"), x.get("profile", "unknown"),
            x.get("model", "n/a"), x.get("error_kind", "other"),
            x.get("prompt_tokens", "n/a"), x.get("max_output_tokens_requested", "n/a"),
            x.get("context_overflow_tokens", "n/a"), x.get("error", "unknown")))
        continue
    prompt = int(x.get("prompt_tokens") or 0)
    cached = int(x.get("cached_prompt_tokens") or 0)
    uncached = int(x.get("uncached_prompt_tokens") if x.get("uncached_prompt_tokens") is not None else max(0, prompt - cached))
    cache_pct = float(x.get("cache_hit_pct") if x.get("cache_hit_pct") is not None else (100 * cached / prompt if prompt else 0))
    cache_bucket = x.get("cache_bucket") or ("cold" if cached <= 0 else ("warm_lt40" if cache_pct < 40 else ("warm_40_80" if cache_pct < 80 else "warm_ge80")))
    prefill_s = float(x.get("prompt_eval_time_s") or 0)
    uncached_pp = float(x.get("uncached_prefill_tok_s") if x.get("uncached_prefill_tok_s") is not None else (uncached / prefill_s if prefill_s else 0))
    overhead = float(x.get("non_compute_overhead_s") if x.get("non_compute_overhead_s") is not None else max(0, float(x.get("request_elapsed_s") or 0) - prefill_s - float(x.get("decode_elapsed_s") or 0)))
    headroom = int(x.get("reserved_context_headroom_tokens") if x.get("reserved_context_headroom_tokens") is not None else int(x.get("context_limit_tokens") or 0) - prompt - int(x.get("max_output_tokens_configured") or 0))
    print("%s  run=%s  seq=%s  profile=%s  model=%s  prompt=%d  cached=%.1f%%/%s  uncached=%d  generated=%d  reasoning=%d  final=%d  uPP=%.1f  TPS=%.1f  TTFT=%.3fs  overhead=%.3fs  total=%.3fs  headroom=%d  flags=%s  finish=%s" % (
        when, x.get("run_id", "legacy"), x.get("request_sequence", "n/a"),
        x.get("profile", "unknown"), x.get("model", "n/a"),
        prompt, cache_pct, cache_bucket, uncached,
        int(x.get("generated_tokens") or 0),
        int(x.get("reasoning_tokens") or 0), int(x.get("final_tokens") or 0),
        uncached_pp, float(x.get("decode_tok_s") or 0),
        float(x.get("ttft_s") or 0), overhead,
        float(x.get("request_elapsed_s") or 0), headroom,
        ",".join(x.get("warnings") or []) or "none",
        x.get("finish_reason", "n/a")))
' "$METRICS_JSONL" "$count"
    ;;
  --report)
    hours="${2:-24}"
    if ! [[ "$hours" =~ ^[0-9]+([.][0-9]+)?$ ]] || [[ "$hours" == "0" || "$hours" == "0.0" ]]; then
      echo "Report hours must be a positive number." >&2
      exit 2
    fi
    "$PYTHON" - "$METRICS_JSONL" "$OPENCODE_DB" "$hours" <<'PY'
import collections
import datetime
import json
import math
import os
import sqlite3
import sys
import time

metrics_path, db_path, hours_raw = sys.argv[1:]
hours = float(hours_raw)
cutoff = time.time() - hours * 3600

def num(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0

def pct(values, q):
    if not values:
        return 0.0
    values = sorted(values)
    pos = (len(values) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return values[lo]
    return values[lo] * (hi - pos) + values[hi] * (pos - lo)

records = []
if os.path.isfile(metrics_path):
    with open(metrics_path, encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
                request = row.get("request") or {}
                if num(request.get("timestamp_unix")) >= cutoff:
                    records.append(row)
            except (json.JSONDecodeError, TypeError):
                pass

print("PERFORMANCE REPORT  last %.1f hours  generated %s" % (
    hours, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
print("Server metrics: %s" % metrics_path)

groups = collections.defaultdict(list)
failures = collections.Counter()
failure_kinds = collections.Counter()
run_configs = {}
for row in records:
    request = row.get("request") or {}
    run = row.get("run") or {}
    run_id = request.get("run_id") or run.get("run_id") or "legacy"
    profile = request.get("profile")
    if not profile:
        lowered_model = str(request.get("model") or "").lower()
        profile = "worker" if "worker" in lowered_model else ("balanced" if "balanced" in lowered_model else ("reasoner" if "planner" in lowered_model or "reasoner" in lowered_model else "unknown"))
    model = request.get("model") or "n/a"
    key = (run_id, profile, model)
    if run:
        run_configs[run_id] = run
    if (row.get("event") or "request_completed") == "request_failed":
        failures[key] += 1
        failure_kinds[(key, request.get("error_kind") or "other")] += 1
    else:
        groups[key].append(request)

print("\nSERVER BY RUN / PROFILE")
if not groups and not failures:
    print("  No durable requests in this time window.")
for key in sorted(set(groups) | set(failures)):
    run_id, profile, model = key
    items = groups[key]
    prompt = sum(num(x.get("prompt_tokens")) for x in items)
    generated = sum(num(x.get("generated_tokens")) for x in items)
    prefill_s = sum(num(x.get("prompt_eval_time_s")) for x in items)
    decode_s = sum(num(x.get("decode_elapsed_s")) for x in items)
    totals = [num(x.get("request_elapsed_s")) for x in items]
    ttfts = [num(x.get("ttft_s")) for x in items if x.get("ttft_s") is not None]
    prompts = [num(x.get("prompt_tokens")) for x in items]
    outputs = [num(x.get("generated_tokens")) for x in items]
    reasoning = sum(num(x.get("reasoning_tokens")) for x in items)
    final = sum(num(x.get("final_tokens")) for x in items)
    cached = sum(num(x.get("cached_prompt_tokens")) for x in items)
    uncached = sum(num(x.get("uncached_prompt_tokens", max(0, num(x.get("prompt_tokens")) - num(x.get("cached_prompt_tokens"))))) for x in items)
    overheads = [num(x.get("non_compute_overhead_s")) for x in items]
    slowdowns = [num(x.get("decode_slowdown_pct")) for x in items if x.get("decode_slowdown_pct") is not None]
    reserved_headroom = [num(x.get("reserved_context_headroom_tokens")) for x in items]
    cache_buckets = collections.Counter(x.get("cache_bucket") or "legacy" for x in items)
    warnings = collections.Counter(flag for x in items for flag in (x.get("warnings") or []))
    peak = max([num(x.get("peak_memory_gb")) for x in items] or [0])
    tool_rate = 100 * sum(bool(x.get("tool_calls")) for x in items) / len(items) if items else 0
    pp = prompt / prefill_s if prefill_s else 0
    uncached_pp = uncached / prefill_s if prefill_s else 0
    tps = generated / decode_s if decode_s else 0
    cache_pct = 100 * cached / prompt if prompt else 0
    reason_pct = 100 * reasoning / generated if generated else 0
    print("  run=%s  profile=%s  model=%s" % (run_id, profile, model))
    config = run_configs.get(run_id) or {}
    if config:
        print("    config=%s  server/client/reserve=%s/%s/%s  output(R/B/W)=%s/%s/%s  thinking(R/B)=%s/%s" % (
            config.get("server_profile", "n/a"), config.get("context_limit_tokens", "n/a"),
            config.get("client_context_limit_tokens", "n/a"), config.get("compaction_reserve_tokens", "n/a"),
            config.get("reasoner_output_limit_tokens", "n/a"), config.get("balanced_output_limit_tokens", "n/a"),
            config.get("worker_output_limit_tokens", "n/a"), config.get("thinking_budget_tokens", "n/a"),
            config.get("balanced_thinking_budget_tokens", "n/a")))
        print("    runtime=KV%s prefill_chunk=%s APC=%s/%s tokens max_seqs=%s metrics=v%s/%s versions=mlx:%s mlx-vlm:%s" % (
            config.get("kv_bits", "n/a"), config.get("prefill_step_size", "n/a"),
            "on" if config.get("apc_enabled") else "off", config.get("apc_capacity_tokens", "n/a"),
            config.get("max_num_seqs", "n/a"), config.get("metrics_schema_version", "legacy"),
            config.get("instrumentation_revision", "legacy"), config.get("mlx_version", "n/a"),
            config.get("mlx_vlm_version", "n/a")))
    print("    requests=%d ok / %d failed  apparent PP=%.1f  uncached PP=%.1f  TPS=%.1f  cache=%.1f%%  tool-call=%.1f%%" % (
        len(items), failures[key], pp, uncached_pp, tps, cache_pct, tool_rate))
    print("    prompt avg/max=%.0f/%.0f  output avg/max=%.0f/%.0f  reasoning=%d (%.1f%%)  final=%d" % (
        sum(prompts) / len(prompts) if prompts else 0, max(prompts or [0]),
        sum(outputs) / len(outputs) if outputs else 0, max(outputs or [0]),
        reasoning, reason_pct, final))
    print("    latency total p50/p95=%.2f/%.2fs  TTFT p50/p95=%.2f/%.2fs  peak_memory=%.2f GB" % (
        pct(totals, .5), pct(totals, .95), pct(ttfts, .5), pct(ttfts, .95), peak))
    print("    overhead p50/p95=%.2f/%.2fs  decode slowdown p50/p95=%.1f/%.1f%%  reserved headroom min=%d" % (
        pct(overheads, .5), pct(overheads, .95), pct(slowdowns, .5), pct(slowdowns, .95),
        min(reserved_headroom or [0])))
    print("    cache buckets: %s" % (", ".join("%s=%d" % item for item in sorted(cache_buckets.items())) or "none"))
    if warnings:
        print("    warnings: %s" % ", ".join("%s=%d" % item for item in sorted(warnings.items())))
    kinds = [(kind, count) for (failure_key, kind), count in failure_kinds.items() if failure_key == key]
    if kinds:
        print("    failures: %s" % ", ".join("%s=%d" % item for item in sorted(kinds)))

completed_records = [item for items in groups.values() for item in items]
bucket_groups = collections.defaultdict(list)
for item in completed_records:
    cached = num(item.get("cached_prompt_tokens"))
    prompt = num(item.get("prompt_tokens"))
    hit = num(item.get("cache_hit_pct")) if item.get("cache_hit_pct") is not None else (100 * cached / prompt if prompt else 0)
    bucket = item.get("cache_bucket")
    if not bucket:
        bucket = "cold" if cached <= 0 else ("warm_lt40" if hit < 40 else ("warm_40_80" if hit < 80 else "warm_ge80"))
    bucket_groups[bucket].append(item)

print("\nCACHE EFFECTIVENESS")
if not bucket_groups:
    print("  No completed requests.")
for bucket in ("cold", "warm_lt40", "warm_40_80", "warm_ge80", "legacy"):
    items = bucket_groups.get(bucket) or []
    if not items:
        continue
    prompt = sum(num(x.get("prompt_tokens")) for x in items)
    cached = sum(num(x.get("cached_prompt_tokens")) for x in items)
    uncached = sum(max(0, num(x.get("prompt_tokens")) - num(x.get("cached_prompt_tokens"))) for x in items)
    prefill_s = sum(num(x.get("prompt_eval_time_s")) for x in items)
    ttfts = [num(x.get("ttft_s")) for x in items if x.get("ttft_s") is not None]
    totals = [num(x.get("request_elapsed_s")) for x in items]
    print("  %-10s n=%d cache=%.1f%% apparent_PP=%.1f uncached_PP=%.1f TTFT p50/p95=%.2f/%.2fs total p50=%.2fs" % (
        bucket, len(items), 100 * cached / prompt if prompt else 0,
        prompt / prefill_s if prefill_s else 0, uncached / prefill_s if prefill_s else 0,
        pct(ttfts, .5), pct(ttfts, .95), pct(totals, .5)))

print("\nTOP OUTLIERS")
if not completed_records:
    print("  No completed requests.")
else:
    def label(item):
        return "run=%s seq=%s profile=%s prompt=%d cache=%.1f%% output=%d reasoning=%d" % (
            item.get("run_id", "legacy"), item.get("request_sequence", "n/a"),
            item.get("profile", "unknown"), int(num(item.get("prompt_tokens"))),
            num(item.get("cache_hit_pct")), int(num(item.get("generated_tokens"))),
            int(num(item.get("reasoning_tokens"))))
    rankings = (
        ("total", "request_elapsed_s"),
        ("TTFT", "ttft_s"),
        ("reasoning", "reasoning_tokens"),
        ("overhead", "non_compute_overhead_s"),
    )
    for title, field in rankings:
        print("  %s:" % title)
        for item in sorted(completed_records, key=lambda x: num(x.get(field)), reverse=True)[:3]:
            print("    %8.2f  %s" % (num(item.get(field)), label(item)))

print("\nOPENCODE AGENTS")
if not os.path.isfile(db_path):
    print("  Database not found: %s" % db_path)
    raise SystemExit(0)

agents = collections.defaultdict(list)
repeated = collections.Counter()
agent_errors = collections.Counter()
compactions = collections.Counter()
compaction_sessions = set()
db = None
try:
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    for session_id, raw in db.execute("SELECT session_id, data FROM message WHERE time_created >= ?", (int(cutoff * 1000),)):
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        if data.get("role") != "assistant":
            continue
        error = data.get("error") or {}
        if error:
            error_name = error.get("name") or error.get("type") or "unknown"
            agent_errors[(data.get("agent") or "unknown", data.get("modelID") or "n/a", error_name)] += 1
        created = num((data.get("time") or {}).get("created"))
        completed = num((data.get("time") or {}).get("completed"))
        if not completed:
            continue
        tokens = data.get("tokens") or {}
        agents[(data.get("agent") or data.get("mode") or "unknown", data.get("modelID") or "n/a")].append({
            "session": session_id,
            "input": num(tokens.get("input")),
            "output": num(tokens.get("output")),
            "reasoning": num(tokens.get("reasoning")),
            "duration": max(0, (completed - created) / 1000),
            "finish": data.get("finish") or "unknown",
        })
    for session_id, raw in db.execute("SELECT session_id, data FROM part WHERE time_created >= ?", (int(cutoff * 1000),)):
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        if data.get("type") == "compaction":
            compactions[(bool(data.get("auto")), bool(data.get("overflow")))] += 1
            compaction_sessions.add(session_id)
            continue
        if data.get("type") != "tool":
            continue
        state = data.get("state") or {}
        tool = data.get("tool") or "unknown"
        tool_input = state.get("input") or {}
        signature = tool_input.get("command") or tool_input.get("path") or json.dumps(tool_input, sort_keys=True)
        if signature:
            repeated[(session_id, tool, signature)] += 1
finally:
    if db is not None:
        db.close()

if not agents:
    print("  No completed assistant rounds in this time window.")
for (agent, model), items in sorted(agents.items()):
    finishes = collections.Counter(x["finish"] for x in items)
    sessions = len({x["session"] for x in items})
    durations = [x["duration"] for x in items]
    print("  agent=%s  model=%s" % (agent, model))
    print("    rounds=%d  sessions=%d  avg input/output/reasoning=%.0f/%.0f/%.0f  duration p50/p95=%.1f/%.1fs" % (
        len(items), sessions,
        sum(x["input"] for x in items) / len(items),
        sum(x["output"] for x in items) / len(items),
        sum(x["reasoning"] for x in items) / len(items),
        pct(durations, .5), pct(durations, .95)))
    print("    finishes: %s" % ", ".join("%s=%d" % item for item in sorted(finishes.items())))

print("\nOPENCODE RELIABILITY")
total_compactions = sum(compactions.values())
print("  compactions=%d across %d sessions  automatic=%d  overflow=%d" % (
    total_compactions, len(compaction_sessions),
    sum(count for (automatic, _), count in compactions.items() if automatic),
    sum(count for (_, overflow), count in compactions.items() if overflow)))
if not agent_errors:
    print("  assistant errors: none")
else:
    print("  assistant errors:")
    for (agent, model, error_name), count in sorted(agent_errors.items(), key=lambda item: (-item[1], item[0])):
        print("    %dx agent=%s model=%s error=%s" % (count, agent, model, error_name))

loops = [(count, tool, signature) for (_, tool, signature), count in repeated.items() if count >= 2]
print("\nREPEATED TOOL SIGNALS")
if not loops:
    print("  No identical tool inputs repeated within one session.")
else:
    for count, tool, signature in sorted(loops, reverse=True)[:10]:
        compact = " ".join(str(signature).split())
        print("  %dx %s: %s" % (count, tool, compact[:180]))
PY
    ;;
  --help|-h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
