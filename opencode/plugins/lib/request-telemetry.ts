import { randomUUID } from "node:crypto"
import { telemetryContext } from "./telemetry.ts"

const LIMIT = 256 * 1024
const bounded = (value: unknown) => typeof value === "string" ? value.slice(0, 160) : undefined
const numeric = (object: any) => Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v)))

// One reader, no tee/background draining: observing a response preserves its
// backpressure, bytes and cancellation. No prompts/output/arguments are logged.
export class RequestTelemetry {
  active = new Map<string, any>()
  origins = new Map<string, string>()
  private emit: (event: any) => Promise<void>
  private now: () => number
  constructor(emit: (event: any) => Promise<void>, now = () => performance.now()) { this.emit = emit; this.now = now }
  async before(event: any, context: any = {}) {
    const request: Request = event.request
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return
    const input = await request.clone().json()
    const inherited = telemetryContext.getStore() ?? {}
    if (this.active.size >= 1024) {
      const oldest = this.active.values().next().value
      await this.finish(oldest, "unresolved_tracker_limit", { terminalObserved: false })
    }
    const id = randomUUID(), headers = new Headers(request.headers)
    const meta = { requestID: id, sessionID: bounded(event.sessionID ?? inherited.sessionID),
      parentSessionID: bounded(context.parentID), agent: bounded(context.agent),
      providerID: bounded(event.model?.providerID), modelID: bounded(event.model?.id),
      kind: inherited.kind ?? event.kind ?? "unknown", enclosingSpanID: inherited.spanID }
    for (const [key, value] of Object.entries({ "x-opencode-request-id": id, "x-opencode-session-id": meta.sessionID,
      "x-opencode-parent-session-id": meta.parentSessionID, "x-opencode-agent": meta.agent, "x-opencode-request-kind": meta.kind })) {
      if (typeof value === "string" && /^[\w.:-]{1,160}$/.test(value)) headers.set(key, value)
    }
    if (input.stream === true) input.stream_options = { ...input.stream_options, include_usage: true }
    headers.delete("content-length")
    event.request = new Request(request, { headers, body: JSON.stringify(input) })
    const state: any = { ...meta, start: this.now(), first: null, bytes: 0, events: 0, keepalives: 0,
      contentCharacters: 0, reasoningCharacters: 0, argumentCharacters: 0, toolIDs: new Set<string>(),
      finishReasons: new Set<string>(), usage: {}, timings: {}, parseErrors: 0, oversizedFrames: 0, ended: false, done: false }
    this.active.set(id, state)
    const signal = event.request.signal
    const abort = () => { void this.finish(state, "cancelled", { cancellationObserved: true }) }
    state.cleanup = () => signal.removeEventListener("abort", abort)
    await this.emit({ event: "llm_request_start", ...meta, startedAt: new Date().toISOString(), stream: input.stream === true,
      requestedMaxTokens: input.max_tokens ?? input.max_completion_tokens ?? null,
      requestedReasoningEffort: input.reasoning_effort ?? input.reasoningEffort ?? null,
      requestedEnableThinking: input.chat_template_kwargs?.enable_thinking ?? null,
      messageCount: input.messages?.length ?? 0, offeredToolCount: input.tools?.length ?? 0,
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(input.tools ?? [])),
      timingScope: "client_request_envelope", additiveWithNativeStages: false })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  }
  async finish(state: any, outcome: string, extra: any = {}) {
    if (state.ended) return
    state.ended = true; state.cleanup?.(); this.active.delete(state.requestID)
    const { start, first, toolIDs, finishReasons, cleanup, ended, ...fields } = state
    await this.emit({ event: "llm_request_end", ...fields, outcome, endedAt: new Date().toISOString(), elapsedMs: this.now() - start,
      firstMeaningfulTokenMs: first == null ? null : first - start, generatedToolCalls: toolIDs.size,
      finishReasons: [...finishReasons], transportDoneObserved: state.done, ...extra })
  }
  observe(state: any, envelope: any) {
    if (envelope?.usage) state.usage = { ...numeric(envelope.usage),
      prompt_tokens_details: numeric(envelope.usage.prompt_tokens_details),
      completion_tokens_details: numeric(envelope.usage.completion_tokens_details) }
    if (envelope?.timings) state.timings = numeric(envelope.timings)
    if (typeof envelope?.id === "string") state.responseID = bounded(envelope.id)
    for (const choice of envelope?.choices ?? []) {
      const delta = choice.delta ?? choice.message ?? {}
      const text = delta.content, reasoning = delta.reasoning_content ?? delta.reasoning
      const meaningful = (typeof text === "string" && text.length) || (typeof reasoning === "string" && reasoning.length) || delta.tool_calls?.length
      if (meaningful && state.first == null) state.first = this.now()
      if (typeof text === "string") state.contentCharacters += text.length
      if (typeof reasoning === "string") state.reasoningCharacters += reasoning.length
      for (const call of delta.tool_calls ?? []) {
        state.toolIDs.add(`${choice.index ?? 0}:${call.index ?? call.id ?? 0}`)
        if (call.id) { this.origins.set(call.id, state.requestID); if (this.origins.size > 4096) this.origins.delete(this.origins.keys().next().value!) }
        if (typeof call.function?.arguments === "string") state.argumentCharacters += call.function.arguments.length
      }
      if (typeof choice.finish_reason === "string") state.finishReasons.add(bounded(choice.finish_reason))
    }
  }
  async response(event: any) {
    const id = event.request.headers.get("x-opencode-request-id"), state = this.active.get(id)
    if (!state) return
    const response: Response = event.response
    let input: any = {}
    try { input = await event.request.clone().json() } catch { state.sentParametersUnavailable = true }
    state.httpStatus = response.status; state.responseHeadersMs = this.now() - state.start
    await this.emit({ event: "llm_response_headers", requestID: id, sessionID: state.sessionID, kind: state.kind,
      httpStatus: response.status, elapsedMs: state.responseHeadersMs,
      sentMaxTokens: event.request.headers.has("x-opencode-effective-max-tokens") ? Number(event.request.headers.get("x-opencode-effective-max-tokens")) : input.max_tokens ?? input.max_completion_tokens ?? null,
      sentReasoningEffort: event.request.headers.get("x-opencode-effective-reasoning-effort") ?? input.reasoning_effort ?? null,
      sentEnableThinking: event.request.headers.get("x-opencode-effective-thinking") === "false" ? false : input.chat_template_kwargs?.enable_thinking ?? null })
    if (!response.body) { await this.finish(state, response.ok ? "empty" : "http_error"); return }
    const reader = response.body.getReader(), decoder = new TextDecoder()
    const sse = response.headers.get("content-type")?.includes("text/event-stream")
    let pending = ""
    const parse = (text: string) => {
      if (text === "[DONE]") { state.done = true; return }
      try { this.observe(state, JSON.parse(text)) } catch { state.parseErrors++ }
    }
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const next = await reader.read()
          if (next.done) {
            pending += decoder.decode()
            if (!sse && pending) parse(pending)
            await this.finish(state, !response.ok ? "http_error" : sse && !state.done ? "eof_without_done" : "completed")
            controller.close(); return
          }
          state.bytes += next.value.byteLength
          pending += decoder.decode(next.value, { stream: true })
          if (pending.length > LIMIT) { state.oversizedFrames++; pending = "" }
          if (sse) {
            let boundary
            while ((boundary = /\r?\n\r?\n/.exec(pending))) {
              const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length)
              if (frame.startsWith(":")) state.keepalives++
              const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")
              if (data) { state.events++; parse(data) }
            }
            if (state.done) await this.finish(state, response.ok ? "completed" : "http_error")
          }
          controller.enqueue(next.value)
        } catch (error: any) {
          await this.finish(state, "stream_error", { errorClass: bounded(error?.name) ?? "Error" })
          controller.error(error)
        }
      },
      cancel: async reason => {
        await this.finish(state, "cancelled", { cancellationObserved: true })
        await reader.cancel(reason)
      },
    })
    event.response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  snapshot() { return [...this.active.values()].map(s => ({ requestID: s.requestID, sessionID: s.sessionID, kind: s.kind,
    phase: s.first != null ? "streaming" : s.responseHeadersMs != null ? "awaiting_first_token" : "awaiting_response_headers",
    ageMs: this.now() - s.start, receivedBytes: s.bytes, contentCharacters: s.contentCharacters, reasoningCharacters: s.reasoningCharacters })) }
}
