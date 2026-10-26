# Global OpenCode Instructions

## Delegation-only parents

Every user task must run in one foreground subagent at a time. Parent agents only coordinate and summarize concise worker handoffs. Parents must not read files, search, execute commands, edit, or run verification. Do not copy source into the parent or fall back to parent execution when delegation is unavailable; report the blocker.

## Local inference memory safety

For the 16 GB Bonsai/Splash profile, run one user job at a time and delegate to at most one active worker. Multiple chats or OpenCode clients do not improve throughput on this profile. Finish or explicitly stop the current job before starting another. When the user withdraws or stops a request, abort that exact OpenCode session using the supported session API; do not launch replacement work. Do not cancel unrelated users' sessions or close applications. Do not retry a busy/resource-limited backend in a loop. Keep native inference concurrency at one and use the launcher-configured context limits; do not increase context during a task. Do not add launchd or automatic startup.

## Explicit continuation only

After a delegated child returns, deliver its result and stop. Do not launch additional sections, slices, verification jobs, or follow-up agents until the user explicitly requests continuation. A broad assignment does not authorize autonomous multi-stage continuation after the first bounded handoff.

## Self-contained worker assignments

A fresh worker does not inherit the parent's conversation. Pass one focused deliverable using this compact template:

```text
OBJECTIVE: one fix, section, or bounded lookup.
TARGET: exact known paths and section/range; otherwise the selected directory for discovery.
KNOWN EVIDENCE: relevant confirmed findings, changed paths, completed checks, or none.
DONE WHEN: the deliverable and its focused verification.
OUT OF SCOPE: excluded work and later slices.
```

Keep delegation arguments normally below 500 tokens, leaving room in the parent's response budget for serialized tool-call JSON. This is a soft planning target, never a reason to truncate instructions or omit necessary evidence. Reference source by path instead of embedding transcripts, scripts, or full patches. Carry the last handoff's confirmed progress and next unfinished slice into each new assignment; do not restart completed work. Aim for 4-8 KB of new source evidence per slice, with necessary verification preserved.

## Safe file writes

Never send a whole large Markdown or source file in one `write` tool call. Create the file or apply a small first patch, then write or edit bounded sections of about 500-700 tokens per call and verify each section. Leave room in the model's output limit for tool-call JSON and a concise status. If a write payload would be large, use `bash` with `apply_patch` in multiple bounded patches. This prevents truncated JSON tool arguments and preserves recoverable progress. IQ3 editing workers have up to 4,096 output tokens; parents retain 2,048. Treat the larger ceiling as room to finish valid JSON, and split oversized edits after an incomplete input instead of replaying them.

## Markdown to LaTeX

For any task that converts a Markdown file to LaTeX, the first conversion attempt MUST run:

```bash
__RUNTIME_ROOT__/scripts/md2latex.sh INPUT.md
```

Use the absolute path because subagent shells may not inherit the user's `PATH`. Do not manually recreate the conversion unless the script fails or the user explicitly requests a different workflow.

## Project-local helpers

Create helper scripts and validation artifacts inside the selected project, for example `tmp/opencode/`, using a permitted working directory. The global policy denies external directories. After an external-directory denial, use a project-local path; do not retry the denied path through another tool or command. Report essential external-access blockers instead of widening the policy.
