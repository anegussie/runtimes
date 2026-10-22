# Option 14 lifecycle telemetry

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
- Monitor: `~/.local/state/llama-server/splash-status.jsonl`, every 10 seconds
  when launched by `startllamacpp.sh`. Failed probes go to
  `splash-status-errors.jsonl`. The monitor can be replaced without restarting
  inference. `SPLASH_MONITOR_OWNER_PID` bounds a replacement monitor's lifetime.

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

Status snapshots retain active request progress, native/frontend queues,
admission and memory state, thermal state, system swap, cache/state/disk counters,
build identity, stale-status flags, and HTTP probe duration. System swap is a
machine-wide snapshot, not process-owned memory or a measured swap stall.

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

## Validation

The server suite passed 937 tests. OpenCode passed 40 unit tests and native
fixtures, including primary/title request correlation and byte-preserving SSE
wrapping. Dedicated telemetry tests cover cancellation, truncated streams,
oversized frames, HTTP failures, missing tool hooks, privacy, and writer failure.
The older runtime server patch passed its three telemetry integration tests.
The deployed monitor was smoke-tested against the existing live server without
submitting inference.
