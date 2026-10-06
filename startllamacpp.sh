#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${RUNTIME_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
export RUNTIME_ROOT

LLAMA_SERVER="${LLAMA_SERVER:-/opt/homebrew/opt/llama.cpp/bin/llama-server}"
PRISM_LLAMA_SERVER="${PRISM_LLAMA_SERVER:-$HOME/prism-llama.cpp/build/bin/llama-server}"
SPLASH_BIN="${SPLASH_BIN:-${RUNTIME_ROOT}/splash/splash}"
QWEN_9B_MODEL="$HOME/.lmstudio/models/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q4_K_XL.gguf"
GEMMA_12B_MODEL="$HOME/.lmstudio/models/unsloth/gemma-4-12b-it-GGUF/gemma-4-12b-it-IQ4_XS.gguf"
LFM_8B_MODEL="$HOME/.lmstudio/models/unsloth/LFM2.5-8B-A1B-GGUF/LFM2.5-8B-A1B-UD-Q6_K_XL.gguf"
BONSAI_27B_MODEL="$HOME/.lmstudio/models/prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf"
SPLASH_BONSAI_MODEL_ID="prism-ml/Ternary-Bonsai-2-27B-gguf:PTQ1_0"
SPLASH_BONSAI_ALIAS="bonsai-27b-splash"
SPLASH_BONSAI_MAX_CONTEXT="${SPLASH_BONSAI_MAX_CONTEXT:-24K}"
SPLASH_BONSAI_OPENCODE_CONTEXT="${SPLASH_BONSAI_OPENCODE_CONTEXT:-auto}"
SPLASH_BONSAI_MAX_TOKENS="${SPLASH_BONSAI_MAX_TOKENS:-1024}"
SPLASH_BONSAI_MAX_CACHE_DISK="${SPLASH_BONSAI_MAX_CACHE_DISK:-8G}"
SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT="${SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT:-60}"
SPLASH_BONSAI_PREFILL_CHUNK_TOKENS="${SPLASH_BONSAI_PREFILL_CHUNK_TOKENS:-512}"
SPLASH_BONSAI_MAX_ACTIVE_REQUESTS="${SPLASH_BONSAI_MAX_ACTIVE_REQUESTS:-1}"
SPLASH_BONSAI_STARTUP_RETRY_DELAY="${SPLASH_BONSAI_STARTUP_RETRY_DELAY:-30}"
SPLASH_BONSAI_STARTUP_MAX_RETRIES="${SPLASH_BONSAI_STARTUP_MAX_RETRIES:-2}"
SPLASH_BONSAI_PERSISTENT_CACHE="${SPLASH_BONSAI_PERSISTENT_CACHE:-1}"
SPLASH_BONSAI_CACHE_DIR="${SPLASH_BONSAI_CACHE_DIR:-$HOME/Library/Caches/Splash/bonsai-option14}"
SPLASH_PRESSURE_RESTART_HEADROOM_BYTES="${SPLASH_PRESSURE_RESTART_HEADROOM_BYTES:-1073741824}"
SPLASH_PRESSURE_RESTART_INTERVAL="${SPLASH_PRESSURE_RESTART_INTERVAL:-5}"
SPLASH_PRESSURE_RESTART_SAMPLES="${SPLASH_PRESSURE_RESTART_SAMPLES:-3}"
QWEN_MTP_9B_MODEL="$HOME/.lmstudio/models/unsloth/Qwen3.5-9B-MTP-GGUF/Qwen3.5-9B-UD-Q4_K_XL.gguf"
MLX_VLM_PYTHON="${MLX_VLM_PYTHON:-$HOME/mlx-project/.venv/bin/python3}"
MLX_LM_PYTHON="${MLX_LM_PYTHON:-$HOME/mlx-project/.venv/bin/python3}"
MLX_TARGET_ID="mlx-community/Qwen3.5-9B-4bit"
MLX_MTP_DRAFT_PATH="${MLX_MTP_DRAFT_PATH:-$HOME/.lmstudio/models/mlx-community/Qwen3.5-9B-MTP-4bit}"
MLX_MTP_ALIAS="qwen3.5-9b-mlx-mtp"
MLX_MTP_CONTEXT="${MLX_MTP_CONTEXT:-22528}"
MLX_MTP_MAX_TOKENS="${MLX_MTP_MAX_TOKENS:-3072}"
MLX_MTP_DRAFT_BLOCK_SIZE="${MLX_MTP_DRAFT_BLOCK_SIZE:-2}"
MLX_API_ALIAS="qwen3.5-9b-mlx-reasoner"
MLX_BALANCED_ALIAS="qwen3.5-9b-mlx-balanced"
MLX_WORKER_ALIAS="qwen3.5-9b-mlx-worker"
MLX_CONTEXT_WINDOW="${MLX_CONTEXT_WINDOW:-49152}"
MLX_OPENCODE_CONTEXT="${MLX_OPENCODE_CONTEXT:-32768}"
MLX_MAX_TOKENS="${MLX_MAX_TOKENS:-12288}"
MLX_THINKING_BUDGET="${MLX_THINKING_BUDGET:-8192}"
MLX_BALANCED_MAX_TOKENS="${MLX_BALANCED_MAX_TOKENS:-6144}"
MLX_BALANCED_THINKING_BUDGET="${MLX_BALANCED_THINKING_BUDGET:-4096}"
MLX_WORKER_MAX_TOKENS="${MLX_WORKER_MAX_TOKENS:-4096}"
MLX_KV_BITS="${MLX_KV_BITS:-4}"
MLX_PREFILL_STEP_SIZE="${MLX_PREFILL_STEP_SIZE:-1024}"
MLX_MTP_PREFILL_STEP_SIZE="${MLX_MTP_PREFILL_STEP_SIZE:-1024}"
MLX_APC_ENABLED="${MLX_APC_ENABLED:-1}"
MLX_APC_BLOCK_SIZE="${MLX_APC_BLOCK_SIZE:-16}"
MLX_APC_NUM_BLOCKS="${MLX_APC_NUM_BLOCKS:-256}"
MLX_MTP_APC_NUM_BLOCKS="${MLX_MTP_APC_NUM_BLOCKS:-$MLX_APC_NUM_BLOCKS}"
PORT="${LLAMA_PORT:-1235}"
HOST="${LLAMA_HOST:-127.0.0.1}"
DIRECT_LAUNCH=0
DIRECT_CHOICE=""
HERMES_LAUNCH=0

timestamp_log_stream() {
  local line timestamp
  while IFS= read -r line || [[ -n "$line" ]]; do
    timestamp="$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf '[%s] %s\n' "$timestamp" "$line"
  done
}

find_hf_snapshot() {
  local model_id="$1"
  local cache_name="models--${model_id//\//--}"
  local candidate=""
  local weight=""

  for candidate in "$HOME/.cache/huggingface/hub/$cache_name/snapshots/"*; do
    [[ -d "$candidate" ]] || continue
    [[ -f "$candidate/config.json" ]] || continue
    weight=""
    for weight in "$candidate"/*.safetensors; do
      [[ -e "$weight" ]] && break
      weight=""
    done
    [[ -n "$weight" ]] || continue
    if find "$HOME/.cache/huggingface/hub/$cache_name" -name '*.incomplete' -print -quit 2>/dev/null | grep -q .; then
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

print_models() {
  local qwen_9b_status=""
  local gemma_status=""
  local lfm_status=""
  local bonsai_27b_status=""
  local qwen_mtp_status=""
  local mlx_status=""
  local mlx_mtp_status=""
  local mlx_apc_status="APC configuration invalid"
  local splash_status=""
  local splash_client_context="$SPLASH_BONSAI_OPENCODE_CONTEXT"
  if [[ "$splash_client_context" == "auto" ]]; then
    splash_client_context="$(splash_context_tokens "$SPLASH_BONSAI_MAX_CONTEXT" 2>/dev/null)" || splash_client_context=0
    if (( splash_client_context >= 4096 && splash_client_context <= 24576 )); then
      splash_client_context="$((splash_client_context - 2048)) tokens"
    else
      splash_client_context="auto (invalid server context)"
    fi
  else
    splash_client_context="${splash_client_context} tokens"
  fi
  [[ -e "$QWEN_9B_MODEL" ]] || qwen_9b_status=" — model not installed"
  [[ -e "$GEMMA_12B_MODEL" ]] || gemma_status=" — model not installed"
  [[ -e "$LFM_8B_MODEL" ]] || lfm_status=" — model not installed"
  [[ -f "$BONSAI_27B_MODEL" ]] || bonsai_27b_status=" — GGUF model not installed"
  [[ -e "$QWEN_MTP_9B_MODEL" ]] || qwen_mtp_status=" — model not installed"
  if [[ ! -x "$MLX_VLM_PYTHON" ]]; then
    mlx_status=" — mlx-vlm runtime not installed"
  elif ! find_hf_snapshot "$MLX_TARGET_ID" >/dev/null; then
    mlx_status=" — target model not downloaded"
  fi
  if [[ ! -f "$MLX_MTP_DRAFT_PATH/config.json" || ! -f "$MLX_MTP_DRAFT_PATH/model.safetensors" ]]; then
    mlx_mtp_status=" — MTP drafter not installed"
  fi
  if [[ "$MLX_APC_ENABLED" == "0" ]]; then
    mlx_apc_status="APC off"
  elif [[ "$MLX_APC_ENABLED" == "1" && "$MLX_APC_BLOCK_SIZE" =~ ^[1-9][0-9]*$ && "$MLX_APC_NUM_BLOCKS" =~ ^[1-9][0-9]*$ ]]; then
    mlx_apc_status="APC on: $((MLX_APC_BLOCK_SIZE * MLX_APC_NUM_BLOCKS)) cached tokens"
  fi
  [[ -x "$SPLASH_BIN" ]] || splash_status=" — Splash executable missing"
  echo "Available local models:"
  echo "1) Qwen3.5 9B Q4_K_XL — llama.cpp planner${qwen_9b_status}"
  echo "   32K context | 4K output | reasoning on (4K budget) | Q4 KV | MTP off"
  echo "2) Gemma 4 12B IQ4_XS — general use${gemma_status}"
  echo "   32K context | 4K output | reasoning off | Q4 KV | MTP off"
  echo "3) LFM 2.5 8B Q6_K_XL — compact model${lfm_status}"
  echo "   32K context | 4K output | reasoning auto | Q4 KV | MTP off"
  echo "4) Ternary Bonsai 2 27B PTQ1 GGUF — llama-server${bonsai_27b_status}"
  echo "   24K server / 20K OpenCode context | 4K output | non-thinking instruct sampling | Q4 KV | 512 MiB RAM cache | single sequence | guarded"
  echo "5) Qwen3.5 9B MTP Q4_K_XL — speculative decoding${qwen_mtp_status}"
  echo "   16K context | 2K output | reasoning off | MTP 3 | Q4 target/Q8 draft KV"
  echo "6) Qwen3.5 9B Q4_K_XL — fast non-MTP${qwen_9b_status}"
  echo "   16K context | 2K output | reasoning off | Q4 KV | MTP off"
  echo "7) Qwen3.5 9B MTP Q4_K_XL — long-context speculative${qwen_mtp_status}"
  echo "   32K context | 2K output | reasoning off | MTP 4 | Q4 target/Q8 draft KV"
  echo "8) Qwen3.5 9B MLX 4-bit — deep reasoning${mlx_status}"
  echo "   General coding + optional long_analysis agent | all tools enabled"
  echo "   $((MLX_OPENCODE_CONTEXT / 1024))K OpenCode / $((MLX_CONTEXT_WINDOW / 1024))K server | ${MLX_MAX_TOKENS} generation reserve"
  echo "   Q4 KV | MTP off | ${mlx_apc_status}"
  echo "9) Stop local LLM watchdog and server"
  echo "10) Qwen3.5 9B MLX 4-bit — MTP reasoning${mlx_status}${mlx_mtp_status}"
  echo "   $((MLX_MTP_CONTEXT / 1024))K context | $((MLX_MTP_MAX_TOKENS / 1024))K output | reasoning on (no separate budget) | native MTP width ${MLX_MTP_DRAFT_BLOCK_SIZE} | Q4 KV | ${mlx_apc_status}"
  echo "14) Ternary Bonsai 2 27B PTQ1_0 — Splash (downloads on first run)${splash_status}"
  echo "   ${SPLASH_BONSAI_MAX_CONTEXT} server / ${splash_client_context} OpenCode context | $((SPLASH_BONSAI_MAX_TOKENS / 1024))K output | INT8 KV | ${SPLASH_BONSAI_PREFILL_CHUNK_TOKENS}-token prefill chunks | ${SPLASH_BONSAI_MAX_CACHE_DISK} SSD cache | ${SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT}s resource wait"
  echo "   Persistent prefix cache: ${SPLASH_BONSAI_PERSISTENT_CACHE} (1=keep across restarts, 0=temporary) | startup retries: ${SPLASH_BONSAI_STARTUP_MAX_RETRIES}"
  echo "   Memory pressure monitor: Splash controls admission/recovery; 24K requires room for other apps"
  echo "   Source: ${SPLASH_BONSAI_MODEL_ID}"
  echo "   Monitor: bash "${RUNTIME_ROOT}/scripts/monitorsplash.sh" --once (or --report 24)"
}

# Check length before arithmetic so huge decimal overrides cannot wrap.
splash_uint_in_range() {
  local value="$1" minimum="$2" maximum="$3"
  [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]] &&
    [[ ${#value} -le ${#maximum} ]] &&
    (( value >= minimum && value <= maximum ))
}

splash_context_tokens() {
  local value="$1"
  if [[ "$value" =~ ^([1-9][0-9]*)[Kk]$ ]]; then
    splash_uint_in_range "${BASH_REMATCH[1]}" 1 256 || return 1
    echo "$((${value%[Kk]} * 1024))"
  elif splash_uint_in_range "$value" 1 262144; then
    echo "$value"
  else
    return 1
  fi
}

splash_cache_disk_bytes() {
  local value="$1" multiplier=1 number="$1"
  case "$value" in
    *[Gg]) multiplier=1073741824; number="${value%[Gg]}" ;;
    *[Mm]) multiplier=1048576; number="${value%[Mm]}" ;;
    *[Kk]) multiplier=1024; number="${value%[Kk]}" ;;
  esac
  splash_uint_in_range "$number" 0 "$((8589934592 / multiplier))" || return 1
  echo "$((number * multiplier))"
}

splash_stop_monitor() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  # Stop the monitor's outstanding curl/sleep as well as its shell.
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

splash_cleanup_run() {
  if [[ -n "$splash_server_pid" ]]; then
    kill -TERM "$splash_server_pid" 2>/dev/null || true
    wait "$splash_server_pid" 2>/dev/null || true
  fi
  # Close the parent's log writer and drain the final shutdown/cache messages.
  exec 3>&-
  if [[ -n "$splash_logger_pid" ]]; then
    wait "$splash_logger_pid" 2>/dev/null || true
  fi
  splash_stop_monitor "$splash_pressure_watchdog_pid"
  splash_stop_monitor "$splash_monitor_pid"
  splash_stop_monitor "$splash_retry_pid"
}

splash_pressure_watchdog() {
  local consecutive=0
  local payload state pressure headroom waiting suspended
  local pressure_active=0

  while :; do
    payload="$(curl --max-time 3 -fsS "http://${HOST}:${PORT}/status" 2>/dev/null)" || {
      consecutive=0
      sleep "$SPLASH_PRESSURE_RESTART_INTERVAL"
      continue
    }
    state="$(jq -r '[.memory_pressure // "unknown",
      (.memory_governor.host_headroom_bytes // 0 | tostring),
      (.admission.waiting_memory // 0 | tostring),
      (.admission.suspended // 0 | tostring)] | @tsv' <<< "$payload")" || {
      consecutive=0
      sleep "$SPLASH_PRESSURE_RESTART_INTERVAL"
      continue
    }
    IFS=$'\t' read -r pressure headroom waiting suspended <<< "$state"
    if [[ "$pressure" == "warning" || "$pressure" == "critical" ]] &&
       (( headroom <= SPLASH_PRESSURE_RESTART_HEADROOM_BYTES )) &&
       (( waiting > 0 || suspended > 0 )); then
      consecutive=$((consecutive + 1))
    else
      consecutive=0
    fi
    if (( consecutive >= SPLASH_PRESSURE_RESTART_SAMPLES )); then
      if (( pressure_active == 0 )); then
        printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
          "Splash pressure monitor: sustained $pressure pressure with ${headroom} bytes headroom and memory waiters (waiting=$waiting suspended=$suspended). Keeping HTTP API online; Splash admission/recovery remains in control." >> "$SPLASH_RUN_LOG"
        pressure_active=1
      fi
    elif (( pressure_active == 1 )); then
      printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
        "Splash pressure monitor: pressure wait cleared (pressure=$pressure headroom=$headroom waiting=$waiting suspended=$suspended)." >> "$SPLASH_RUN_LOG"
      pressure_active=0
    fi
    sleep "$SPLASH_PRESSURE_RESTART_INTERVAL"
  done
}

require_model() {
  local model_path="$1"
  local model_label="$2"
  if [[ ! -f "$model_path" ]]; then
    echo "$model_label model not found: $model_path" >&2
    exit 1
  fi
}

prepare_llama_run() {
  local profile_slug="$1"
  local server_path="${2:-$LLAMA_SERVER}"
  local log_dir="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
  local run_id=""

  if [[ ! -x "$server_path" ]]; then
    echo "llama-server is missing or not executable: $server_path" >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT is already in use; choose option 9 before switching models." >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi

  mkdir -p "$log_dir"
  run_id="$(date '+%Y%m%d-%H%M%S')"
  LLAMA_RUN_LOG="$log_dir/${profile_slug}-${run_id}.log"
  # Create the file before publishing the latest-log links.  This prevents
  # watchdogs and monitoring tools from following a dangling symlink during
  # the model-loading window.
  : > "$LLAMA_RUN_LOG"
  ln -sfn "$LLAMA_RUN_LOG" "$log_dir/llama-latest.log"
  ln -sfn "$LLAMA_RUN_LOG" "$log_dir/${profile_slug}-latest.log"
  echo "Run log: $LLAMA_RUN_LOG"
  echo "Metrics: http://${HOST}:${PORT}/metrics | Slots: http://${HOST}:${PORT}/slots"
  echo "Press Ctrl-C in this Terminal to stop it."
}

prepare_splash_run() {
  local log_dir="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
  local run_id=""

  if [[ ! -x "$SPLASH_BIN" ]]; then
    echo "Splash is missing or not executable: $SPLASH_BIN" >&2
    echo "Build or install Splash, or set SPLASH_BIN to its executable path." >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT is already in use; choose option 9 before switching models." >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi

  mkdir -p "$log_dir"
  run_id="$(date '+%Y%m%d-%H%M%S')"
  SPLASH_RUN_LOG="$log_dir/bonsai-27b-splash-$run_id.log"
  : > "$SPLASH_RUN_LOG"
  ln -sfn "$SPLASH_RUN_LOG" "$log_dir/splash-latest.log"
  ln -sfn "$SPLASH_RUN_LOG" "$log_dir/bonsai-27b-splash-latest.log"
  echo "Run log: $SPLASH_RUN_LOG"
  echo "Status: http://${HOST}:${PORT}/status"
  echo "Press Ctrl-C in this Terminal to stop it."
}

sync_opencode_model() {
  local model_alias="$1"
  local config_path="${OPENCODE_CONFIG_PATH:-$HOME/.config/opencode/opencode.json}"
  local model_id="local-llama/${model_alias}"
  local mlx_mtp_model_id="local-llama/${MLX_MTP_ALIAS}"
  local worker_model_id="$model_id"
  local reasoner_model_id="$model_id"
  local balanced_model_id="$model_id"
  local default_model_id="$model_id"
  local bonsai_full_model_id="local-llama/bonsai-27b"
  local bonsai_splash_model_id="local-llama/${SPLASH_BONSAI_ALIAS}"
  local temp_path=""

  [[ -f "$config_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || {
    echo "jq is required to synchronize OpenCode with the selected server profile." >&2
    return 1
  }

  if [[ "$model_alias" == "bonsai-27b" ]]; then
    model_id="$bonsai_full_model_id"
    worker_model_id="$bonsai_full_model_id"
    reasoner_model_id="$bonsai_full_model_id"
    balanced_model_id="$bonsai_full_model_id"
    default_model_id="$model_id"
  elif [[ "$model_alias" == "$SPLASH_BONSAI_ALIAS" ]]; then
    model_id="$bonsai_splash_model_id"
    worker_model_id="$bonsai_splash_model_id"
    reasoner_model_id="$bonsai_splash_model_id"
    balanced_model_id="$bonsai_splash_model_id"
    default_model_id="$model_id"
  elif [[ "$model_alias" == "$MLX_API_ALIAS" ]]; then
    worker_model_id="local-llama/${MLX_WORKER_ALIAS}"
    reasoner_model_id="$model_id"
    balanced_model_id="local-llama/${MLX_BALANCED_ALIAS}"
    default_model_id="$balanced_model_id"
  elif [[ "$model_alias" == "$MLX_MTP_ALIAS" ]]; then
    # mlx-vlm 0.7.x resolves the request model literally; route the MTP
    # profile to the cached target ID instead of the display alias.
    model_id="local-llama/${MLX_TARGET_ID}"
    mlx_mtp_model_id="$model_id"
    worker_model_id="$model_id"
    reasoner_model_id="$model_id"
    balanced_model_id="$model_id"
    default_model_id="$model_id"
  fi

  temp_path="$(mktemp "${config_path}.tmp.XXXXXX")"
  if ! jq --arg default_model "$default_model_id" --arg worker "$worker_model_id" --arg reasoner "$reasoner_model_id" --arg selected_alias "$model_alias" \
    --arg base_url "http://${HOST}:${PORT}/v1" \
    --arg opencode_config_dir "$(dirname "$config_path")" \
    --arg mlx_reasoner "local-llama/${MLX_API_ALIAS}" \
    --arg mlx_mtp "$mlx_mtp_model_id" \
    --arg bonsai_splash "$bonsai_splash_model_id" \
    --arg mlx_mtp_key "$MLX_TARGET_ID" \
    --argjson bonsai_splash_context "$SPLASH_BONSAI_OPENCODE_CONTEXT" \
    --argjson bonsai_splash_output "$SPLASH_BONSAI_MAX_TOKENS" \
    --argjson mlx_context "$MLX_OPENCODE_CONTEXT" \
    --argjson mlx_mtp_context "$MLX_MTP_CONTEXT" \
    --argjson mlx_mtp_output "$MLX_MTP_MAX_TOKENS" \
    --argjson reasoner_output "$MLX_MAX_TOKENS" \
    --argjson balanced_output "$MLX_BALANCED_MAX_TOKENS" \
    --argjson worker_output "$MLX_WORKER_MAX_TOKENS" \
    '.provider["local-llama"].options.baseURL = $base_url |
     .model = $default_model |
     .small_model = $worker |
     .compaction = {
       auto: true, keep: {tokens: 1536},
       buffer: (.provider["local-llama"].models[$selected_alias].limit.output // 4096)
     } |
     .default_agent = "router" |
     .experimental = ((.experimental // {}) + {subagent_depth: 1}) |
     del(.subagent_depth) |
     .agent = ((.agent // {}) + {
         router: {
           description: "Routes every request to an isolated worker so the parent context stays small",
           prompt: "{file:\($opencode_config_dir)/prompts/router.md}",
           mode: "primary",
           model: $default_model,
           tools: {"*": false, task: true, question: true},
           temperature: 0.7,
           top_p: 0.80,
           permission: {
             "*": "deny",
             task: {"*": "deny", context_worker: "allow", general_worker: "allow"},
             question: "allow"
           }
         },
         general: {
           description: "Local coding agent with tools and selective delegation",
           prompt: "{file:\($opencode_config_dir)/prompts/general.md}",
           mode: "primary",
           model: $default_model,
           tools: {
             read: true, grep: true, glob: true, list: true,
             edit: true, write: true, todowrite: true,
             bash: true, task: true, skill: true, question: true,
             webfetch: true, websearch: true
           },
           permission: {
             read: "allow", grep: "allow", glob: "allow", list: "allow",
             edit: "allow", write: "allow", todowrite: "allow",
             bash: "allow", task: "allow", skill: "allow", question: "allow",
             webfetch: "allow", websearch: "allow"
           }
         },
         long_analysis: {
           description: "Long-form debugging, planning, and analysis",
           prompt: "{file:\($opencode_config_dir)/prompts/long-analysis.md}",
           mode: "all",
           model: $reasoner,
           tools: {
             read: true, grep: true, glob: true, list: true,
             edit: true, write: true, todowrite: true,
             bash: true, task: true, skill: true, question: true,
             webfetch: true, websearch: true
           },
           permission: {
             read: "allow", grep: "allow", glob: "allow", list: "allow",
             edit: "allow", write: "allow", todowrite: "allow",
             bash: "allow", task: "allow", skill: "allow", question: "allow",
             webfetch: "allow", websearch: "allow"
           }
         },
         context_worker: {
           description: "Use first for section-by-section, large-document, or multi-file work; complete one slice in a separate context and return a concise handoff",
           prompt: "{file:\($opencode_config_dir)/prompts/context-worker.md}",
           mode: "subagent",
           model: $worker,
           tools: {
             read: true, grep: true, glob: true, list: true,
             edit: true, write: true, todowrite: true,
             bash: true, task: false, skill: true, question: false,
             webfetch: true, websearch: true
           },
           permission: {
             read: "allow", grep: "allow", glob: "allow", list: "allow",
             edit: "allow", write: "allow", todowrite: "allow",
             bash: "allow", task: "deny", skill: "allow", question: "deny",
             webfetch: "allow", websearch: "allow"
           }
         },
         general_worker: {
           description: "Completes one assigned task in a fresh child context and reports a concise result",
           prompt: "{file:\($opencode_config_dir)/prompts/general-worker.md}",
           mode: "subagent",
           model: $worker,
           tools: {
             read: true, grep: true, glob: true, list: true,
             edit: true, write: true, todowrite: true,
             bash: true, task: false, skill: true, question: false,
             webfetch: true, websearch: true
           },
           permission: {
             read: "allow", grep: "allow", glob: "allow", list: "allow",
             edit: "allow", write: "allow", todowrite: "allow",
             bash: "allow", task: "deny", skill: "allow", question: "deny",
             webfetch: "allow", websearch: "allow"
           }
         }
       }) |
     .agent |= with_entries(
       if .key == "router" or .key == "general" or .key == "long_analysis" or
          .key == "context_worker" or .key == "general_worker"
       then .value.reasoningEffort = "none" else . end
     ) |
     if $default_model == $bonsai_splash then
       .agent.router.temperature = 0.7 |
       .agent.router.top_p = 0.80 |
       .agent.general.temperature = 0.7 |
       .agent.general.top_p = 0.80 |
       .agent.long_analysis.temperature = 0.7 |
       .agent.long_analysis.top_p = 0.80 |
       .agent.context_worker.temperature = 0.7 |
       .agent.context_worker.top_p = 0.80 |
       .agent.general_worker.temperature = 0.7 |
       .agent.general_worker.top_p = 0.80 |
       .compaction = ((.compaction // {}) + {
         auto: true, keep: {tokens: 1536}, buffer: $bonsai_splash_output
       }) |
       .tool_output = ((.tool_output // {}) + {max_lines: 100, max_bytes: 8192}) |
       .provider["local-llama"].models["bonsai-27b-splash"] = {
         name: "Ternary Bonsai 2 27B PTQ1_0 via Splash (non-thinking, int8 KV)",
         limit: {context: $bonsai_splash_context, output: $bonsai_splash_output}
       }
     elif $selected_alias == "bonsai-27b" then
       .agent.general.temperature = 0.7 |
       .agent.general.top_p = 0.80 |
       .agent.long_analysis.temperature = 0.7 |
       .agent.long_analysis.top_p = 0.80 |
       .agent.context_worker.temperature = 0.7 |
       .agent.context_worker.top_p = 0.80 |
       .agent.general_worker.temperature = 0.7 |
       .agent.general_worker.top_p = 0.80 |
       .compaction = ((.compaction // {}) + {
         auto: true, keep: {tokens: 1536}, buffer: 4096
       }) |
       .tool_output = ((.tool_output // {}) + {max_lines: 100, max_bytes: 8192}) |
       .provider["local-llama"].models["bonsai-27b"] = {
         name: "Ternary Bonsai 2 27B PTQ1 GGUF (20K client, 4K output, non-thinking)",
         limit: {context: 20480, output: 4096}
       } |
       .provider["local-llama"].models["bonsai-27b-brief"] = {
         modelID: "bonsai-27b",
         name: "Ternary Bonsai 2 27B PTQ1 GGUF (legacy alias, 20K client, 4K output, non-thinking)",
         limit: {context: 20480, output: 4096}
       } |
       del(.provider["local-llama"].models["prism-ml/Bonsai-27B-mlx-1bit"],
           .provider["local-llama"].models["$HOME/.lmstudio/models/prism-ml/Bonsai-27B-mlx-1bit"])
     elif $default_model == $mlx_mtp then
       .compaction = ((.compaction // {}) + {
         auto: true, keep: {tokens: 2048}, buffer: $mlx_mtp_output
       }) |
       .provider["local-llama"].models["qwen3.5-9b-mlx-mtp"] = {
         name: "Qwen 3.5 9B MLX MTP Safe Long Jobs (\($mlx_mtp_context / 1024)K)",
         limit: {context: $mlx_mtp_context, output: $mlx_mtp_output}
       } |
       .provider["local-llama"].models[$mlx_mtp_key] = {
         name: "Qwen 3.5 9B MLX MTP Safe Long Jobs (\($mlx_mtp_context / 1024)K)",
         limit: {context: $mlx_mtp_context, output: $mlx_mtp_output}
       }
     elif $reasoner == $mlx_reasoner then
       .compaction.buffer = $reasoner_output |
       .provider["local-llama"].models["qwen3.5-9b-mlx-reasoner"].limit = {context: $mlx_context, output: $reasoner_output} |
       .provider["local-llama"].models["qwen3.5-9b-mlx-balanced"].limit = {context: $mlx_context, output: $balanced_output} |
       .provider["local-llama"].models["qwen3.5-9b-mlx-worker"].limit = {context: $mlx_context, output: $worker_output}
     else . end' \
    "$config_path" >"$temp_path"; then
    rm -f "$temp_path"
    echo "Failed to update OpenCode model selection." >&2
    return 1
  fi
  chmod 600 "$temp_path"
  mv "$temp_path" "$config_path"
  if [[ "$model_alias" == "bonsai-27b" ]]; then
    echo "OpenCode model synchronized: $default_model_id (non-thinking)"
    echo "OpenCode default: task-only router; it delegates to a child. Switch to general to work directly."
  elif [[ "$model_alias" == "$SPLASH_BONSAI_ALIAS" ]]; then
    echo "OpenCode model synchronized: $default_model_id (Splash, PTQ1_0, int8 KV)"
  else
    echo "OpenCode model synchronized: $default_model_id (agent reasoning effort: none)"
  fi
}

sync_opencode_splash() {
  local config_path="${OPENCODE_CONFIG_PATH:-$HOME/.config/opencode/opencode.json}"
  local model_id="local-llama/${SPLASH_BONSAI_ALIAS}"
  local temp_path=""

  [[ -f "$config_path" ]] || return 0
  command -v jq >/dev/null 2>&1 || {
    echo "jq is required to synchronize OpenCode with Splash." >&2
    return 1
  }

  temp_path="$(mktemp "${config_path}.tmp.XXXXXX")"
  if ! jq --arg model "$model_id" \
    --arg base_url "http://${HOST}:${PORT}/v1" \
    --arg opencode_config_dir "$(dirname "$config_path")" \
    --argjson context "$SPLASH_BONSAI_OPENCODE_CONTEXT" \
    --argjson output "$SPLASH_BONSAI_MAX_TOKENS" \
    '.provider["local-llama"].options.baseURL = $base_url |
     .model = $model |
     .small_model = $model |
     .agent |= ((. // {}) | with_entries(
       if (.value | type) == "object" and ((.value.model // "") | startswith("local-llama/"))
       then .value.model = $model else . end
     )) |
     .agent |= with_entries(
       if .key == "router" or .key == "general" or .key == "long_analysis" or
          .key == "context_worker" or .key == "general_worker"
       then .value.reasoningEffort = "none" else . end
     ) |
     .agent.router.tools.question = true |
     .agent.router.permission.question = "allow" |
     .agent.router.temperature = 0.7 |
     .agent.router.top_p = 0.80 |
     .agent.general.temperature = 0.7 |
     .agent.general.top_p = 0.80 |
     .agent.long_analysis.temperature = 0.7 |
     .agent.long_analysis.top_p = 0.80 |
     .agent.context_worker.temperature = (.agent.context_worker.temperature // 0.7) |
     .agent.context_worker.top_p = 0.80 |
     .agent.general_worker.temperature = (.agent.general_worker.temperature // 0.7) |
     .agent.general_worker.top_p = 0.80 |
     .compaction = ((.compaction // {}) + {
       auto: true, keep: {tokens: ([1536, (($context - $output) / 2 | floor)] | min)}, buffer: $output
     }) |
     del(.compaction.prune, .compaction.tail_turns,
         .compaction.preserve_recent_tokens, .compaction.reserved) |
     .experimental = ((.experimental // {}) + {subagent_depth: 1}) |
     del(.subagent_depth) |
     .tool_output = ((.tool_output // {}) + {max_lines: 100, max_bytes: 8192}) |
     .provider["local-llama"].models["bonsai-27b-splash"] = {
       name: "Ternary Bonsai 2 27B PTQ1_0 via Splash (non-thinking, int8 KV)",
       limit: {context: $context, output: $output}
     }' "$config_path" >"$temp_path"; then
    rm -f "$temp_path"
    echo "Failed to update OpenCode model selection." >&2
    return 1
  fi
  chmod 600 "$temp_path"
  mv "$temp_path" "$config_path"
  echo "OpenCode model synchronized: $model_id (Splash, PTQ1_0, int8 KV)"
}

stop_llamacpp() {
  local watchdog_pid=""
  local watchdog_pid_file="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}/watchdog-${PORT}.pid"
  local listener_pids=""
  local pid=""
  local parent_pid=""
  local process_command=""
  local attempt=0

  if [[ -f "$watchdog_pid_file" ]]; then
    pid="$(< "$watchdog_pid_file")"
    process_command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ && "$process_command" == *"${RUNTIME_ROOT}/scripts/watchllamacpp.sh"* ]]; then
      watchdog_pid="$pid"
    fi
  fi

  listener_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  # A watchdog started before PID files were added is the parent of its server.
  if [[ -z "$watchdog_pid" && -n "$listener_pids" ]]; then
    pid="${listener_pids%%$'\n'*}"
    parent_pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    process_command="$(ps -o command= -p "$parent_pid" 2>/dev/null || true)"
    if [[ "$process_command" == *"${RUNTIME_ROOT}/scripts/watchllamacpp.sh"* ]]; then
      watchdog_pid="$parent_pid"
    fi
  fi

  if [[ -n "$watchdog_pid" ]]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
    for attempt in {1..30}; do
      kill -0 "$watchdog_pid" 2>/dev/null || break
      sleep 0.2
    done
  fi

  # The watchdog may be draining a request. Stop only the listener on this
  # port if it remains, including direct llama.cpp and MLX launches.
  listener_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$listener_pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      process_command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      if [[ "$process_command" != *"llama-server"* && "$process_command" != *"mlx_vlm.server"* && "$process_command" != *"/splash/"* ]]; then
        echo "Port $PORT is owned by an unrelated process (PID $pid); leaving it running." >&2
        return 1
      fi
      kill -TERM "$pid" 2>/dev/null || true
    done <<< "$listener_pids"
    for attempt in {1..30}; do
      if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
  fi

  if [[ -n "$watchdog_pid" ]]; then
    for attempt in {1..60}; do
      kill -0 "$watchdog_pid" 2>/dev/null || break
      sleep 0.2
    done
  fi
  listener_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if { [[ -n "$watchdog_pid" ]] && kill -0 "$watchdog_pid" 2>/dev/null; } || [[ -n "$listener_pids" ]]; then
    echo "Could not stop the local LLM on port $PORT." >&2
    [[ -n "$watchdog_pid" ]] && echo "Watchdog PID: $watchdog_pid" >&2
    [[ -n "$listener_pids" ]] && echo "Remaining listener PID(s): $listener_pids" >&2
    return 1
  fi

  echo "Local LLM watchdog and server are stopped."
}

usage() {
  cat <<'EOF'
Usage:
  startllamacpp.sh                  Select a model, or choose 9 to stop serving
  startllamacpp.sh --watch [1-7|10] Start a watchdog-managed server
  startllamacpp.sh --direct [1-8|10|14] Start the selected server without the watchdog
  startllamacpp.sh --hermes [1-7]  Start a model and its matching Hermes profile
  startllamacpp.sh --list           List model choices

Nothing is installed as a background or login service. Interactive watched
mode remains attached to the Terminal and stops cleanly with Ctrl-C.
EOF
}

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --list)
    print_models
    exit 0
    ;;
esac

if [[ "${1:-}" == "--hermes" ]]; then
  HERMES_LAUNCH=1
  shift
  # A non-option argument is the model choice. Any remaining arguments are
  # forwarded unchanged to Hermes (for example --tui or -z "prompt").
  case "${1:-}" in
    ""|-*) ;;
    *)
      DIRECT_CHOICE="$1"
      shift
      ;;
  esac
fi

if (( HERMES_LAUNCH == 0 )) && [[ "${1:-}" == "--direct" ]]; then
  DIRECT_LAUNCH=1
  shift
  DIRECT_CHOICE="${1:-}"
fi

# Normal mode hands the selected profile to the watchdog. Direct mode is used
# by the watchdog after it has applied memory-pressure and swap safeguards.
if (( HERMES_LAUNCH == 0 )) && [[ "${1:-}" == "--watch" ]]; then
  shift
  MODEL_CHOICE="${1:-1}"
  case "$MODEL_CHOICE" in
    1|2|3|4|5|6|7|10) ;;
    *)
      echo "Invalid model choice: $MODEL_CHOICE (expected 1-7 or 10)." >&2
      exit 2
      ;;
  esac
  exec "${RUNTIME_ROOT}/scripts/watchllamacpp.sh" "$MODEL_CHOICE"
fi

if (( DIRECT_LAUNCH == 1 || HERMES_LAUNCH == 1 )) && [[ -n "$DIRECT_CHOICE" ]]; then
  choice="$DIRECT_CHOICE"
else
  print_models
  if ! read -r -p "Enter choice (1-10 or 14; 9 stops): " choice; then
    echo "No model choice received." >&2
    exit 2
  fi
fi

case "$choice" in
  1|2|3|4|5|6|7|8|10|14) ;;
  9)
    stop_llamacpp
    exit $?
    ;;
  *)
    echo "Invalid choice: $choice (expected 1-10 or 14; 9 stops)." >&2
    exit 2
    ;;
esac

if [[ "$choice" == "8" || "$choice" == "10" || "$choice" == "14" ]]; then
  if (( HERMES_LAUNCH == 1 )); then
    echo "Options 8, 10, and 14 do not use hermeslocal profiles; run them from the interactive menu or with --direct." >&2
    exit 2
  fi
  # Keep the reasoning-only profile direct; MTP option 10 is supervised by the
  # watchdog unless the caller explicitly requests --direct.
  if [[ "$choice" == "8" || "$choice" == "14" ]]; then
    DIRECT_LAUNCH=1
  fi
fi

if (( HERMES_LAUNCH == 1 )); then
  exec "$HOME/.local/bin/hermeslocal" --start "$choice" "$@"
fi

if (( DIRECT_LAUNCH == 0 )); then
  exec "${RUNTIME_ROOT}/scripts/watchllamacpp.sh" "$choice"
fi

case "$choice" in
  1)
    require_model "$QWEN_9B_MODEL" "Qwen 3.5 9B"
    prepare_llama_run "qwen-planner"
    sync_opencode_model "qwen3.5-9b-planner"
    exec "$LLAMA_SERVER" \
      -m "$QWEN_9B_MODEL" \
      --alias qwen3.5-9b-planner \
      -c 32768 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 1024 \
      --kv-unified \
      --batch-size 768 \
      --ubatch-size 384 \
      --n-predict 4096 \
      --top-p 0.95 \
      --top-k 20 \
      --min-p 0.0 \
      --presence-penalty 0.0 \
      --repeat-penalty 1.0 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --reasoning on \
      --reasoning-budget 4096 \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  2)
    require_model "$GEMMA_12B_MODEL" "Gemma 4 12B"
    prepare_llama_run "gemma-12b"
    sync_opencode_model "gemma-4-12b"
    exec "$LLAMA_SERVER" \
      -m "$GEMMA_12B_MODEL" \
      --alias gemma-4-12b \
      -c 32768 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 1024 \
      --kv-unified \
      --batch-size 512 \
      --ubatch-size 256 \
      --jinja \
      --n-predict 4096 \
      --temp 1.0 \
      --top-p 0.95 \
      --top-k 64 \
      --repeat-penalty 1.0 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --reasoning off \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  3)
    require_model "$LFM_8B_MODEL" "LFM 2.5 8B"
    prepare_llama_run "lfm-8b"
    sync_opencode_model "lfm2.5-8b"
    exec "$LLAMA_SERVER" \
      -m "$LFM_8B_MODEL" \
      --alias lfm2.5-8b \
      -c 32768 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 512 \
      --kv-unified \
      --batch-size 512 \
      --ubatch-size 256 \
      --n-predict 4096 \
      --temp 0.2 \
      --top-k 80 \
      --repeat-penalty 1.05 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --reasoning auto \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  4)
    require_model "$BONSAI_27B_MODEL" "Ternary Bonsai 2 27B GGUF"
    prepare_llama_run "bonsai-27b" "$PRISM_LLAMA_SERVER"
    sync_opencode_model "bonsai-27b"
    exec "$PRISM_LLAMA_SERVER" \
      -m "$BONSAI_27B_MODEL" \
      --alias bonsai-27b \
      -c 24576 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 512 \
      --temp 0.7 \
      --top-p 0.80 \
      --top-k 20 \
      --min-p 0.0 \
      --repeat-penalty 1.0 \
      --presence-penalty 1.5 \
      --reasoning off \
      --n-predict 4096 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  5)
    require_model "$QWEN_MTP_9B_MODEL" "Qwen 3.5 9B MTP"
    prepare_llama_run "qwen-mtp-16k"
    sync_opencode_model "qwen3.5-9b-mtp"
    exec "$LLAMA_SERVER" \
      -m "$QWEN_MTP_9B_MODEL" \
      --alias qwen3.5-9b-mtp \
      --spec-type draft-mtp \
      --spec-draft-n-max 3 \
      --spec-draft-type-k q8_0 \
      --spec-draft-type-v q8_0 \
      -c 16384 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 256 \
      --kv-unified \
      --batch-size 768 \
      --ubatch-size 384 \
      --n-predict 2048 \
      --temp 0.6 \
      --top-p 0.95 \
      --top-k 20 \
      --min-p 0.0 \
      --presence-penalty 0.0 \
      --repeat-penalty 1.0 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --reasoning off \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  6)
    require_model "$QWEN_9B_MODEL" "Qwen 3.5 9B"
    prepare_llama_run "qwen-fast-16k"
    sync_opencode_model "qwen3.5-9b-fast"
    exec "$LLAMA_SERVER" \
      -m "$QWEN_9B_MODEL" \
      --alias qwen3.5-9b-fast \
      -c 16384 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 1024 \
      --kv-unified \
      --batch-size 768 \
      --ubatch-size 384 \
      --n-predict 2048 \
      --temp 0.6 \
      --top-p 0.95 \
      --top-k 20 \
      --min-p 0.0 \
      --repeat-penalty 1.0 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --reasoning off \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  7)
    require_model "$QWEN_MTP_9B_MODEL" "Qwen 3.5 9B MTP"
    prepare_llama_run "qwen-mtp-32k"
    sync_opencode_model "qwen3.5-9b-mtp-32k"
    exec "$LLAMA_SERVER" \
      -m "$QWEN_MTP_9B_MODEL" \
      --alias qwen3.5-9b-mtp-32k \
      --spec-type draft-mtp \
      --spec-draft-n-max 4 \
      --spec-draft-type-k q8_0 \
      --spec-draft-type-v q8_0 \
      -c 32768 \
      --parallel 1 \
      --no-cont-batching \
      --flash-attn on \
      --n-gpu-layers all \
      --no-host \
      --cache-type-k q4_0 \
      --cache-type-v q4_0 \
      --cache-ram 256 \
      --kv-unified \
      --batch-size 1024 \
      --ubatch-size 512 \
      --n-predict 2048 \
      --temp 0.6 \
      --top-p 0.95 \
      --top-k 20 \
      --min-p 0.0 \
      --presence-penalty 0.0 \
      --repeat-penalty 1.0 \
      --host "$HOST" \
      --port "$PORT" \
      --cors-origins localhost \
      --offline \
      --metrics \
      --reasoning off \
      --log-file "$LLAMA_RUN_LOG" \
      --log-colors off \
      --log-timestamps
    ;;

  8)
    if ! [[ "$MLX_CONTEXT_WINDOW" =~ ^[1-9][0-9]*$ ]] || (( MLX_CONTEXT_WINDOW < 4096 )); then
      echo "MLX_CONTEXT_WINDOW must be an integer of at least 4096." >&2
      exit 1
    fi
    if ! [[ "$MLX_MAX_TOKENS" =~ ^[1-9][0-9]*$ ]] || (( MLX_MAX_TOKENS >= MLX_CONTEXT_WINDOW )); then
      echo "MLX_MAX_TOKENS must be positive and smaller than MLX_CONTEXT_WINDOW." >&2
      exit 1
    fi
    if ! [[ "$MLX_THINKING_BUDGET" =~ ^[1-9][0-9]*$ ]] || (( MLX_THINKING_BUDGET >= MLX_MAX_TOKENS )); then
      echo "MLX_THINKING_BUDGET must be positive and smaller than MLX_MAX_TOKENS." >&2
      exit 1
    fi
    if ! [[ "$MLX_OPENCODE_CONTEXT" =~ ^[1-9][0-9]*$ ]] || (( MLX_OPENCODE_CONTEXT >= MLX_CONTEXT_WINDOW )); then
      echo "MLX_OPENCODE_CONTEXT must be positive and smaller than MLX_CONTEXT_WINDOW." >&2
      exit 1
    fi
    if ! [[ "$MLX_BALANCED_MAX_TOKENS" =~ ^[1-9][0-9]*$ ]] || (( MLX_BALANCED_MAX_TOKENS >= MLX_OPENCODE_CONTEXT )); then
      echo "MLX_BALANCED_MAX_TOKENS must be positive and smaller than MLX_OPENCODE_CONTEXT." >&2
      exit 1
    fi
    if ! [[ "$MLX_BALANCED_THINKING_BUDGET" =~ ^[1-9][0-9]*$ ]] || (( MLX_BALANCED_THINKING_BUDGET >= MLX_BALANCED_MAX_TOKENS )); then
      echo "MLX_BALANCED_THINKING_BUDGET must be positive and smaller than MLX_BALANCED_MAX_TOKENS." >&2
      exit 1
    fi
    if ! [[ "$MLX_WORKER_MAX_TOKENS" =~ ^[1-9][0-9]*$ ]] || (( MLX_WORKER_MAX_TOKENS >= MLX_OPENCODE_CONTEXT )); then
      echo "MLX_WORKER_MAX_TOKENS must be positive and smaller than MLX_OPENCODE_CONTEXT." >&2
      exit 1
    fi
    if ! [[ "$MLX_KV_BITS" =~ ^[248]$ ]]; then
      echo "MLX_KV_BITS must be 2, 4, or 8." >&2
      exit 1
    fi
    if ! [[ "$MLX_PREFILL_STEP_SIZE" =~ ^[1-9][0-9]*$ ]]; then
      echo "MLX_PREFILL_STEP_SIZE must be a positive integer." >&2
      exit 1
    fi
    if ! [[ "$MLX_APC_ENABLED" =~ ^[01]$ ]]; then
      echo "MLX_APC_ENABLED must be 0 or 1." >&2
      exit 1
    fi
    if ! [[ "$MLX_APC_BLOCK_SIZE" =~ ^[1-9][0-9]*$ ]]; then
      echo "MLX_APC_BLOCK_SIZE must be a positive integer." >&2
      exit 1
    fi
    if ! [[ "$MLX_APC_NUM_BLOCKS" =~ ^[1-9][0-9]*$ ]]; then
      echo "MLX_APC_NUM_BLOCKS must be a positive integer." >&2
      exit 1
    fi
    MLX_APC_CAPACITY_TOKENS=$((MLX_APC_BLOCK_SIZE * MLX_APC_NUM_BLOCKS))
    if [[ "$MLX_APC_ENABLED" == "1" ]]; then
      MLX_APC_PROFILE="apc${MLX_APC_CAPACITY_TOKENS}"
    else
      MLX_APC_PROFILE="apc-off"
    fi
    MLX_TARGET_PATH="$(find_hf_snapshot "$MLX_TARGET_ID" || true)"
    if [[ ! -x "$MLX_VLM_PYTHON" ]]; then
      echo "mlx-vlm is not installed at: $MLX_VLM_PYTHON" >&2
      exit 1
    fi
    if [[ -z "$MLX_TARGET_PATH" ]]; then
      echo "The MLX target model is not completely downloaded: $MLX_TARGET_ID" >&2
      exit 1
    fi
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port $PORT is already in use; choose option 9 before starting MLX." >&2
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
      exit 1
    fi
    LOG_DIR="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
    mkdir -p "$LOG_DIR"
    RUN_ID="$(date '+%Y%m%d-%H%M%S')"
    LOG_FILE="$LOG_DIR/qwen-mlx-reasoning-$RUN_ID.log"
    LATEST_LOG="$LOG_DIR/qwen-mlx-reasoning-latest.log"
    METRICS_JSONL="$LOG_DIR/qwen-mlx-reasoning-metrics.jsonl"
    ln -sfn "$LOG_FILE" "$LATEST_LOG"
    exec > >(timestamp_log_stream | tee -a "$LOG_FILE") 2>&1
    echo "Starting Qwen3.5 9B MLX deep reasoning on http://${HOST}:${PORT}"
    echo "Model ID for API clients: $MLX_API_ALIAS (served model: $MLX_TARGET_ID)"
    echo "Balanced alias: $MLX_BALANCED_ALIAS (${MLX_BALANCED_THINKING_BUDGET} thinking + $((MLX_BALANCED_MAX_TOKENS - MLX_BALANCED_THINKING_BUDGET)) answer tokens)"
    echo "Focused subagent alias: $MLX_WORKER_ALIAS (thinking off, ${MLX_WORKER_MAX_TOKENS} output cap)"
    echo "OpenCode context: ${MLX_OPENCODE_CONTEXT} | compaction reserve: ${MLX_MAX_TOKENS} | planner prompt target: $((MLX_OPENCODE_CONTEXT - MLX_MAX_TOKENS))"
    echo "Context: ${MLX_CONTEXT_WINDOW} total | output cap: ${MLX_MAX_TOKENS} | thinking cap: ${MLX_THINKING_BUDGET}"
    echo "Allocation: up to ${MLX_THINKING_BUDGET} reasoning tokens + $((MLX_MAX_TOKENS - MLX_THINKING_BUDGET)) final-answer tokens"
    echo "KV cache: ${MLX_KV_BITS}-bit from token 0 | prefill chunk: ${MLX_PREFILL_STEP_SIZE} tokens"
    if [[ "$MLX_APC_ENABLED" == "1" ]]; then
      echo "Prefix cache: APC enabled | ${MLX_APC_NUM_BLOCKS} x ${MLX_APC_BLOCK_SIZE}-token blocks = ${MLX_APC_CAPACITY_TOKENS} cached tokens"
    else
      echo "Prefix cache: APC disabled"
    fi
    echo "MTP: disabled because MLX-VLM does not support enforced thinking budgets with speculative decoding"
    echo "Stats: per-profile PP/TPS, timing, memory, cache, reasoning, utilization, failures, and cumulative totals"
    echo "Stats JSON: http://${HOST}:${PORT}/v1/metrics"
    echo "Live monitor: ${RUNTIME_ROOT}/scripts/monitorllamacpp.sh --watch"
    echo "Performance report: ${RUNTIME_ROOT}/scripts/monitorllamacpp.sh --report 24"
    echo "Live log: ${RUNTIME_ROOT}/scripts/monitorllamacpp.sh --log"
    echo "OpenCode: start a new session; existing sessions retain their old model routing"
    echo "Run log: $LOG_FILE"
    echo "Durable metrics: $METRICS_JSONL"
    echo "Press Ctrl-C in this Terminal to stop it."
    sync_opencode_model "$MLX_API_ALIAS"
    # The server is kept offline so a normal launch can never redownload or
    # silently replace the snapshot verified above. Using the HF ID as the
    # cache key also prevents clients sending the advertised model ID from
    # forcing an unnecessary unload/reload cycle.
    exec env HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
      MLX_VLM_PRELOAD_MODEL="$MLX_TARGET_ID" \
      MLX_VLM_PERF_STATS=1 \
      MLX_VLM_ENFORCE_MAX_TOKENS=1 \
      MLX_VLM_FORCE_THINKING=1 \
      MLX_VLM_ENFORCE_THINKING_BUDGET=1 \
      APC_ENABLED="$MLX_APC_ENABLED" \
      APC_BLOCK_SIZE="$MLX_APC_BLOCK_SIZE" \
      APC_NUM_BLOCKS="$MLX_APC_NUM_BLOCKS" \
      MLX_VLM_RUN_ID="$RUN_ID" \
      MLX_VLM_SERVER_PROFILE="option8-mlx-kv${MLX_KV_BITS}-${MLX_CONTEXT_WINDOW}-${MLX_APC_PROFILE}" \
      MLX_VLM_CLIENT_CONTEXT_LIMIT="$MLX_OPENCODE_CONTEXT" \
      MLX_VLM_COMPACTION_RESERVE="$MLX_MAX_TOKENS" \
      MLX_VLM_REASONER_ALIAS="$MLX_API_ALIAS" \
      MLX_VLM_BALANCED_ALIAS="$MLX_BALANCED_ALIAS" \
      MLX_VLM_WORKER_ALIAS="$MLX_WORKER_ALIAS" \
      MLX_VLM_BALANCED_MAX_TOKENS="$MLX_BALANCED_MAX_TOKENS" \
      MLX_VLM_BALANCED_THINKING_BUDGET="$MLX_BALANCED_THINKING_BUDGET" \
      MLX_VLM_WORKER_MAX_TOKENS="$MLX_WORKER_MAX_TOKENS" \
      MLX_VLM_KV_BITS="$MLX_KV_BITS" \
      MLX_VLM_PREFILL_STEP_SIZE="$MLX_PREFILL_STEP_SIZE" \
      MLX_VLM_METRICS_JSONL="$METRICS_JSONL" \
      MLX_VLM_LOG_PROGRESS_INTERVAL=100 \
      PYTHONUNBUFFERED=1 \
      "$MLX_VLM_PYTHON" -m mlx_vlm.server \
      --model "$MLX_TARGET_ID" \
      --enable-thinking \
      --thinking-budget "$MLX_THINKING_BUDGET" \
      --max-kv-size "$MLX_CONTEXT_WINDOW" \
      --kv-bits "$MLX_KV_BITS" \
      --quantized-kv-start 0 \
      --prefill-step-size "$MLX_PREFILL_STEP_SIZE" \
      --max-tokens "$MLX_MAX_TOKENS" \
      --host "$HOST" \
      --port "$PORT" \
      --log-level INFO
    ;;

  10)
    if ! [[ "$MLX_MTP_CONTEXT" =~ ^[1-9][0-9]*$ ]] || (( MLX_MTP_CONTEXT < 4096 )); then
      echo "MLX_MTP_CONTEXT must be an integer of at least 4096." >&2
      exit 1
    fi
    if ! [[ "$MLX_MTP_MAX_TOKENS" =~ ^[1-9][0-9]*$ ]] || (( MLX_MTP_MAX_TOKENS >= MLX_MTP_CONTEXT )); then
      echo "MLX_MTP_MAX_TOKENS must be positive and smaller than MLX_MTP_CONTEXT." >&2
      exit 1
    fi
    if ! [[ "$MLX_MTP_DRAFT_BLOCK_SIZE" =~ ^[1-3]$ ]]; then
      echo "MLX_MTP_DRAFT_BLOCK_SIZE must be 1, 2, or 3." >&2
      exit 1
    fi
    if [[ ! -x "$MLX_VLM_PYTHON" ]]; then
      echo "mlx-vlm is not installed at: $MLX_VLM_PYTHON" >&2
      exit 1
    fi
    MLX_TARGET_PATH="$(find_hf_snapshot "$MLX_TARGET_ID" || true)"
    if [[ -z "$MLX_TARGET_PATH" ]]; then
      echo "The MLX target model is not completely downloaded: $MLX_TARGET_ID" >&2
      exit 1
    fi
    if [[ ! -f "$MLX_MTP_DRAFT_PATH/config.json" || ! -f "$MLX_MTP_DRAFT_PATH/model.safetensors" ]]; then
      echo "The MLX MTP drafter is incomplete: $MLX_MTP_DRAFT_PATH" >&2
      exit 1
    fi
    if [[ "$(jq -r '.model_type // empty' "$MLX_MTP_DRAFT_PATH/config.json" 2>/dev/null)" != "qwen3_5_mtp" ]]; then
      echo "The configured drafter is not a qwen3_5_mtp checkpoint: $MLX_MTP_DRAFT_PATH" >&2
      exit 1
    fi
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port $PORT is already in use; choose option 9 before starting MLX MTP." >&2
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
      exit 1
    fi
    LOG_DIR="${LLAMA_LOG_DIR:-$HOME/.local/state/llama-server}"
    mkdir -p "$LOG_DIR"
    RUN_ID="$(date '+%Y%m%d-%H%M%S')"
    LOG_FILE="$LOG_DIR/qwen-mlx-mtp-$RUN_ID.log"
    LATEST_LOG="$LOG_DIR/qwen-mlx-mtp-latest.log"
    METRICS_JSONL="$LOG_DIR/qwen-mlx-mtp-metrics.jsonl"
    ln -sfn "$LOG_FILE" "$LATEST_LOG"
    exec > >(timestamp_log_stream | tee -a "$LOG_FILE") 2>&1
    echo "Starting Qwen3.5 9B MLX MTP reasoning mode on http://${HOST}:${PORT}"
    echo "Target: $MLX_TARGET_ID"
    echo "MTP drafter: $MLX_MTP_DRAFT_PATH | width: $MLX_MTP_DRAFT_BLOCK_SIZE"
    echo "Context: $MLX_MTP_CONTEXT | total output cap: $MLX_MTP_MAX_TOKENS | reasoning enabled without a separate budget"
    echo "KV cache: ${MLX_KV_BITS}-bit from token 0 | prefill chunk: ${MLX_MTP_PREFILL_STEP_SIZE} tokens"
    if [[ "$MLX_APC_ENABLED" == "1" ]]; then
      echo "Prefix cache: APC enabled | ${MLX_MTP_APC_NUM_BLOCKS} x ${MLX_APC_BLOCK_SIZE}-token blocks = $((MLX_MTP_APC_NUM_BLOCKS * MLX_APC_BLOCK_SIZE)) cached tokens"
    else
      echo "Prefix cache: APC disabled"
    fi
    echo "Observed recent range: about 76-88% weighted MTP acceptance; long-context decode slows sharply above 20K prompt tokens"
    echo "Stats JSON: http://${HOST}:${PORT}/v1/metrics"
    echo "Live monitor: ${RUNTIME_ROOT}/scripts/monitorllamacpp.sh --watch"
    echo "Run log: $LOG_FILE"
    echo "Press Ctrl-C in this Terminal to stop it."
    sync_opencode_model "$MLX_MTP_ALIAS"
    exec env -u MLX_VLM_THINKING_BUDGET HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
      MLX_VLM_PRELOAD_MODEL="$MLX_TARGET_ID" \
      MLX_VLM_PERF_STATS=1 \
      MLX_VLM_ENFORCE_MAX_TOKENS=1 \
      MLX_VLM_FORCE_THINKING=1 \
      MLX_VLM_ENFORCE_THINKING_BUDGET=0 \
      MLX_VLM_DRAFT_MODEL="$MLX_MTP_DRAFT_PATH" \
      MLX_VLM_DRAFT_KIND=mtp \
      MLX_VLM_DRAFT_BLOCK_SIZE="$MLX_MTP_DRAFT_BLOCK_SIZE" \
      APC_ENABLED="$MLX_APC_ENABLED" \
      APC_BLOCK_SIZE="$MLX_APC_BLOCK_SIZE" \
      APC_NUM_BLOCKS="$MLX_MTP_APC_NUM_BLOCKS" \
      MLX_VLM_RUN_ID="$RUN_ID" \
      MLX_VLM_SERVER_PROFILE="option10-mlx-mtp-kv${MLX_KV_BITS}-${MLX_MTP_CONTEXT}" \
      MLX_VLM_CLIENT_CONTEXT_LIMIT="$MLX_MTP_CONTEXT" \
      MLX_VLM_COMPACTION_RESERVE="$MLX_MTP_MAX_TOKENS" \
      MLX_VLM_REASONER_ALIAS="$MLX_MTP_ALIAS" \
      MLX_VLM_KV_BITS="$MLX_KV_BITS" \
      MLX_VLM_PREFILL_STEP_SIZE="$MLX_MTP_PREFILL_STEP_SIZE" \
      MLX_VLM_METRICS_JSONL="$METRICS_JSONL" \
      MLX_VLM_LOG_PROGRESS_INTERVAL=100 \
      PYTHONUNBUFFERED=1 \
      "$MLX_VLM_PYTHON" -m mlx_vlm.server \
      --model "$MLX_TARGET_ID" \
      --draft-model "$MLX_MTP_DRAFT_PATH" \
      --draft-kind mtp \
      --draft-block-size "$MLX_MTP_DRAFT_BLOCK_SIZE" \
      --max-kv-size "$MLX_MTP_CONTEXT" \
      --kv-bits "$MLX_KV_BITS" \
      --quantized-kv-start 0 \
      --prefill-step-size "$MLX_MTP_PREFILL_STEP_SIZE" \
      --max-tokens "$MLX_MTP_MAX_TOKENS" \
      --enable-thinking \
      --host "$HOST" \
      --port "$PORT" \
      --log-level INFO
    ;;

  14)
    if ! splash_context_limit="$(splash_context_tokens "$SPLASH_BONSAI_MAX_CONTEXT")" ||
       (( splash_context_limit < 4096 || splash_context_limit > 24576 )); then
      echo "SPLASH_BONSAI_MAX_CONTEXT must be 4096-24576 tokens (e.g. 16K or 24K)." >&2
      exit 1
    fi
    if [[ "$SPLASH_BONSAI_OPENCODE_CONTEXT" == "auto" ]]; then
      SPLASH_BONSAI_OPENCODE_CONTEXT="$((splash_context_limit - 2048))"
    fi
    if ! splash_uint_in_range "$SPLASH_BONSAI_OPENCODE_CONTEXT" 2 22528 ||
       (( SPLASH_BONSAI_OPENCODE_CONTEXT >= splash_context_limit )); then
      echo "SPLASH_BONSAI_OPENCODE_CONTEXT must be auto or 2-22528 tokens, smaller than the server context." >&2
      exit 1
    fi
    if ! splash_uint_in_range "$SPLASH_BONSAI_MAX_TOKENS" 1 "$((SPLASH_BONSAI_OPENCODE_CONTEXT - 1))"; then
      echo "SPLASH_BONSAI_MAX_TOKENS must be positive and smaller than SPLASH_BONSAI_OPENCODE_CONTEXT." >&2
      exit 1
    fi
    if ! splash_uint_in_range "$SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT" 1 4294967295; then
      echo "SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT must be 1-4294967295 seconds." >&2
      exit 1
    fi
    if ! splash_uint_in_range "$SPLASH_BONSAI_PREFILL_CHUNK_TOKENS" 128 2048 ||
       (( SPLASH_BONSAI_PREFILL_CHUNK_TOKENS % 128 != 0 )); then
      echo "SPLASH_BONSAI_PREFILL_CHUNK_TOKENS must be a multiple of 128 in [128, 2048]." >&2
      exit 1
    fi
    if [[ "$SPLASH_BONSAI_MAX_ACTIVE_REQUESTS" != "1" ]]; then
      echo "This 16 GB safety profile requires SPLASH_BONSAI_MAX_ACTIVE_REQUESTS=1. Run one OpenCode job at a time." >&2
      exit 1
    fi
    if ! splash_uint_in_range "$SPLASH_BONSAI_STARTUP_RETRY_DELAY" 1 120 ||
       ! splash_uint_in_range "$SPLASH_BONSAI_STARTUP_MAX_RETRIES" 0 3; then
      echo "Splash startup retry delay must be 1-120 seconds and max retries 0-3." >&2
      exit 1
    fi
    if ! splash_uint_in_range "$SPLASH_BONSAI_PERSISTENT_CACHE" 0 1 ||
       ! splash_cache_disk_limit="$(splash_cache_disk_bytes "$SPLASH_BONSAI_MAX_CACHE_DISK")"; then
      echo "Splash persistent cache must be 0 or 1, and SSD cache quota 0-8G (e.g. 4G or 512M)." >&2
      exit 1
    fi
    splash_cache_args=()
    splash_cache_mode="off"
    if (( splash_cache_disk_limit > 0 )); then
      splash_cache_mode="temporary"
      if [[ "$SPLASH_BONSAI_PERSISTENT_CACHE" == "1" ]]; then
        splash_cache_mode="persistent"
        splash_cache_args=(--persistent-cache --cache-dir "$SPLASH_BONSAI_CACHE_DIR")
      fi
    fi
    if ! splash_uint_in_range "$SPLASH_PRESSURE_RESTART_HEADROOM_BYTES" 1 17179869184 ||
       ! splash_uint_in_range "$SPLASH_PRESSURE_RESTART_INTERVAL" 1 60 ||
       ! splash_uint_in_range "$SPLASH_PRESSURE_RESTART_SAMPLES" 1 12; then
      echo "Invalid Splash pressure monitor settings; headroom 1-16G bytes, interval 1-60, and samples 1-12." >&2
      exit 1
    fi
    for splash_dependency in jq curl lsof pkill; do
      command -v "$splash_dependency" >/dev/null 2>&1 || {
        echo "Option 14 requires $splash_dependency." >&2
        exit 1
      }
    done
    prepare_splash_run
    sync_opencode_splash
    printf 'Native inference concurrency: %s (FIFO queue across clients; no worker tool-call budget)\n' "$SPLASH_BONSAI_MAX_ACTIVE_REQUESTS" | timestamp_log_stream | tee -a "$SPLASH_RUN_LOG"
    printf 'Memory safety: run ONE OpenCode job at a time; multiple chats create queue waits and memory replay. Close unused memory-heavy apps before long jobs.\n' | timestamp_log_stream | tee -a "$SPLASH_RUN_LOG"
    printf 'Launcher: model=%s alias=%s binary=%s server_context=%s client_context=%s output=%s reasoning=none kv=int8 prefill_chunk=%s cache_disk=%s cache_mode=%s resource_wait=%ss host=%s port=%s\n' \
      "$SPLASH_BONSAI_MODEL_ID" "$SPLASH_BONSAI_ALIAS" "$SPLASH_BIN" "$SPLASH_BONSAI_MAX_CONTEXT" \
      "$SPLASH_BONSAI_OPENCODE_CONTEXT" "$SPLASH_BONSAI_MAX_TOKENS" "$SPLASH_BONSAI_PREFILL_CHUNK_TOKENS" "$SPLASH_BONSAI_MAX_CACHE_DISK" "$splash_cache_mode" "$SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT" "$HOST" "$PORT" |
      timestamp_log_stream | tee -a "$SPLASH_RUN_LOG"
    if [[ "$splash_cache_mode" == "persistent" ]]; then
      printf 'Prefix cache kept across restarts: %s\n' "$SPLASH_BONSAI_CACHE_DIR" | timestamp_log_stream | tee -a "$SPLASH_RUN_LOG"
    fi
    splash_monitor_pid=""
    splash_pressure_watchdog_pid=""
    splash_server_pid=""
    splash_logger_pid=""
    splash_retry_pid=""
    trap splash_cleanup_run EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    if [[ -f ${RUNTIME_ROOT}/scripts/monitorsplash.sh ]]; then
      bash "${RUNTIME_ROOT}/scripts/monitorsplash.sh" --record 600 >>"$SPLASH_RUN_LOG" 2>&1 &
      splash_monitor_pid=$!
    fi
    splash_startup_retries=0
    while :; do
      splash_pressure_watchdog >>"$SPLASH_RUN_LOG" 2>&1 &
      splash_pressure_watchdog_pid=$!
      splash_attempt_offset="$(wc -c < "$SPLASH_RUN_LOG")"
      exec 3> >(timestamp_log_stream | tee -a "$SPLASH_RUN_LOG")
      splash_logger_pid=$!
      "$SPLASH_BIN" serve \
        --model "$SPLASH_BONSAI_MODEL_ID" \
        --served-model-name "$SPLASH_BONSAI_ALIAS" \
        --host "$HOST" \
        --port "$PORT" \
        --language-only \
        --default-reasoning-effort none \
        --kv-format int8 \
        --prefill-chunk-tokens "$SPLASH_BONSAI_PREFILL_CHUNK_TOKENS" \
        --resource-wait-timeout "$SPLASH_BONSAI_RESOURCE_WAIT_TIMEOUT" \
        --max-active-requests "$SPLASH_BONSAI_MAX_ACTIVE_REQUESTS" \
        --max-context "$SPLASH_BONSAI_MAX_CONTEXT" \
        --max-cache-disk "$splash_cache_disk_limit" \
        ${splash_cache_args[@]+"${splash_cache_args[@]}"} \
        >&3 2>&1 &
      splash_server_pid=$!
      if wait "$splash_server_pid"; then splash_status=0; else splash_status=$?; fi
      splash_server_pid=""
      exec 3>&-
      wait "$splash_logger_pid" || true
      splash_logger_pid=""
      splash_stop_monitor "$splash_pressure_watchdog_pid"
      splash_pressure_watchdog_pid=""
      if (( splash_status == 0 || splash_status >= 128 )); then
        exit "$splash_status"
      fi
      # Retry only a startup admission failure, never a runtime/Metal failure.
      if ! tail -c "+$((splash_attempt_offset + 1))" "$SPLASH_RUN_LOG" |
           grep -Eq 'runtime bootstrap failed.*not enough free memory to start'; then
        exit "$splash_status"
      fi
      if (( splash_startup_retries >= SPLASH_BONSAI_STARTUP_MAX_RETRIES )); then
        echo "Splash startup stopped after ${splash_startup_retries} retries. Close memory-heavy apps or lower SPLASH_BONSAI_MAX_CONTEXT (e.g. 16K), then launch option 14 again." |
          timestamp_log_stream | tee -a "$SPLASH_RUN_LOG"
        exit "$splash_status"
      fi
      splash_startup_retries=$((splash_startup_retries + 1))
      echo "Splash startup needs more free memory; retry ${splash_startup_retries}/${SPLASH_BONSAI_STARTUP_MAX_RETRIES} in ${SPLASH_BONSAI_STARTUP_RETRY_DELAY} seconds. Close memory-heavy apps or press Ctrl-C to stop." |
        timestamp_log_stream | tee -a "$SPLASH_RUN_LOG"
      sleep "$SPLASH_BONSAI_STARTUP_RETRY_DELAY" &
      splash_retry_pid=$!
      wait "$splash_retry_pid"
      splash_retry_pid=""
    done
    ;;

  *)
    echo "Invalid choice. Exiting." >&2
    exit 1
    ;;
esac
