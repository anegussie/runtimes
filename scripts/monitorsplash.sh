#!/usr/bin/env bash
set -euo pipefail

HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-1235}"
STATUS_URL="http://${HOST}:${PORT}/status"
LOG_DIR="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
SNAPSHOTS="$LOG_DIR/splash-status.jsonl"
LATEST_LOG="$LOG_DIR/splash-latest.log"
PERFORMANCE="$LOG_DIR/splash-performance.jsonl"
SUMMARY_INTERVAL="${SPLASH_SUMMARY_INTERVAL:-300}"
SUMMARY_BASELINE='{}'
SUMMARY_TTY="${SPLASH_MONITOR_TTY:-}"
if [[ -z "${SPLASH_MONITOR_TTY+x}" ]]; then
  summary_tty_name="$(ps -o tty= -p "${SPLASH_MONITOR_OWNER_PID:-$PPID}" 2>/dev/null | tr -d ' ' || true)"
  if [[ "$summary_tty_name" =~ ^tty(s)?[0-9]+$ ]]; then
    SUMMARY_TTY="/dev/$summary_tty_name"
  fi
fi

usage() {
  printf '%s\n' 'Usage: monitorsplash.sh [--once | --watch [seconds] | --snapshot | --record [seconds] | --report [hours] | --history [count] | --json | --log]'
  printf '%s\n' '  --watch prints live status; --record samples every interval (default 60s) and logs performance summaries every 300s.'
}

positive_interval() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || { echo 'Interval must be a positive integer.' >&2; exit 2; }
}

fetch_status() {
  curl --max-time 5 -fsS "$STATUS_URL"
}

server_ready() {
  local payload
  payload="$(fetch_status 2>/dev/null)" || return 1
  jq -e '.ready == true' >/dev/null <<< "$payload"
}

print_once() {
  local payload
  payload="$(fetch_status)" || { echo "Splash status unavailable: $STATUS_URL" >&2; return 1; }
  jq -er '
    select(.ready == true and .memory_governor != null and .metrics != null) |
    def gib: . / 1073741824;
    "Splash \(.instance.model)  pid=\(.instance.pid)  ready=\(.ready)  context=\(.maximum_context_tokens)",
    "Requests: completed=\(.requests.completed) failed=\(.requests.failed) pending=\(.transport.pending) waiting_memory=\(.admission.waiting_memory) suspended=\(.admission.suspended)",
    "Average speed: PP=\(.metrics.prefill_tokens_per_second|floor) tok/s (\(.metrics.prefill_input_tokens) tokens)  TPS=\(.metrics.decode_tokens_per_second|floor) tok/s (\(.metrics.decode_output_tokens) tokens)  TTFT p50/p95=\(.metrics.ttft_ms.p50|floor)/\(.metrics.ttft_ms.p95|floor) ms",
    "Draft: accepted=\(.metrics.accepted_draft_tokens)/\(.metrics.drafted_tokens) rate=\((.metrics.draft_acceptance_rate*100)|floor)%  cache_hits=\(.cache.hits)/\(.cache.lookups)",
    "Memory: pressure=\(.memory_pressure) growth_allowed=\(.memory_governor.growth_allowed) host_headroom=\((.memory_governor.host_headroom_bytes|gib)*100|floor/100) GiB denied=\(.memory_governor.denied_reservations) Metal=\(.metal.healthy) failures=\(.metrics.metal_failures) engine_restarts=\(.transport.restarts)",
    "Storage: written=\((.disk.written_bytes|gib)*100|floor/100) GiB read=\((.disk.read_bytes|gib)*100|floor/100) GiB offloads=\(.state.offloads) restores=\(.disk.kv_restores)"
  ' <<< "$payload"
}

log_performance_summary() {
  local current="$1" action summary line timestamp
  action="$(jq -nr --argjson a "$SUMMARY_BASELINE" --argjson b "$current" --argjson seconds "$SUMMARY_INTERVAL" '
    ["pp_tokens","pp_ms","output_tokens","decode_ms"] as $keys |
    if $b.ready != true or $b.status_stale == true or $b.instance == null or
       any($keys[]; . as $key | ($b[$key]|type) != "number") then "skip"
    elif $a.instance != $b.instance or $a.restarts != $b.restarts or
         $b.ts < $a.ts or any($keys[]; . as $key | $b[$key] < $a[$key]) then "reset"
    elif $b.ts-$a.ts >= $seconds then "emit" else "wait" end
  ')" || return 1
  case "$action" in
    reset) SUMMARY_BASELINE="$current"; return 0 ;;
    skip|wait) return 0 ;;
  esac
  summary="$(jq -nc --argjson a "$SUMMARY_BASELINE" --argjson b "$current" '
    def delta($key):
      if ($a[$key]|type) == "number" and ($b[$key]|type) == "number" and $b[$key] >= $a[$key]
      then $b[$key]-$a[$key] else null end;
    def rate($tokens;$ms): if $tokens != null and $ms != null and $ms>0 then 1000*$tokens/$ms else null end;
    {schemaVersion:2,event:"performance_summary",ts:$b.ts,instance:$b.instance,restarts:$b.restarts,
     model:$b.model,build:$b.build,context:$b.context,from_ts:$a.ts,interval_seconds:($b.ts-$a.ts),
     timing_scope:"native_batch_stage_elapsed",interval:{
       prefill_tokens:delta("pp_tokens"),prefill_ms:delta("pp_ms"),
       output_tokens:delta("output_tokens"),decode_ms:delta("decode_ms"),
       pp_tokens_per_second:rate(delta("pp_tokens");delta("pp_ms")),
       decode_tokens_per_second:rate(delta("output_tokens");delta("decode_ms")),
       completed:delta("completed"),failed:delta("failed"),cancelled:delta("cancelled"),
       cached_tokens:delta("cached_tokens")},
     lifetime:{pp_tokens_per_second:rate($b.pp_tokens;$b.pp_ms),
       decode_tokens_per_second:rate($b.output_tokens;$b.decode_ms),completed:$b.completed},
     ttft_p50_ms:$b.ttft_p50_ms,ttft_p95_ms:$b.ttft_p95_ms,
     memory_pressure:$b.memory_pressure,thermal_state:$b.thermal_state,
     status_stale:$b.status_stale}
  ')" || return 1
  timestamp="$(date -r "$(jq -r '.ts' <<< "$summary")" '+%Y-%m-%dT%H:%M:%S%z')" || return 1
  line="$(jq -r --arg timestamp "$timestamp" '
    def rate: if . == null then "idle" else "\((.*10|round)/10) tok/s" end;
    "\($timestamp) ===== [PERF] Performance \(.interval_seconds)s (native): interval average PP=\(.interval.pp_tokens_per_second|rate) TPS=\(.interval.decode_tokens_per_second|rate); engine lifetime average PP=\(.lifetime.pp_tokens_per_second|rate) TPS=\(.lifetime.decode_tokens_per_second|rate); processed=\(.interval.prefill_tokens) generated=\(.interval.output_tokens) cached=\(.interval.cached_tokens // "n/a"); requests=\(.interval.completed // "n/a") failed=\(.interval.failed // "n/a") cancelled=\(.interval.cancelled // "n/a"); memory=\(.memory_pressure) thermal=\(.thermal_state); engine=\(.instance)/restart\(.restarts)"
  ' <<< "$summary")" || return 1
  printf '%s\n' "$summary" >> "$PERFORMANCE" || return 1
  printf '%s\n' "$line" >> "$LATEST_LOG" || return 1
  SUMMARY_BASELINE="$current"
  if [[ "${SPLASH_MONITOR_QUIET:-0}" != "1" ]]; then
    printf '%s\n' "$line"
  elif [[ -n "$SUMMARY_TTY" ]]; then
    # Quiet launcher stdout is redirected to the log. Mirror only this
    # summary to its terminal, without duplicating the file entry.
    printf '%s\n' "$line" 2>/dev/null >> "$SUMMARY_TTY" || true
  fi
}

record_once() {
  local payload probe_seconds swap_snapshot vm_snapshot process_snapshot server_pid process_rows previous='{}'
  if ! payload="$(curl --max-time 5 -fsS -w '\n%{time_total}' "$STATUS_URL")"; then
    mkdir -p "$LOG_DIR"
    jq -cn '{schemaVersion:2,event:"status_sample_error",ts:now}' >> "$LOG_DIR/splash-status-errors.jsonl"
    return 1
  fi
  swap_snapshot="$(sysctl -n vm.swapusage 2>/dev/null || true)"
  vm_snapshot="$(vm_stat 2>/dev/null || true)"
  probe_seconds="${payload##*$'\n'}"
  payload="${payload%$'\n'*}"
  process_snapshot=null
  server_pid="$(jq -r '.instance.pid // empty' <<< "$payload")"
  if [[ "$server_pid" =~ ^[1-9][0-9]*$ ]] && process_rows="$(ps -axo pid=,ppid=,rss= 2>/dev/null)"; then
    process_snapshot="$(awk -v owner="$server_pid" '
      BEGIN { printf "["; separator="" }
      $1 == owner || $2 == owner {
        printf "%s{\"pid\":%d,\"ppid\":%d,\"rss_bytes\":%.0f}", separator,$1,$2,$3*1024; separator=","
      }
      END { print "]" }
    ' <<< "$process_rows")"
  fi
  mkdir -p "$LOG_DIR"
  if [[ -s "$SNAPSHOTS" ]]; then previous="$(tail -n 1 "$SNAPSHOTS")"; fi
  jq -ce --argjson ts "$(date +%s)" --argjson probe_seconds "$probe_seconds" --arg swap "$swap_snapshot" \
    --arg vm "$vm_snapshot" --argjson processes "$process_snapshot" --argjson previous "$previous" '
    def vm_counters:
      ($vm | split("\n") | map(try capture("^(?<key>Pageins|Pageouts|Swapins|Swapouts):[[:space:]]*(?<value>[0-9]+)") catch empty)
       | map({key:(.key|ascii_downcase),value:(.value|tonumber)}) | from_entries) as $counters |
      {page_size_bytes: ((try ($vm | capture("page size of (?<n>[0-9]+)") | .n | tonumber) catch null) // null)} + $counters;
    vm_counters as $vm_now |
    def vm_delta($key):
      ($previous.system_vm[$key] // null) as $old | ($vm_now[$key] // null) as $new |
      if $old != null and $new != null and $new >= $old then $new-$old else null end;
    {schemaVersion:2,event:"status_sample",ready:.ready,system_swap:$swap,ts:$ts,sampled_at_ms:(now*1000),probe_ms:($probe_seconds*1000),
     system_vm:$vm_now,
     system_vm_delta: (if $previous.instance == .instance.id and $previous.ts < $ts
       then {interval_seconds:($ts-$previous.ts),pageins:vm_delta("pageins"),pageouts:vm_delta("pageouts"),swapins:vm_delta("swapins"),swapouts:vm_delta("swapouts")}
       else null end),
     process_memory:{scope:"server_and_direct_children_rss_not_unique_physical_memory",processes:$processes},
     thermal_state:.thermal_state,memory_pressure:.memory_pressure,active_requests:.active_requests,
     admission:.admission,transport:.transport,weights:.weights,
     identity:.identity,memory_plan:.memory_plan,streamed_experts:.streamed_experts,
     memory_governor:.memory_governor,memory_actual:.memory_actual,
     disk:.disk,verify_rows:.verify_rows,prefill_chunk_tokens:.prefill_chunk_tokens,
     memory_current:.memory_actual.current_bytes,memory_peak:.memory_actual.peak_bytes,
     cache_bytes:.cache.bytes,kv:.kv,state:.state,
     telemetry:.telemetry,status_stale:.transport.status_stale,status_age_ms:.transport.status_age_ms,instance:.instance.id,restarts:.transport.restarts,model:.instance.model,
     build:.identity.cache.build_id,context:.maximum_context_tokens,
     completed:.requests.completed,failed:.requests.failed,cancelled:.requests.cancelled,
     waiting:.admission.waiting_memory,suspended:.admission.suspended,
     frontend_waiting:(.transport.frontend_waiting // 0),max_active_requests:(.transport.max_active_requests // 0),
     pp_tokens:.metrics.prefill_input_tokens,pp_ms:.metrics.prefill_wall_ms,
     output_tokens:.metrics.decode_output_tokens,decode_ms:.metrics.decode_wall_ms,
     drafted:.metrics.drafted_tokens,accepted:.metrics.accepted_draft_tokens,
     replay_tokens:.cache.resource_replay_tokens,
     ttft_p50_ms:.metrics.ttft_ms.p50,ttft_p95_ms:.metrics.ttft_ms.p95,
     cache_hits:.cache.hits,cache_lookups:.cache.lookups,
     cached_tokens:.cache.reused_tokens,
     denied:.memory_governor.denied_reservations,growth_allowed:.memory_governor.growth_allowed,
     host_headroom:.memory_governor.host_headroom_bytes,
     metal_failures:.metrics.metal_failures,capacity_failures:.metrics.capacity_failures,
     disk_read:.disk.read_bytes,disk_written:.disk.written_bytes}
  ' <<< "$payload" >> "$SNAPSHOTS" || return 1
  log_performance_summary "$(tail -n 1 "$SNAPSHOTS")"
}

report() {
  local hours="$1" cutoff
  [[ "$hours" =~ ^[1-9][0-9]*$ ]] || { echo 'Hours must be a positive integer.' >&2; exit 2; }
  [[ -s "$SNAPSHOTS" ]] || { echo "No snapshots at $SNAPSHOTS. Run --record 60 for future reports." >&2; exit 1; }
  cutoff="$(($(date +%s) - hours * 3600))"
  jq -sr --argjson cutoff "$cutoff" '
    [.[] | select(.ts >= $cutoff and (.schemaVersion != 2 or .ready == true))] as $rows |
    if ($rows|length) < 2 then "Need at least two snapshots in this period."
    else
      [$rows[]] | group_by([.instance, (.restarts // 0)]) |
      map(select(length >= 2) | . as $run |
        $run[0] as $a | $run[-1] as $b |
        def delta($key): [($b[$key] - $a[$key]),0]|max;
        [
          "Run \($b.instance)  engine_restarts=\($b.restarts // 0)  build=\($b.build)  context=\($b.context)  sampled_interval=\($a.ts)-\($b.ts) (\($b.ts-$a.ts)s)  samples=\($run|length)",
          "Sampled requests: completed=\(delta("completed")) failed=\(delta("failed")) cancelled=\(delta("cancelled"))",
          "Work: prefill=\(delta("pp_tokens")) tokens in \((delta("pp_ms")/1000)|floor)s  decode=\(delta("output_tokens")) tokens in \((delta("decode_ms")/1000)|floor)s",
          "Weighted averages over sampled interval: PP=\(if delta("pp_ms")>0 then (1000*delta("pp_tokens")/delta("pp_ms")*10|floor)/10 else 0 end) tok/s  TPS=\(if delta("decode_ms")>0 then (1000*delta("output_tokens")/delta("decode_ms")*10|floor)/10 else 0 end) tok/s  draft_acceptance=\(if delta("drafted")>0 then (100*delta("accepted")/delta("drafted")*10|floor)/10 else 0 end)%",
          "TTFT latest p50/p95=\(if $b.ttft_p50_ms == null or $b.ttft_p95_ms == null then "n/a" else "\(($b.ttft_p50_ms)|floor)/\(($b.ttft_p95_ms)|floor) ms" end)  replay_tokens=\(if $a.replay_tokens == null or $b.replay_tokens == null then "n/a" else delta("replay_tokens") end)",
          "Pressure: denied_reservations=\(delta("denied"))  latest_growth_allowed=\($b.growth_allowed)  latest_host_headroom_MiB=\(($b.host_headroom/1048576)|floor)",
          "SSD prefix cache: read_MiB=\((delta("disk_read")/1048576)|floor) written_MiB=\((delta("disk_written")/1048576)|floor)",
          "SSD expert reads: prefill_MiB=\(if $a.streamed_experts.prefill.read_bytes != null and $b.streamed_experts.prefill.read_bytes != null then (($b.streamed_experts.prefill.read_bytes-$a.streamed_experts.prefill.read_bytes)/1048576|floor) else "n/a" end) decode_MiB=\(if $a.streamed_experts.decode.read_bytes != null and $b.streamed_experts.decode.read_bytes != null then (($b.streamed_experts.decode.read_bytes-$a.streamed_experts.decode.read_bytes)/1048576|floor) else "n/a" end)",
          "System swap activity: swapins=\(if $a.system_vm.swapins != null and $b.system_vm.swapins >= $a.system_vm.swapins then $b.system_vm.swapins-$a.system_vm.swapins else "n/a" end) swapouts=\(if $a.system_vm.swapouts != null and $b.system_vm.swapouts >= $a.system_vm.swapouts then $b.system_vm.swapouts-$a.system_vm.swapouts else "n/a" end) (machine-wide counters)"
        ] | join("\n")
      ) | if length == 0 then "No engine run has two snapshots in this period." else .[] end
    end
  ' "$SNAPSHOTS"
}

positive_interval "$SUMMARY_INTERVAL"
mode="${1:---once}"
case "$mode" in
  --once|--status) print_once ;;
  --json) fetch_status; echo ;;
  --snapshot) record_once; echo "Recorded one snapshot in $SNAPSHOTS" ;;
  --watch|--record)
    interval="${2:-$(if [[ "$mode" == --record ]]; then echo 60; else echo 2; fi)}"
    positive_interval "$interval"
    if [[ "$mode" == --record ]]; then
      # Establish a ready-state baseline before measuring counter deltas.
      until server_ready; do record_once >/dev/null 2>&1 || true; sleep 2; done
      record_once || {
        printf '[%s] Initial snapshot failed: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$STATUS_URL" >&2
        exit 1
      }
      while :; do
        if [[ -n "${SPLASH_MONITOR_OWNER_PID:-}" ]] && ! kill -0 "$SPLASH_MONITOR_OWNER_PID" 2>/dev/null; then exit 0; fi
        sleep "$interval"
        record_once || printf '[%s] Snapshot failed: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$STATUS_URL" >&2
      done
    fi
    while :; do
      [[ -t 1 && -n "${TERM:-}" ]] && clear || true
      date '+Splash monitor %Y-%m-%d %H:%M:%S'
      print_once || true
      sleep "$interval"
    done ;;
  --report) report "${2:-24}" ;;
  --history)
    count="${2:-10}"
    positive_interval "$count"
    [[ -e "$LATEST_LOG" ]] || { echo "No Splash log: $LATEST_LOG" >&2; exit 1; }
    rg 'Done ·|Error ·|Average \(engine lifetime|Interval [0-9]+s:|Performance [0-9]+s' "$LATEST_LOG" | tail -n "$count" || true ;;
  --log) [[ -e "$LATEST_LOG" ]] || { echo "No Splash log: $LATEST_LOG" >&2; exit 1; }; exec tail -F "$LATEST_LOG" ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
