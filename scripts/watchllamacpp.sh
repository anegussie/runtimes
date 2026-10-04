#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${RUNTIME_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export RUNTIME_ROOT

LAUNCHER="${RUNTIME_ROOT}/startllamacpp.sh"
MODEL_CHOICE="${1:-1}"
MODEL_LABEL="model choice ${MODEL_CHOICE}"
PORT="${LLAMA_PORT:-1235}"
HOST="${LLAMA_HOST:-127.0.0.1}"
MAX_RSS_MB="${MAX_RSS_MB:-12000}"
MAX_FOOTPRINT_MB="${MAX_FOOTPRINT_MB:-8000}"
CHECK_INTERVAL="${CHECK_INTERVAL:-20}"
METRICS_LOG_INTERVAL="${METRICS_LOG_INTERVAL:-120}"
MIN_FREE_PERCENT="${MIN_FREE_PERCENT:-12}"
MAX_SWAP_MB="${MAX_SWAP_MB:-512}"
MAX_PROTECTED_RELAUNCHES="${MAX_PROTECTED_RELAUNCHES:-3}"
MAX_UNPROTECTED_RELAUNCHES="${MAX_UNPROTECTED_RELAUNCHES:-2}"
if ! [[ "$MAX_UNPROTECTED_RELAUNCHES" =~ ^[0-9]+$ ]]; then
  echo "MAX_UNPROTECTED_RELAUNCHES must be a non-negative integer." >&2
  exit 2
fi
MTP_FALLBACK_RELAUNCHES="${MTP_FALLBACK_RELAUNCHES:-2}"
STARTUP_GRACE="${STARTUP_GRACE:-60}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-180}"
API_PROBE_INTERVAL="${API_PROBE_INTERVAL:-2}"
REQUEST_DRAIN_SECONDS="${REQUEST_DRAIN_SECONDS:-5}"
NO_SWAP_GUARD="${NO_SWAP_GUARD:-1}"
# Local inference is terminal-controlled only. Ignore any inherited launchd
# flag so a shell environment cannot silently switch process-group behavior.
LAUNCHD_MANAGED=0
NO_SWAP_MIN_FREE_PERCENT="${NO_SWAP_MIN_FREE_PERCENT:-12}"
PRESTART_MIN_FREE_PERCENT="${PRESTART_MIN_FREE_PERCENT:-35}"
MAX_SWAPOUT_GROWTH_MB="${MAX_SWAPOUT_GROWTH_MB:-128}"
NO_SWAP_CHECK_INTERVAL="${NO_SWAP_CHECK_INTERVAL:-5}"
SWAP_PRESSURE_FREE_PERCENT="${SWAP_PRESSURE_FREE_PERCENT:-20}"
CRITICAL_FREE_PERCENT="${CRITICAL_FREE_PERCENT:-10}"
PRESSURE_CONFIRMATIONS="${PRESSURE_CONFIRMATIONS:-2}"
RECOVERY_FREE_PERCENT="${RECOVERY_FREE_PERCENT:-$PRESTART_MIN_FREE_PERCENT}"
RECOVERY_STABLE_SECONDS="${RECOVERY_STABLE_SECONDS:-30}"
RECOVERY_CHECK_INTERVAL="${RECOVERY_CHECK_INTERVAL:-5}"
PROTECTED_RESTART_RESET_SECONDS="${PROTECTED_RESTART_RESET_SECONDS:-3600}"
STRICT_SWAP=0
protected_relaunches=0
unprotected_relaunches=0
WATCHDOG_LOG_DIR="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
WATCHDOG_LOG="$WATCHDOG_LOG_DIR/watchdog.log"
WATCHDOG_PID_FILE="$WATCHDOG_LOG_DIR/watchdog-${PORT}.pid"
mkdir -p "$WATCHDOG_LOG_DIR"

# Prevent an unattended watchdog from growing one log forever.
if [[ -f "$WATCHDOG_LOG" ]]; then
  watchdog_log_bytes="$(stat -f%z "$WATCHDOG_LOG" 2>/dev/null || echo 0)"
  if [[ "$watchdog_log_bytes" =~ ^[0-9]+$ ]] && (( watchdog_log_bytes >= 10 * 1024 * 1024 )); then
    mv "$WATCHDOG_LOG" "$WATCHDOG_LOG_DIR/watchdog-$(date '+%Y%m%d-%H%M%S').log"
  fi
fi

log_watchdog_event() {
  local message="$1"
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S%z')"
  printf '%s model=%s pid=%s %s\n' "$timestamp" "$MODEL_LABEL" "${server_pid:-?}" "$message" >> "$WATCHDOG_LOG"
  echo "Watchdog: $message"
}

terminate_server() {
  local reason="$1"
  [[ -n "${server_pid:-}" ]] || return 0
  log_watchdog_event "terminating server reason=${reason} drain_seconds=${REQUEST_DRAIN_SECONDS}"
  kill -TERM "$server_pid" 2>/dev/null || true
  local deadline now
  deadline=$(( $(date +%s) + REQUEST_DRAIN_SECONDS ))
  while kill -0 "$server_pid" 2>/dev/null; do
    now="$(date +%s)"
    (( now >= deadline )) && break
    sleep 1
  done
  if kill -0 "$server_pid" 2>/dev/null; then
    log_watchdog_event "forcing server termination after drain timeout reason=${reason}"
    kill -KILL "$server_pid" 2>/dev/null || true
  fi
}

# Copy every completed Bonsai timing block into the watchdog log.  Keep the
# cursor at the last complete block so a partially written block is retried.
log_new_bonsai_performance() {
  local log_path="$WATCHDOG_LOG_DIR/bonsai-27b-latest.log"
  local line_number=""
  local task_id=""
  local pp_tokens=""
  local pp_ms=""
  local pp_tps=""
  local decode_tokens=""
  local decode_ms=""
  local decode_tps=""
  local total_tokens=""
  local total_ms=""
  local timestamp=""
  local summary=""
  [[ -r "$log_path" ]] || return 0
  while IFS='|' read -r line_number task_id pp_tokens pp_ms pp_tps decode_tokens decode_ms decode_tps total_tokens total_ms; do
    [[ "$line_number" =~ ^[0-9]+$ ]] || continue
    timestamp="$(date '+%Y-%m-%d %H:%M:%S%z')"
    summary="performance task_id=${task_id} pp_tokens=${pp_tokens} pp_ms=${pp_ms} pp_tps=${pp_tps} decode_tokens=${decode_tokens} decode_ms=${decode_ms} decode_tps=${decode_tps} total_tokens=${total_tokens} total_ms=${total_ms}"
    printf '%s model=%s pid=%s %s\n' "$timestamp" "$MODEL_LABEL" "$server_pid" "$summary" >> "$WATCHDOG_LOG"
    echo "Bonsai performance: ${summary#performance }"
    bonsai_last_performance_line="$line_number"
  done < <(awk -v start="${bonsai_last_performance_line:-0}" '
    NR <= start { next }
    /prompt eval time =/ {
      task = $0; sub(/^.*task /, "", task); split(task, id, " "); task_id = id[1]
      value = $0; sub(/^.*prompt eval time = */, "", value); split(value, fields, " ")
      pp_ms = fields[1]; pp_tokens = fields[4]
      rate = $0; sub(/^.*token, */, "", rate); split(rate, fields, " "); pp_tps = fields[1]
      have_pp = 1
    }
    /        eval time =/ {
      value = $0; sub(/^.*eval time = */, "", value); split(value, fields, " ")
      decode_ms = fields[1]; decode_tokens = fields[4]
      rate = $0; sub(/^.*token, */, "", rate); split(rate, fields, " "); decode_tps = fields[1]
      have_decode = 1
    }
    /       total time =/ {
      value = $0; sub(/^.*total time = */, "", value); split(value, fields, " ")
      if (have_pp && have_decode && pp_tokens ~ /^[0-9]+$/ && decode_tokens ~ /^[0-9]+$/ &&
          pp_tps ~ /^[0-9]+([.][0-9]+)?$/ && decode_tps ~ /^[0-9]+([.][0-9]+)?$/) {
        printf "%d|%s|%s|%.2f|%s|%s|%.2f|%s|%s|%.2f\n", NR, task_id,
          pp_tokens, pp_ms, pp_tps,
          decode_tokens, decode_ms, decode_tps,
          fields[4], fields[1]
      }
      have_pp = 0; have_decode = 0
    }
  ' "$log_path")
}

vm_stat_value() {
  local key="$1"
  local snapshot="$2"
  case "$key" in
    Swapins|Swapouts|Pageouts)
      printf '%s\n' "$snapshot" | awk -v key="$key" '$1 == key ":" {gsub("\\.", "", $2); print $2; exit}'
      ;;
    "Pages wired down"|"Pages active"|"Pages inactive"|"Pages purgeable")
      printf '%s\n' "$snapshot" | awk -v key="$key" 'index($0, key ":") == 1 {gsub("\\.", "", $NF); print $NF; exit}'
      ;;
    "Pages occupied by compressor")
      printf '%s\n' "$snapshot" | awk '$1 == "Pages" && $2 == "occupied" && $3 == "by" && $4 == "compressor:" {gsub("\\.", "", $5); print $5; exit}'
      ;;
  esac
}

memory_free_percent() {
  memory_pressure -Q 2>/dev/null |
    awk -F: '/free percentage/ {gsub(/[^0-9]/, "", $2); print $2; exit}'
}

vm_page_size_bytes() {
  vm_stat 2>/dev/null |
    awk 'NR == 1 {for (i = 1; i <= NF; i++) if ($i == "of") {gsub(/[^0-9]/, "", $(i+1)); print $(i+1); exit}}'
}

case "$MODEL_CHOICE" in
  1) MODEL_LABEL="Qwen3.5 9B planner" ;;
  2) MODEL_LABEL="Gemma 4 12B" ;;
  3) MODEL_LABEL="LFM 2.5 8B" ;;
  4) MODEL_LABEL="Ternary Bonsai 2 27B GGUF" ;;
  5) MODEL_LABEL="Qwen3.5 9B MTP 16K" ;;
  6) MODEL_LABEL="Qwen3.5 9B speed" ;;
  7) MODEL_LABEL="Qwen3.5 9B MTP 32K" ;;
  10)
    MODEL_LABEL="Qwen3.5 9B MLX MTP reasoning"
    # MLX shares unified memory with macOS.  Stop earlier than the generic
    # 9B limits so long prompts cannot drive the system into swap pressure.
    MAX_FOOTPRINT_MB="${MAX_FOOTPRINT_MB_MLX_MTP:-9500}"
    MAX_RSS_MB="${MAX_RSS_MB_MLX_MTP:-10000}"
    MIN_FREE_PERCENT="${MIN_FREE_PERCENT_MLX_MTP:-15}"
    CRITICAL_FREE_PERCENT="${CRITICAL_FREE_PERCENT_MLX_MTP:-12}"
    PRESTART_MIN_FREE_PERCENT="${PRESTART_MIN_FREE_PERCENT_MLX_MTP:-40}"
    RECOVERY_FREE_PERCENT="${RECOVERY_FREE_PERCENT_MLX_MTP:-45}"
    ;;
  *)
    echo "Invalid model choice: $MODEL_CHOICE (expected 1-7 or 10)." >&2
    exit 2
    ;;
esac

# Option 4 uses Prism's custom llama.cpp fork.  Fail closed before entering
# the relaunch loop when that runtime has not been built; a missing binary is
# a permanent setup error, not a memory-pressure event.
if [[ "$MODEL_CHOICE" == "4" ]]; then
  PRISM_LLAMA_SERVER="${PRISM_LLAMA_SERVER:-$HOME/prism-llama.cpp/build/bin/llama-server}"
  if [[ ! -x "$PRISM_LLAMA_SERVER" ]]; then
    echo "Prism llama-server is missing or not executable: $PRISM_LLAMA_SERVER" >&2
    echo "Build the Prism fork before selecting option 4; watchdog will not relaunch this configuration." >&2
    exit 1
  fi
fi

maybe_fallback_mtp_profile() {
  if [[ "$MODEL_CHOICE" == "7" ]] &&
     (( MTP_FALLBACK_RELAUNCHES > 0 && protected_relaunches >= MTP_FALLBACK_RELAUNCHES )); then
    log_watchdog_event "falling back from the 32K MTP profile to the 16K MTP profile after ${protected_relaunches} protected restarts"
    MODEL_CHOICE=5
    MODEL_LABEL="Qwen3.5 9B MTP 16K"
    protected_relaunches=0
    echo "Watchdog: future launches will use the 16K MTP fallback profile."
    return 0
  fi
  return 1
}

# The 27B GGUF Q1 model uses a larger unified-memory footprint during
# prefill. Keep free-memory and critical-pressure guards active, but do not
# mistake its normal ~7 GB working footprint for a leak.
if [[ "$MODEL_CHOICE" == "4" ]]; then
  MAX_RSS_MB="${MAX_RSS_MB_27B:-11000}"
  MAX_FOOTPRINT_MB="${MAX_FOOTPRINT_MB_27B:-9000}"
  MIN_FREE_PERCENT="${MIN_FREE_PERCENT_27B:-10}"
  MAX_SWAP_MB="${MAX_SWAP_MB_27B:-128}"
  STARTUP_GRACE="${STARTUP_GRACE_27B:-30}"
  CHECK_INTERVAL="${CHECK_INTERVAL_27B:-5}"
  STRICT_SWAP=1
fi

# The MTP 9B profile is used interactively and should stop before sustained
# swapping can put unnecessary pressure on the SSD. Protected relaunches are
# bounded so persistent pressure eventually stops the watchdog.
if [[ "$MODEL_CHOICE" == "5" || "$MODEL_CHOICE" == "7" ]]; then
  MIN_FREE_PERCENT="${MIN_FREE_PERCENT_9B_MTP:-10}"
  MAX_SWAP_MB="${MAX_SWAP_MB_9B_MTP:-700}"
  STRICT_SWAP=1
fi

server_pid=""

wait_for_requests_idle() {
  local timeout_seconds="${GRACEFUL_DRAIN_SECONDS:-120}"
  local deadline now active_slots
  [[ "$MODEL_CHOICE" == "4" ]] || return 0
  if ! command -v jq >/dev/null 2>&1; then
    log_watchdog_event "graceful drain skipped reason=jq-unavailable"
    return 0
  fi
  if ! curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    log_watchdog_event "graceful drain skipped reason=api-not-ready"
    return 0
  fi
  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      return 0
    fi
    active_slots="$(curl -fsS --max-time 3 "http://${HOST}:${PORT}/slots" 2>/dev/null | jq '[.[] | select(.is_processing == true)] | length' 2>/dev/null || true)"
    if [[ "$active_slots" =~ ^[0-9]+$ ]] && (( active_slots == 0 )); then
      log_watchdog_event "graceful drain complete active_slots=0"
      return 0
    fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      log_watchdog_event "graceful drain timeout timeout_seconds=${timeout_seconds} active_slots=${active_slots:-unknown}"
      return 1
    fi
    sleep 2
  done
}

cleanup() {
  if [[ -n "${server_pid}" ]] && kill -0 "$server_pid" 2>/dev/null; then
    wait_for_requests_idle || true
    echo "Stopping llama-server (PID ${server_pid})..."
    kill -TERM "$server_pid" 2>/dev/null || true
    local shutdown_deadline
    shutdown_deadline=$(( $(date +%s) + 15 ))
    while kill -0 "$server_pid" 2>/dev/null; do
      (( $(date +%s) >= shutdown_deadline )) && break
      sleep 1
    done
    if kill -0 "$server_pid" 2>/dev/null; then
      log_watchdog_event "forcing server termination after shutdown grace timeout_seconds=15"
      kill -KILL "$server_pid" 2>/dev/null || true
    fi
    wait "$server_pid" 2>/dev/null || true
    if [[ "$MODEL_CHOICE" == "4" && "${api_ready:-0}" == "1" ]]; then
      log_new_bonsai_performance
    fi
  fi
  server_pid=""
  if [[ -f "$WATCHDOG_PID_FILE" ]] && [[ "$(< "$WATCHDOG_PID_FILE")" == "$$" ]]; then
    rm -f "$WATCHDOG_PID_FILE"
  fi
}

handle_shutdown() {
  cleanup
  exit 0
}

wait_for_memory_recovery() {
  local stable_seconds=0
  local previous_swapouts=""
  local recovery_free=""
  local recovery_vm=""
  local recovery_swapouts=""

  echo "Watchdog: waiting for memory recovery before restarting $MODEL_LABEL..."
  while :; do
    recovery_free="$(memory_free_percent || true)"
    recovery_vm="$(vm_stat 2>/dev/null || true)"
    recovery_swapouts="$(vm_stat_value Swapouts "$recovery_vm" || true)"
    [[ "$recovery_swapouts" =~ ^[0-9]+$ ]] || recovery_swapouts=""

    if [[ "$recovery_free" =~ ^[0-9]+$ ]] && (( recovery_free >= RECOVERY_FREE_PERCENT )) &&
       [[ -n "$previous_swapouts" && "$recovery_swapouts" == "$previous_swapouts" ]]; then
      stable_seconds=$((stable_seconds + RECOVERY_CHECK_INTERVAL))
    else
      stable_seconds=0
    fi

    if (( stable_seconds >= RECOVERY_STABLE_SECONDS )); then
      echo "Watchdog: memory recovered (${recovery_free:-?}% free, swap-outs stable for ${stable_seconds}s); restarting $MODEL_LABEL."
      return 0
    fi

    previous_swapouts="$recovery_swapouts"
    sleep "$RECOVERY_CHECK_INTERVAL"
  done
}

trap handle_shutdown INT TERM
trap cleanup EXIT

if [[ -f "$WATCHDOG_PID_FILE" ]]; then
  existing_watchdog_pid="$(< "$WATCHDOG_PID_FILE")"
  if [[ "$existing_watchdog_pid" =~ ^[0-9]+$ ]] &&
     ps -o command= -p "$existing_watchdog_pid" 2>/dev/null | grep -Fq "$RUNTIME_ROOT/scripts/watchllamacpp.sh"; then
    echo "A watchdog is already active for port ${PORT} (PID ${existing_watchdog_pid})." >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "$WATCHDOG_PID_FILE"

if [[ ! -x "$LAUNCHER" ]]; then
  echo "Launcher is missing or not executable: $LAUNCHER" >&2
  exit 1
fi

# MLX profiles perform their own dependency checks and exit immediately when
# the virtualenv is missing.  Fail before entering the restart loop so a
# configuration error cannot be mistaken for a crashed server.
if [[ "$MODEL_CHOICE" == "8" || "$MODEL_CHOICE" == "10" ]]; then
  mlx_python="${MLX_VLM_PYTHON:-$HOME/mlx-project/.venv/bin/python3}"
  if [[ ! -x "$mlx_python" ]]; then
    echo "MLX model choice $MODEL_CHOICE is unavailable: Python runtime is missing or not executable at $mlx_python" >&2
    echo "Set MLX_LM_PYTHON or MLX_VLM_PYTHON to a valid interpreter, then retry." >&2
    exit 1
  fi
fi

if (( NO_SWAP_GUARD == 1 )); then
  prestart_free_percent="$(memory_free_percent || true)"
  if [[ "$prestart_free_percent" =~ ^[0-9]+$ ]] && (( prestart_free_percent < PRESTART_MIN_FREE_PERCENT )); then
    echo "No-swap guard: delaying $MODEL_LABEL with only ${prestart_free_percent}% free memory (minimum ${PRESTART_MIN_FREE_PERCENT}%)." >&2
    wait_for_memory_recovery
  fi
  if (( CHECK_INTERVAL > NO_SWAP_CHECK_INTERVAL )); then
    CHECK_INTERVAL="$NO_SWAP_CHECK_INTERVAL"
  fi
  if (( MIN_FREE_PERCENT < NO_SWAP_MIN_FREE_PERCENT )); then
    MIN_FREE_PERCENT="$NO_SWAP_MIN_FREE_PERCENT"
  fi
  STRICT_SWAP=1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use; refusing to start a duplicate llama-server." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

page_size_bytes="$(vm_page_size_bytes || true)"
[[ "$page_size_bytes" =~ ^[0-9]+$ ]] || page_size_bytes=16384
echo "Watchdog active: model choice ${MODEL_CHOICE}, footprint limit ${MAX_FOOTPRINT_MB} MB, RSS limit ${MAX_RSS_MB} MB, free-memory floor ${MIN_FREE_PERCENT}%, critical floor ${CRITICAL_FREE_PERCENT}%, swap-pressure threshold ${MAX_SWAPOUT_GROWTH_MB} MB/${CHECK_INTERVAL}s at <=${SWAP_PRESSURE_FREE_PERCENT}% free (${PRESSURE_CONFIRMATIONS} confirmations), no-swap guard ${NO_SWAP_GUARD}, protected relaunch limit ${MAX_PROTECTED_RELAUNCHES}, ordinary relaunch limit ${MAX_UNPROTECTED_RELAUNCHES}, startup grace ${STARTUP_GRACE}s"

while :; do
  vm_before="$(vm_stat 2>/dev/null || true)"
  swapouts_before="$(vm_stat_value Swapouts "$vm_before" || true)"
  [[ "$swapouts_before" =~ ^[0-9]+$ ]] || swapouts_before=0
  swap_before="$(sysctl -n vm.swapusage 2>/dev/null | awk '{print $6}' | sed 's/[^0-9.].*$//' || true)"
  swap_before_mb="${swap_before%.*}"
  [[ "$swap_before_mb" =~ ^[0-9]+$ ]] || swap_before_mb=0
  # Keep the watchdog and server attached to this terminal. Ctrl-C reaches
  # the watchdog, which then terminates the child cleanly.
  set -m
  "$LAUNCHER" --direct "$MODEL_CHOICE" &
  server_pid=$!
  set +m
  started_at="$(date +%s)"
  startup_deadline=$((started_at + STARTUP_TIMEOUT))
  next_api_probe=0
  api_ready=0
  next_metrics_log=0
  bonsai_last_performance_line=0
  swapouts_previous="$swapouts_before"
  pressure_hits=0
  echo "Started inference server with PID ${server_pid}"

  restart_requested=0
  restart_needs_recovery=0
  while kill -0 "$server_pid" 2>/dev/null; do
    rss_kb="$(ps -o rss= -p "$server_pid" | tr -d ' ' || true)"
    footprint_mb="$(footprint -p "$server_pid" 2>/dev/null | awk '/Footprint: [0-9]+ MB/ {for (i=1; i<=NF; i++) if ($i == "Footprint:") {print $(i+1); exit}}' || true)"
    port_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 | tr -d ' ' || true)"
    free_percent="$(memory_pressure -Q 2>/dev/null | awk -F: '/free percentage/ {gsub(/[^0-9]/, "", $2); print $2; exit}' || true)"
    swap_used="$(sysctl -n vm.swapusage 2>/dev/null | awk '{print $6}' | sed 's/[^0-9.].*$//' || true)"
    swap_mb="${swap_used%.*}"
    vm_snapshot="$(vm_stat 2>/dev/null || true)"
    swapouts_now="$(vm_stat_value Swapouts "$vm_snapshot" || true)"
    [[ "$swapouts_now" =~ ^[0-9]+$ ]] || swapouts_now="$swapouts_previous"
    swapout_delta_pages=$((swapouts_now - swapouts_previous))
    (( swapout_delta_pages >= 0 )) || swapout_delta_pages=0
    swapout_interval_mb=$((swapout_delta_pages * page_size_bytes / 1024 / 1024))
    swapouts_previous="$swapouts_now"
    now="$(date +%s)"
    elapsed=$((now - started_at))
    now_epoch="$(date +%s)"
    if (( now_epoch >= next_api_probe && api_ready == 0 )); then
      if curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
        api_ready=1
        log_watchdog_event "api ready health=ok startup_seconds=${elapsed}"
      else
        next_api_probe=$((now_epoch + API_PROBE_INTERVAL))
      fi
    fi
    if (( api_ready == 0 && now_epoch >= startup_deadline )); then
      log_watchdog_event "startup timeout health probe failed timeout_seconds=${STARTUP_TIMEOUT} port_pid=${port_pid:-?}"
      terminate_server "startup-timeout"
      echo "Watchdog: startup failed; inspect ${WATCHDOG_LOG} and the model run log." >&2
      exit 1
    fi
    if (( api_ready == 0 || elapsed < STARTUP_GRACE )); then
      sample_phase="starting"
    else
      sample_phase="ready"
    fi
    if (( protected_relaunches > 0 && elapsed >= PROTECTED_RESTART_RESET_SECONDS )); then
      protected_relaunches=0
      log_watchdog_event "protected restart counter reset after ${elapsed}s stable runtime"
    fi
    if (( now >= next_metrics_log )); then
      cpu_percent="$(ps -o %cpu= -p "$server_pid" | tr -d ' ' || true)"
      swapins_now="$(vm_stat_value Swapins "$vm_snapshot" || true)"
      pageouts_now="$(vm_stat_value Pageouts "$vm_snapshot" || true)"
      compressor_pages="$(vm_stat_value 'Pages occupied by compressor' "$vm_snapshot" || true)"
      wired_pages="$(vm_stat_value 'Pages wired down' "$vm_snapshot" || true)"
      [[ "$swapins_now" =~ ^[0-9]+$ ]] || swapins_now=0
      [[ "$swapouts_now" =~ ^[0-9]+$ ]] || swapouts_now=0
      [[ "$pageouts_now" =~ ^[0-9]+$ ]] || pageouts_now=0
      [[ "$compressor_pages" =~ ^[0-9]+$ ]] || compressor_pages=0
      [[ "$wired_pages" =~ ^[0-9]+$ ]] || wired_pages=0
      compressor_mb=$((compressor_pages * page_size_bytes / 1024 / 1024))
      wired_mb=$((wired_pages * page_size_bytes / 1024 / 1024))
      metrics="metrics phase=${sample_phase} server_pid=${server_pid} port_pid=${port_pid:-?} rss_kb=${rss_kb:-?} footprint_mb=${footprint_mb:-?} cpu_percent=${cpu_percent:-?} free_percent=${free_percent:-?} swap_mb=${swap_mb:-?} swapins_pages=${swapins_now} swapouts_pages=${swapouts_now} swapout_interval_mb=${swapout_interval_mb} pressure_hits=${pressure_hits} pageouts_pages=${pageouts_now} compressor_mb=${compressor_mb} wired_mb=${wired_mb}"
      timestamp="$(date '+%Y-%m-%d %H:%M:%S%z')"
      printf '%s model=%s pid=%s %s\n' "$timestamp" "$MODEL_LABEL" "$server_pid" "$metrics" >> "$WATCHDOG_LOG"
      if [[ "$MODEL_CHOICE" == "4" && "$api_ready" == "1" ]]; then
        log_new_bonsai_performance
      fi
      if (( elapsed >= STARTUP_GRACE )) && [[ "$rss_kb" =~ ^[0-9]+$ ]]; then
        echo "llama-server footprint: ${footprint_mb:-?} MB | RSS: $((rss_kb / 1024)) MB | CPU: ${cpu_percent:-?}% | macOS free: ${free_percent:-?}% | swap: ${swap_mb:-?} MB | compressor: ${compressor_mb} MB"
      fi
      next_metrics_log=$((now + METRICS_LOG_INTERVAL))
    fi

    if [[ "$sample_phase" == "ready" && -n "$port_pid" && "$port_pid" != "$server_pid" ]]; then
      log_watchdog_event "process-port mismatch server_pid=${server_pid} port_pid=${port_pid}; monitoring server PID only"
    fi

    # Enforce this during model loading too: startup is the highest-risk period.
    # A critical free-memory reading stops immediately. Less severe pressure must
    # persist across consecutive samples, and swap activity only counts while
    # available memory is also low. This avoids restarts from harmless one-off
    # swap bursts and from the system-wide swap counter's historical growth.
    if (( NO_SWAP_GUARD == 1 )) && [[ "$free_percent" =~ ^[0-9]+$ ]]; then
      if (( free_percent <= CRITICAL_FREE_PERCENT )); then
        log_watchdog_event "terminating llama-server reason=critical-free-memory free_percent=${free_percent} floor_percent=${CRITICAL_FREE_PERCENT}"
        terminate_server "critical-free-memory"
        restart_requested=1
        restart_needs_recovery=1
        break
      fi

      pressure_reason=""
      if (( free_percent <= MIN_FREE_PERCENT )); then
        pressure_reason="low-free-memory"
      elif (( free_percent <= SWAP_PRESSURE_FREE_PERCENT && swapout_interval_mb >= MAX_SWAPOUT_GROWTH_MB )); then
        pressure_reason="swap-pressure"
      fi

      if [[ -n "$pressure_reason" ]]; then
        pressure_hits=$((pressure_hits + 1))
        if (( pressure_hits >= PRESSURE_CONFIRMATIONS )); then
          log_watchdog_event "terminating llama-server reason=sustained-${pressure_reason} confirmations=${pressure_hits} free_percent=${free_percent} swapout_interval_mb=${swapout_interval_mb} limit_mb=${MAX_SWAPOUT_GROWTH_MB}"
          terminate_server "sustained-${pressure_reason}"
          restart_requested=1
          restart_needs_recovery=1
          break
        fi
        log_watchdog_event "pressure sample reason=${pressure_reason} confirmation=${pressure_hits}/${PRESSURE_CONFIRMATIONS} free_percent=${free_percent} swapout_interval_mb=${swapout_interval_mb}"
      else
        pressure_hits=0
      fi
    else
      pressure_hits=0
    fi

    if (( elapsed < STARTUP_GRACE )); then
      sleep "$CHECK_INTERVAL"
      continue
    fi
    if [[ "$rss_kb" =~ ^[0-9]+$ ]]; then
      rss_mb=$((rss_kb / 1024))
      if [[ "$footprint_mb" =~ ^[0-9]+$ ]] && (( footprint_mb >= MAX_FOOTPRINT_MB )); then
        log_watchdog_event "terminating llama-server reason=physical-footprint footprint_mb=${footprint_mb} limit_mb=${MAX_FOOTPRINT_MB}"
        terminate_server "physical-footprint"
        restart_requested=1
        restart_needs_recovery="$NO_SWAP_GUARD"
        break
      fi
      if (( rss_mb >= MAX_RSS_MB )); then
        log_watchdog_event "terminating llama-server reason=rss rss_mb=${rss_mb} limit_mb=${MAX_RSS_MB}"
        terminate_server "rss"
        restart_requested=1
        restart_needs_recovery="$NO_SWAP_GUARD"
        break
      fi
    fi

    if (( NO_SWAP_GUARD == 0 )) && [[ "$free_percent" =~ ^[0-9]+$ ]] && (( free_percent <= MIN_FREE_PERCENT )); then
      log_watchdog_event "terminating llama-server reason=free-memory free_percent=${free_percent} floor_percent=${MIN_FREE_PERCENT} swap_mb=${swap_mb:-?}"
      terminate_server "free-memory"
      if (( STRICT_SWAP == 1 )); then
        wait "$server_pid" 2>/dev/null || true
        protected_relaunches=$((protected_relaunches + 1))
        if maybe_fallback_mtp_profile; then
          server_pid=""
          sleep 10
          continue 2
        fi
        if (( protected_relaunches > MAX_PROTECTED_RELAUNCHES )); then
          echo "Watchdog reached the protected relaunch limit (${MAX_PROTECTED_RELAUNCHES}) for ${MODEL_LABEL}; exiting."
          exit 1
        fi
        echo "Watchdog relaunching ${MODEL_LABEL} after memory pressure (${protected_relaunches}/${MAX_PROTECTED_RELAUNCHES})."
        server_pid=""
        sleep 10
        continue 2
      fi
      restart_requested=1
      break
    fi
    if (( NO_SWAP_GUARD == 0 )) && [[ "$swap_used" =~ ^[0-9]+([.][0-9]+)?$ ]] && [[ "$free_percent" =~ ^[0-9]+$ ]] && (( free_percent <= MIN_FREE_PERCENT )); then
      swap_mb=${swap_used%.*}
      if (( swap_mb >= MAX_SWAP_MB )); then
        log_watchdog_event "terminating llama-server reason=swap-usage swap_mb=${swap_mb} limit_mb=${MAX_SWAP_MB} free_percent=${free_percent:-?}"
        terminate_server "swap-usage"
        restart_requested=1
        break
      fi
    fi
    if (( STRICT_SWAP == 1 && NO_SWAP_GUARD == 0 )) && [[ "$swap_used" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      swap_mb=${swap_used%.*}
      swap_delta_mb=$((swap_mb - swap_before_mb))
      if (( swap_delta_mb >= MAX_SWAP_MB )); then
        log_watchdog_event "terminating llama-server reason=swap-increase swap_delta_mb=${swap_delta_mb} limit_mb=${MAX_SWAP_MB} swap_mb=${swap_mb}"
        terminate_server "swap-increase"
        wait "$server_pid" 2>/dev/null || true
        protected_relaunches=$((protected_relaunches + 1))
        if maybe_fallback_mtp_profile; then
          server_pid=""
          sleep 10
          continue 2
        fi
        if (( protected_relaunches > MAX_PROTECTED_RELAUNCHES )); then
          echo "Watchdog reached the protected relaunch limit (${MAX_PROTECTED_RELAUNCHES}) for ${MODEL_LABEL}; exiting."
          exit 1
        fi
        echo "Watchdog relaunching ${MODEL_LABEL} after swap pressure (${protected_relaunches}/${MAX_PROTECTED_RELAUNCHES})."
        server_pid=""
        sleep 10
        continue 2
      fi
    fi
    sleep "$CHECK_INTERVAL"
  done

  server_exit_code=0
  wait "$server_pid" 2>/dev/null || server_exit_code=$?
  if [[ "$MODEL_CHOICE" == "4" && "$api_ready" == "1" ]]; then
    log_new_bonsai_performance
  fi
  server_pid=""

  # If the process disappeared on its own while the system was swapping or
  # critically low on memory, treat it like a guarded memory kill.
  if (( NO_SWAP_GUARD == 1 && restart_requested == 0 )); then
    exit_free_percent="$(memory_free_percent || true)"
    exit_vm_snapshot="$(vm_stat 2>/dev/null || true)"
    exit_swapouts="$(vm_stat_value Swapouts "$exit_vm_snapshot" || true)"
    [[ "$exit_swapouts" =~ ^[0-9]+$ ]] || exit_swapouts="$swapouts_before"
    exit_swapout_delta_pages=$((exit_swapouts - swapouts_before))
    (( exit_swapout_delta_pages >= 0 )) || exit_swapout_delta_pages=0
    exit_swapout_growth_mb=$((exit_swapout_delta_pages * page_size_bytes / 1024 / 1024))
    if { (( exit_swapout_growth_mb >= MAX_SWAPOUT_GROWTH_MB )) &&
         [[ "$exit_free_percent" =~ ^[0-9]+$ ]] && (( exit_free_percent <= SWAP_PRESSURE_FREE_PERCENT )); } ||
       { [[ "$exit_free_percent" =~ ^[0-9]+$ ]] && (( exit_free_percent <= CRITICAL_FREE_PERCENT )); }; then
      restart_requested=1
      restart_needs_recovery=1
      log_watchdog_event "unexpected exit classified as memory pressure swapout_growth_mb=${exit_swapout_growth_mb} free_percent=${exit_free_percent:-?}"
    fi
  fi

  if (( api_ready == 1 && elapsed >= PROTECTED_RESTART_RESET_SECONDS )); then
    unprotected_relaunches=0
  fi

  if (( restart_requested == 1 )); then
    if (( restart_needs_recovery == 1 )); then
      protected_relaunches=$((protected_relaunches + 1))
      if maybe_fallback_mtp_profile; then
        wait_for_memory_recovery
      else
        if (( protected_relaunches > MAX_PROTECTED_RELAUNCHES )); then
          echo "Watchdog reached the protected relaunch limit (${MAX_PROTECTED_RELAUNCHES}) for ${MODEL_LABEL}; exiting." >&2
          exit 1
        fi
        echo "Watchdog: protected restart ${protected_relaunches}/${MAX_PROTECTED_RELAUNCHES} queued after memory recovery."
        wait_for_memory_recovery
      fi
    else
      sleep 5
    fi
  elif (( server_exit_code == 0 )); then
    log_watchdog_event "server exited cleanly; watchdog stopping without relaunch"
    exit 0
  else
    unprotected_relaunches=$((unprotected_relaunches + 1))
    if (( unprotected_relaunches > MAX_UNPROTECTED_RELAUNCHES )); then
      log_watchdog_event "server exited status=${server_exit_code}; unprotected relaunch limit reached (${MAX_UNPROTECTED_RELAUNCHES})"
      exit "$server_exit_code"
    fi
    log_watchdog_event "server exited status=${server_exit_code}; unprotected restart ${unprotected_relaunches}/${MAX_UNPROTECTED_RELAUNCHES} in 5 seconds"
    sleep 5
  fi
done
