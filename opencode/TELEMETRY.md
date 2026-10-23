# Splash lifecycle and performance telemetry

Version 2 adds correlated lifecycle events to the global OpenCode plugins,
Splash HTTP frontend, and launcher status monitor. It records metadata and
counts; prompts, generated text, tool arguments/results, and arbitrary headers
are excluded.

## Files and activation

- OpenCode: `~/.local/state/opencode/performance.jsonl`. An isolated run can set
  `OPENCODE_TELEMETRY_DIR`. Plugins emit `telemetry_started` on loading.
- Splash: the launcher exports `SPLASH_TELEMETRY_PATH` beside the timestamped
  profile log as `<profile>.log.jsonl`. Python server changes and this environment
  variable take effect on the next server launch.
- Monitor: `~/.local/state/llama-server/splash-status.jsonl`, every 2 seconds
  when launched by `startllamacpp.sh`. Failed probes go to
  `splash-status-errors.jsonl`. The monitor can be replaced without restarting
  inference. `SPLASH_MONITOR_OWNER_PID` bounds a replacement monitor's lifetime.

The maintained monitor is `dev/tools/monitorsplash.sh`, installed as
`~/monitorsplash.sh` and `runtime/scripts/monitorsplash.sh`. Launcher sampling
can be overridden with `SPLASH_MONITOR_INTERVAL` (positive integer seconds).

Every five minutes the monitor also appends a `performance_summary` to
`splash-performance.jsonl` and a readable `===== [PERF] Performance 300s (native)` line to
`splash-latest.log` (the active profile log). It records interval and engine
lifetime PP/TPS, processed/generated/cached token counts, completed/failed/
cancelled requests, and thermal/memory state. Rates are total native stage
tokens divided by total stage elapsed time, not averages of request rates or
tokens divided by five minutes of clock time. Engine lifetime includes startup
warmup when included in native counters; it is not a production-only average.
Quiet mode writes both files and suppresses stdout, which the launcher redirects
to its log. Performance summaries are also mirrored directly to the launcher's
terminal, discovered from the monitor's parent or `SPLASH_MONITOR_OWNER_PID`.
Set `SPLASH_MONITOR_TTY` to an explicit terminal path, or to an empty string to
disable this mirror. Missing terminals do not interrupt file logging. Readable
summaries use local timestamps with UTC offsets, matching the launcher clock;
JSON retains epoch timestamps.
Search the active log with `rg -F '[PERF]' ~/.local/state/llama-server/splash-latest.log`.

The first ready sample establishes the interval baseline; the first summary
is emitted after 300 seconds, on the next successful fresh sample. Idle stages
have null rates in JSON and `idle` in the readable log. Missing optional counts
show `n/a`. HTTP instance changes, native restarts or counter rollbacks reset
the baseline. Stale/unready probes do not contribute. `SPLASH_SUMMARY_INTERVAL`
can override the 300-second period. Restarting only the monitor starts a new
interval but preserves the engine lifetime average. Native batch rates differ
from client-visible streaming rates, which remain in request telemetry.

The maintained runtime repository and installed global files receive the same
OpenCode changes. Its older bundled Splash server receives a compatible patch;
unsupported reasoning metadata stays null. Existing human-readable logs remain
available for older report tools.

## Events and correlation

OpenCode records `llm_request_start`, `llm_response_headers`, and
`llm_request_end` for primary, worker, title, and compaction requests. Each has a
request ID carried in `x-opencode-request-id`; session, parent session, agent,
and request kind are also propagated. Requested and effective thinking/output
settings are separate. Stream completion distinguishes `[DONE]`, HTTP errors,
abort, reader cancellation, stream errors, and EOF without a terminal marker.
Usage, cached/reasoning tokens, first token, stream bytes, keepalives, and tool
call counts are recorded when available. No per-token text is saved.

`tool_start` precedes execution. The existing `tool` event is its terminal
counterpart, linked by span and call IDs. Generated tool calls link to the model
request that produced them. Delegation, question waits, and leaf tools have
separate categories. Nonzero shell exits are signals, not automatically source
or test failures. Abort requests do not claim that execution stopped. If native
interruption skips the terminal hook, later transcripts can emit
`tool_terminal_reconciled` with an upper duration bound and an explicitly unknown
exact end. `tool_result_observed` also exposes outcomes with missing hooks.

Compaction emits a start and terminal span, linked to its model request through
an asynchronous context. Every 10 seconds `activity_snapshot` reports open
request/tool ages and last progress, plus logger health. Reload events expose
unresolved spans; process termination can still leave spans without an end.

Splash emits HTTP ingress/error, request preparation, frontend queue enter/leave,
native start, throttled prefill progress, first token, and request end. Events
include the client request ID, server HTTP ID, native request ID, public response
ID, effective generation settings, token counts, stage timings, build identity,
and cached thermal/memory state when available. `/status.telemetry` exposes
enabled state, write failures, dropped events, and pending writer events. The
bounded asynchronous writer avoids disk I/O on the native event reader.

Every native request event also records the effective sampler and seed. At
startup a `run_manifest` event preserves the resolved model directory, target
and draft revisions and file digests, native command, allowlisted serving
options, server source hashes, checkout identity, device, memory plan, KV/state
formats, context, prefill chunk size, and initial cache/request counters. It
excludes API keys, arbitrary environment variables, and request content. File
digests come from the installer record; telemetry does not reread multi-GB
weights or claim a fresh content verification. Legacy model directories without
`model.json` explicitly report unavailable assembly identity.

Status snapshots retain active request progress, native/frontend queues,
admission and memory state, thermal state, system swap, cache/state/disk counters,
build identity, stale-status flags, and HTTP probe duration. System swap is a
machine-wide snapshot, not process-owned memory or a measured swap stall.

Samples additionally retain full expert-streaming counters (separate prefill
and decode reads, hit rates, loads, slots and arena/staging sizes), memory plan,
identity, and disk quota/free-space state. Prefix-cache disk traffic and expert
reads are separate in `--report`. Process RSS is recorded for the HTTP server
and its direct children; shared pages mean it must not be added to Metal
allocation or treated as unique physical memory. `vm_stat` page size and
page-in/out and swap-in/out counters are machine-wide. Sample deltas are null
when unavailable, counters reset, or the HTTP instance changes. Two-second
sampling improves visibility but does not measure exact stalls or guarantee
capture of every short spike. Older JSONL remains readable, with missing fields
reported as unavailable.

## Timing interpretation

OpenCode and native events carry wall and monotonic clocks plus unique process
instance IDs. Use monotonic differences only within one process; correlate
processes by IDs and wall time. Native timestamps are captured before asynchronous
writing. Monitor snapshots carry sample wall time and probe duration.

Native PP and decode timings measure enclosing stage wall time. GPU kernel time,
CPU compute time, and precise swap stall time are not measured and stay unknown.
Worker/delegation spans, compaction, frontend queueing, and tools may overlap
model work; adding them double-counts time. Missing usage remains unknown, not
zero. Logger failure counters, bounded stream parser limits, and unresolved
spans make incomplete coverage visible. A crash may lose buffered events; this
is performance telemetry rather than a durable transaction log.

For a tuning comparison, hold artifact/runtime, sampler, filled context,
output/checker, and cache state constant. Collect repeated matched runs, retain
failures and cancellations, and report medians and spread with thermal/memory
conditions. More than 5% within-build spread prevents a stable speedup claim;
repeat or characterize it. Routine mixed OpenCode traffic is observational and
is not a controlled benchmark.

## Validation

The server suite passed 937 tests. OpenCode passed 40 unit tests and native
fixtures, including primary/title request correlation and byte-preserving SSE
wrapping. Dedicated telemetry tests cover cancellation, truncated streams,
oversized frames, HTTP failures, missing tool hooks, privacy, and writer failure.
The older runtime server patch passed its three telemetry integration tests.
The deployed monitor was smoke-tested against the existing live server without
submitting inference.

The 2026-10-23 performance additions passed all 939 current server tests, all
15 installed-launcher regression tests, five compatible older-runtime telemetry
tests, and eight monitor fixture tests. Fixtures cover missing OS data, counter
resets, process selection, expert/identity preservation, legacy reports,
five-minute weighted averages, idle intervals, and quiet terminal mirroring.
The full server checks also verified explicit release of the assembly hold on
shutdown, eliminating a file-handle warning found during validation.

A real option-18 startup on isolated port 1236 verified the complete manifest,
three successful requests including SSE, 768 tokens reused on the repeated
prompt, two-second resource samples, and zero telemetry write failures or
dropped events. The test used a temporary OpenCode config and stopped afterward.
Artifacts: `build/validation/telemetry-performance-20261023/`. Initial memory
admission refusal and an exact-output punctuation mismatch are retained there
as diagnostics. This was a correctness smoke test, not a performance comparison.

The installed five-minute monitor was also checked against live `/status`
without submitting inference. Its readable average was displayed in the active
launcher's terminal and verified in the profile log using local timestamps;
the inference process and HTTP instance remained unchanged.
