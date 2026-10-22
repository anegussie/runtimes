#!/usr/bin/env bash
set -euo pipefail

HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-1235}"
STATUS_URL="http://${HOST}:${PORT}/status"
LOG_DIR="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
SNAPSHOTS="$LOG_DIR/splash-status.jsonl"
LATEST_LOG="$LOG_DIR/splash-latest.log"

usage() {
  printf '%s\n' 'Usage: monitorsplash.sh [--once | --watch [seconds] | --snapshot | --record [seconds] | --report [hours] | --history [count] | --json | --log]'
  printf '%s\n' '  --watch prints live status without writing to disk; --record stores one compact snapshot per interval (default 60s).'
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

record_once() {
  local payload probe_seconds swap_snapshot previous='{}'
  if ! payload="$(curl --max-time 5 -fsS -w '\n%{time_total}' "$STATUS_URL")"; then
    mkdir -p "$LOG_DIR"
    jq -cn '{schemaVersion:2,event:"status_sample_error",ts:now}' >> "$LOG_DIR/splash-status-errors.jsonl"
    return 1
  fi
  swap_snapshot="$(sysctl -n vm.swapusage 2>/dev/null || true)"
  probe_seconds="${payload##*$'\n'}"
  payload="${payload%$'\n'*}"
  mkdir -p "$LOG_DIR"
  if [[ -s "$SNAPSHOTS" ]]; then previous="$(tail -n 1 "$SNAPSHOTS")"; fi
  jq -ce --argjson ts "$(date +%s)" --argjson probe_seconds "$probe_seconds" --arg swap "$swap_snapshot" '
    {schemaVersion:2,event:"status_sample",ready:.ready,system_swap:$swap,ts:$ts,sampled_at_ms:(now*1000),probe_ms:($probe_seconds*1000),
     thermal_state:.thermal_state,memory_pressure:.memory_pressure,active_requests:.active_requests,
     admission:.admission,transport:.transport,weights:.weights,
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
     denied:.memory_governor.denied_reservations,growth_allowed:.memory_governor.growth_allowed,
     host_headroom:.memory_governor.host_headroom_bytes,
     metal_failures:.metrics.metal_failures,capacity_failures:.metrics.capacity_failures,
     disk_read:.disk.read_bytes,disk_written:.disk.written_bytes}
  ' <<< "$payload" >> "$SNAPSHOTS" || return 1
  [[ "${SPLASH_MONITOR_QUIET:-0}" == "1" ]] && return 0
  jq -er --arg timestamp "$(date '+%Y-%m-%d %H:%M:%S %Z')" '
    select(.ready == true and .metrics != null) |
    "\($timestamp) engine=\(.instance.id)/restart\(.transport.restarts) Average (engine lifetime, native batch work): PP=\((.metrics.prefill_tokens_per_second*10|floor)/10) tok/s over \(.metrics.prefill_input_tokens) tokens; TPS=\((.metrics.decode_tokens_per_second*10|floor)/10) tok/s over \(.metrics.decode_output_tokens) tokens; requests=\(.requests.completed) completed/\(.requests.failed) failed; draft acceptance=\((.metrics.draft_acceptance_rate*1000|floor)/10)%; waiting native/frontend=\(.admission.waiting_memory)/\(.transport.frontend_waiting // 0); replay_tokens=\(.cache.resource_replay_tokens); SSD written=\((.disk.written_bytes/1073741824*100|floor)/100) GiB"
  ' <<< "$payload" | {
    if [[ -w /dev/tty ]]; then
      tee -a "$LATEST_LOG" /dev/tty >/dev/null
    else
      tee -a "$LATEST_LOG" >/dev/null
    fi
  } || return 1
  local current
  current="$(tail -n 1 "$SNAPSHOTS")"
  jq -nr --argjson a "$previous" --argjson b "$current" --arg timestamp "$(date '+%Y-%m-%d %H:%M:%S %Z')" '
    if $a.instance == $b.instance and $a.restarts == $b.restarts and ($b.ts > ($a.ts // 0)) then
      def delta($key): [($b[$key] - $a[$key]),0]|max;
      "\($timestamp) Interval \($b.ts-$a.ts)s: native PP=\(if delta("pp_ms")>0 then (1000*delta("pp_tokens")/delta("pp_ms")*10|floor)/10 else 0 end) tok/s; native TPS=\(if delta("decode_ms")>0 then (1000*delta("output_tokens")/delta("decode_ms")*10|floor)/10 else 0 end) tok/s; prefill=\((delta("pp_ms")/1000*10|floor)/10)s decode=\((delta("decode_ms")/1000*10|floor)/10)s; completed=\(delta("completed")); replay_tokens=\(delta("replay_tokens")); SSD written=\((delta("disk_written")/1073741824*100|floor)/100) GiB"
    else empty end
  ' | {
    if [[ -w /dev/tty ]]; then tee -a "$LATEST_LOG" /dev/tty >/dev/null
    else tee -a "$LATEST_LOG" >/dev/null; fi
  }
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
          "SSD: read_MiB=\((delta("disk_read")/1048576)|floor) written_MiB=\((delta("disk_written")/1048576)|floor)"
        ] | join("\n")
      ) | if length == 0 then "No engine run has two snapshots in this period." else .[] end
    end
  ' "$SNAPSHOTS"
}

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
    rg 'Done ·|Error ·|Average \(engine lifetime|Interval [0-9]+s:' "$LATEST_LOG" | tail -n "$count" || true ;;
  --log) [[ -e "$LATEST_LOG" ]] || { echo "No Splash log: $LATEST_LOG" >&2; exit 1; }; exec tail -F "$LATEST_LOG" ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
