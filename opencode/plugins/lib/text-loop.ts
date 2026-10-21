// Detect repeated short action promises, not code, quoted source or tool JSON.
// State belongs to one response: productive tool calls start a fresh response.
export class TextLoopDetector {
  private pending = ""
  private fenced = false
  private recent: string[] = []
  feed(text: string): boolean {
    this.pending += text
    let end: number
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + 1)
      if (/^\s*(?:```|~~~)/.test(line)) { this.fenced = !this.fenced; this.recent = []; continue }
      if (this.fenced) continue
      for (const sentence of line.split(/(?<=[.!?])\s+/)) if (this.inspect(sentence)) return true
    }
    // A stream need not contain newlines. Consume complete prose sentences.
    if (!this.fenced && !/^\s*(?:```|~~~)/.test(this.pending)) {
      const sentences = this.pending.split(/(?<=[.!?])\s+/)
      this.pending = sentences.pop() ?? ""
      for (const sentence of sentences) if (this.inspect(sentence)) return true
    }
    // Bound incomplete lines; long source/prose is not a short-action loop.
    if (this.pending.length > 2048) { this.pending = ""; this.recent = [] }
    return false
  }
  private inspect(sentence: string): boolean {
    const text = sentence.trim().toLowerCase().replace(/[’]/g, "'").replace(/[`.,!?;:]/g, "").replace(/\s+/g, " ")
    if (!text) return false
    const action = text.length <= 220 && /^(?:i(?:'ll| will| need to| have to)|let me|reading\b|executing\b)/.test(text)
      && /\b(?:read|write|execute|run|check|open|inspect|call|do|reading|executing)\b/.test(text)
    this.recent.push(action ? text : "")
    this.recent = this.recent.slice(-24)
    const plans = this.recent.filter(Boolean)
    if (plans.length < 12 || plans.length < this.recent.length * 0.8) return false
    const unique = new Set(plans)
    const most = Math.max(...[...unique].map(value => plans.filter(item => item === value).length))
    return most >= 4 || (plans.length >= 18 && unique.size <= plans.length * 0.7)
  }
}

// Inspect only OpenAI content deltas. Preserve all other SSE bytes unchanged.
// On a loop, cancel the provider stream and terminate with a factual handoff.
export function guardTextStream(response: Response, onStop: () => Promise<string>): Response {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const detector = new TextLoopDetector()
  let pending = "", ended = false, toolSeen = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(pending)
          if (boundary) {
            const end = boundary.index + boundary[0].length
            const frame = pending.slice(0, end)
            pending = pending.slice(end)
            const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
            let loop = false, envelope: any
            if (data && data !== "[DONE]") {
              try { envelope = JSON.parse(data) } catch { /* Preserve non-JSON frames. */ }
              for (const choice of envelope?.choices ?? []) {
                if (choice.delta?.tool_calls?.length || choice.delta?.function_call) toolSeen = true
                if (!toolSeen && typeof choice.delta?.content === "string") loop ||= detector.feed(choice.delta.content)
              }
            }
            if (loop) {
              ended = true
              // Initiate cancellation before ledger I/O, stopping generation now.
              const cancellation = reader.cancel("CHILD_LOOP_ABORTED: repeated text without tool calls").catch(() => {})
              const handoff = await onStop()
              const chunk = (delta: any, finish_reason: string | null) => `data: ${JSON.stringify({
                id: envelope?.id ?? "text-loop-stop", object: "chat.completion.chunk", created: envelope?.created ?? 0,
                model: envelope?.model ?? "local", choices: [{ index: 0, delta, finish_reason }],
              })}\n\n`
              controller.enqueue(encoder.encode(chunk({ content: `\n\n${handoff}` }, null) + chunk({}, "stop") + "data: [DONE]\n\n"))
              controller.close()
              // Cancellation may finish after the replacement handoff is read.
              void cancellation
              return
            }
            controller.enqueue(encoder.encode(frame))
            return
          }
          if (ended) {
            if (pending) controller.enqueue(encoder.encode(pending))
            controller.close(); return
          }
          const next = await reader.read()
          if (next.done) { ended = true; pending += decoder.decode() }
          else pending += decoder.decode(next.value, { stream: true })
        }
      } catch (error) {
        void reader.cancel(error).catch(() => {})
        controller.error(error)
      }
    },
    async cancel(reason) { await reader.cancel(reason) },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
