import { record } from "./lib/telemetry.ts"

type Failure = { key: string; tool: string; kind: "schema" | "incomplete" | "external_directory" | "shell_portability" }

function failure(part: any): Failure | undefined {
  if (part?.type !== "tool-result" || !["text", "error", "error-text", "error-json"].includes(part.result?.type)) return
  const value = part.result.value
  const message = typeof value === "string" ? value : value?.error?.message ?? value?.message
  const tool = part.name ?? part.tool
  if (typeof message !== "string" || typeof tool !== "string") return
  // Native shell pipelines can report success when a later stage masks BSD
  // grep's exit code. Recover from the actual diagnostic, not inferred syntax.
  if (["shell", "bash"].includes(tool)
    && /(?:^|\n)(?:\/usr\/bin\/)?grep: (?:invalid|illegal) option -- ['"]?P['"]?(?:\r?\n|$)/.test(message)
    && /(?:^|\n)usage: grep \[/.test(message))
    return { tool, kind: "shell_portability", key: "grep:unsupported-P" }
  if (!["error", "error-text", "error-json"].includes(part.result?.type)) return
  // Question failures already have a one-attempt, current-turn fallback.
  if (tool !== "question" && message.startsWith(`Invalid arguments for tool "${tool}":`)) {
    // Exclude payloads: changed JSON with the same diagnostic is still the
    // same failure, and source/prompt contents must not enter telemetry.
    return { tool, kind: "schema", key: `${tool}:${message.split(/\n\s*Arguments provided:/)[0].trim()}` }
  }
  if (/^The tool call was not executed because the output token limit\b/.test(message))
    return { tool, kind: "incomplete", key: `${tool}:incomplete` }
  if (message === "Permission denied: external_directory")
    return { tool, kind: "external_directory", key: "external_directory" }
}

// Derive recovery from actual tool results after the latest user message.
// This covers parent/child sessions, survives reloads, and adds no call budget.
export default {
  id: "tool-failure-recovery",
  async setup(ctx: any) {
    await ctx.session.hook("context", async (event: any) => {
      if (event.model?.providerID !== "local-llama") return
      const messages = event.messages ?? []
      const boundary = messages.findLastIndex((message: any) => message.role === "user")
      if (boundary < 0) return
      const current = messages.slice(boundary + 1)
      const pending = new Map<string, { failure: Failure; count: number }>()
      for (const message of current) {
        if (message.role !== "tool" || !Array.isArray(message.content)) continue
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const item = failure(part)
          if (item) {
            pending.set(item.key, { failure: item, count: (pending.get(item.key)?.count ?? 0) + 1 })
          } else if (part.result?.type && !["error", "error-text", "error-json"].includes(part.result.type)) {
            const tool = part.name ?? part.tool
            for (const [key, previous] of pending) {
              if (previous.failure.tool === tool || (previous.failure.kind === "external_directory" && ["read", "write", "edit", "shell", "bash"].includes(tool))) pending.delete(key)
            }
          }
        }
      }
      if (!pending.size) return
      const stopped = [...pending.values()].find(item => item.count >= 2)
      let text: string
      if (stopped) {
        event.tools = {}
        text = `TOOL_FAILURE_STOP: ${stopped.failure.tool} failed twice with the same ${stopped.failure.kind} condition in this user turn. Return STATUS: PARTIAL with the actual failure, confirmed changes/checks, and remaining work. No further tools, retries, replacement workers, or claims of completion. A new user request can authorize recovery.`
      } else if ([...pending.values()].some(item => item.failure.kind === "shell_portability")) {
        text = "SHELL_PORTABILITY_RECOVERY: The actual shell output reports that this host's grep does not support -P, even if the pipeline exit code was zero. Do not use grep -P again. Preserve the requested task and checks; choose a portable equivalent with matching pattern semantics, installed rg, or Python's standard library. Do not blindly replace PCRE syntax with -E. Keep permitted project-local helpers and read-only shell checks available. Correct the unsupported command once and verify the real result; do not repeat already successful checks."
      } else {
        text = "TOOL_FAILURE_RECOVERY: A tool failed before useful execution. Correct the reported schema fields once, supplying complete arguments; never repeat an empty object. If output was cut off, shorten the delegation to objective, exact project path and checks; do not embed scripts or data tables. Split file payloads into smaller complete calls. For Permission denied: external_directory, keep the restriction: use a scratch/helper path inside the selected project, with a permitted working directory. Do not retry the denied external path or switch commands to bypass permission. If essential external access is required, report the exact permission blocker. A second identical failure ends this turn with a factual PARTIAL handoff."
      }
      const present = current.some((message: any) => message.role === "system" && Array.isArray(message.content) && message.content.some((part: any) => part.type === "text" && part.text === text))
      if (!present) {
        messages.push({ role: "system", content: [{ type: "text", text }] })
        await record({ event: "tool_failure_recovery", sessionID: event.sessionID, action: stopped ? "partial_handoff" : "one_correction", kinds: [...new Set([...pending.values()].map(item => item.failure.kind))] })
      }
    })
  },
}
