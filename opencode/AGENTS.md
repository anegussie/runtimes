# Global OpenCode Instructions

## Local inference memory safety

For the 16 GB Bonsai/Splash profile, run one user job at a time and delegate to at most one active worker. Multiple chats or OpenCode clients do not improve throughput on this profile. Finish or explicitly stop the current job before starting another. When the user withdraws or stops a request, abort that exact OpenCode session using the supported session API; do not launch replacement work. Do not cancel unrelated users' sessions or close applications. Do not retry a busy/resource-limited backend in a loop. Keep native inference concurrency at one, server context at or below 14K, and client context at or below 12288. Do not add launchd or automatic startup.

## Explicit continuation only

After a delegated child returns, deliver its result and stop. Do not launch additional sections, slices, verification jobs, or follow-up agents until the user explicitly requests continuation. A broad assignment does not authorize autonomous multi-stage continuation after the first bounded handoff.

## Safe file writes

Never send a whole large Markdown or source file in one `write` tool call. Create the file or apply a small first patch, then write or edit bounded sections of about 500-700 tokens per call and verify each section. Leave room in the model's output limit for tool-call JSON and a concise status. If a write payload would be large, use `bash` with `apply_patch` in multiple bounded patches. This prevents truncated JSON tool arguments and preserves recoverable progress.

## Markdown to LaTeX

For any task that converts a Markdown file to LaTeX, the first conversion attempt MUST run:

```bash
__RUNTIME_ROOT__/scripts/md2latex.sh INPUT.md
```

Use the absolute path because subagent shells may not inherit the user's `PATH`. Do not manually recreate the conversion unless the script fails or the user explicitly requests a different workflow.
