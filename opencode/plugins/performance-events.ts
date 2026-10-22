import { randomUUID } from "node:crypto"
import { record, telemetryHealth } from "./lib/telemetry.ts"
import { RequestTelemetry } from "./lib/request-telemetry.ts"

const registry = Symbol.for("opencode.performance.telemetry")
const category = (tool: string) => ["subagent", "task"].includes(tool) ? "delegation" : tool === "question" ? "question_wait" : "leaf_tool"
const safe = (value: any) => typeof value === "string" ? value.slice(0, 160) : undefined

export default {
  id: "performance-events",
  async setup(ctx: any) {
    const previous = (globalThis as any)[registry]
    if (previous) { clearInterval(previous.timer); await record({ event: "telemetry_reload", openRequests: previous.requests.snapshot(), openTools: previous.tools.size, unresolved: true }) }
    const tools = new Map<string, any[]>(), sessions = new Map<string, any>()
    const results = new Set<string>(), terminals = new Set<string>()
    const requests = new RequestTelemetry(record)
    const key = (e: any) => `${e.sessionID}:${e.tool}:${e.callID ?? e.toolCallID ?? e.id ?? ""}`
    const snapshot = () => ({ event: "activity_snapshot", telemetryHealth: telemetryHealth(), requests: requests.snapshot(), tools: [...tools.values()].flat().map(s => ({
      spanID: s.spanID, sessionID: s.sessionID, callID: s.callID, tool: s.tool, kind: s.kind, ageMs: performance.now() - s.start,
      state: "awaiting_terminal_event", cancellationObservable: s.cancellationObservable,
    })) })
    await record({ event: "telemetry_started", intervalMs: 10000, clocks: "wall_and_monotonic", payloadsLogged: false,
      timingScope: "enclosing_spans_and_native_stages_must_not_be_summed" })
    const timer = setInterval(() => { void record(snapshot()) }, 10000)
    timer.unref()
    ;(globalThis as any)[registry] = { timer, requests, tools }
    await ctx.session.hook("context", async (event: any) => {
      const id = event.sessionID
      let parentID = sessions.get(id)?.parentID
      if (!sessions.has(id)) {
        try { parentID = (await ctx.session.get({ sessionID: id }))?.parentID } catch { /* Relationship remains explicitly unknown. */ }
      }
      sessions.set(id, { agent: safe(event.agent), parentID: safe(parentID), model: event.model })
      if (sessions.size > 1024) sessions.delete(sessions.keys().next().value!)
      await record({ event: "session_context", sessionID: id, parentSessionID: parentID ?? null,
        agent: safe(event.agent), providerID: event.model?.providerID, modelID: event.model?.id,
        messageCount: event.messages?.length ?? 0, offeredToolCount: Object.keys(event.tools ?? {}).length })
      // A native interrupt may skip execute.after. A later transcript can
      // establish an outcome, but not the exact execution end timestamp.
      for (const message of event.messages ?? []) for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type !== "tool-result") continue
        const call = part.toolCallId ?? part.toolCallID ?? part.id
        if (!call) continue
        const resultKey = `${id}:${call}`
        if (!results.has(resultKey)) {
          results.add(resultKey)
          if (results.size > 8192) results.delete(results.values().next().value!)
          await record({ event: "tool_result_observed", sessionID: id, callID: call,
            tool: safe(part.toolName ?? part.name ?? part.tool), resultType: safe(part.result?.type),
            terminalSource: "model_context", executionEndMissing: !terminals.has(resultKey),
            originatingRequestID: requests.origins.get(call) ?? null })
        }
        for (const [k, spans] of tools) {
          const found = spans.find(s => s.sessionID === id && s.callID === call)
          if (!found) continue
          found.cleanup?.(); tools.set(k, spans.filter(s => s !== found)); if (!tools.get(k)?.length) tools.delete(k)
          await record({ event: "tool_terminal_reconciled", spanID: found.spanID, sessionID: id, callID: call, tool: found.tool,
            outcome: /^error/.test(part.result?.type ?? "") ? "error" : "completed", elapsedMs: null,
            elapsedUpperBoundMs: performance.now() - found.start, exactEndMissing: true, terminalSource: "next_transcript" })
        }
      }
    })
    await ctx.session.hook("http.request", async (event: any) => {
      if (event.model?.providerID !== "local-llama") return
      await requests.before(event, sessions.get(event.sessionID))
    })
    await ctx.session.hook("http.response", async (event: any) => { await requests.response(event) })
    await ctx.tool.hook("execute.before", async (event: any) => {
      const id = key(event), meta = sessions.get(event.sessionID) ?? {}
      const signal = event.signal ?? event.abortSignal
      const span: any = { spanID: randomUUID(), start: performance.now(), startedAt: new Date().toISOString(),
        sessionID: event.sessionID, callID: event.callID ?? event.toolCallID ?? event.id ?? null,
        tool: event.tool, kind: category(event.tool), cancellationObservable: typeof signal?.addEventListener === "function" }
      const spans = tools.get(id) ?? []; spans.push(span); tools.set(id, spans)
      const abort = () => { void record({ event: "tool_cancel_requested", spanID: span.spanID, sessionID: span.sessionID,
        callID: span.callID, tool: span.tool, elapsedMs: performance.now() - span.start, terminalObserved: false }) }
      if (span.cancellationObservable) { signal.addEventListener("abort", abort, { once: true }); span.cleanup = () => signal.removeEventListener("abort", abort) }
      await record({ event: "tool_start", spanID: span.spanID, sessionID: span.sessionID, callID: span.callID,
        tool: span.tool, kind: span.kind, startedAt: span.startedAt, parentSessionID: meta.parentID ?? null,
        agent: meta.agent ?? null, originatingRequestID: requests.origins.get(span.callID) ?? null,
        cancellationObservable: span.cancellationObservable, additiveWithWorkerWork: span.kind !== "delegation" })
      if (signal?.aborted) abort()
    })
    await ctx.tool.hook("execute.after", async (event: any) => {
      const id = key(event), spans = tools.get(id) ?? [], span = spans.shift()
      if (!spans.length) tools.delete(id)
      span?.cleanup?.()
      const exit = event.result?.output?.exit ?? event.result?.output?.exitCode ?? event.result?.metadata?.exitCode
      const failure = event.error ?? event.result?.output?.error ?? event.result?.metadata?.error
      const nonzero = typeof exit === "number" && exit !== 0
      const status = event.status ?? "unknown"
      terminals.add(`${event.sessionID}:${event.callID ?? event.toolCallID ?? event.id ?? ""}`)
      if (terminals.size > 8192) terminals.delete(terminals.values().next().value!)
      const failed = failure != null || status !== "completed"
      await record({ event: "tool", sessionID: event.sessionID, tool: event.tool,
        callID: event.callID ?? event.toolCallID ?? event.id ?? null, spanID: span?.spanID ?? null, kind: category(event.tool),
        status, startedAt: span?.startedAt ?? null, elapsedMs: span ? performance.now() - span.start : null,
        startMissing: !span, exitCode: typeof exit === "number" ? exit : null,
        error: failed ? safe(failure?.name) ?? "tool_failed" : nonzero ? `process exited ${exit}` : null,
        errorClass: failed ? safe(failure?.name) ?? "tool_error" : nonzero ? "nonzero_exit" : null,
        // Nonzero status is not automatically a source/test failure (e.g. rg no matches).
        nonzeroExit: nonzero, terminalSource: "execute.after", parentSessionID: sessions.get(event.sessionID)?.parentID ?? null })
    })
  },
}
