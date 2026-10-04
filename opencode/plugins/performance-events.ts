import { record } from "./lib/telemetry.ts"

export default {
  id: "performance-events",
  async setup(ctx: any) {
    const pending = new Map<string, number[]>()
    const key = (event: any) => `${event.sessionID}:${event.tool}:${event.callID ?? event.toolCallID ?? event.id ?? ""}`
    await ctx.tool.hook("execute.before", (event: any) => {
      const id = key(event)
      const starts = pending.get(id) ?? []
      starts.push(Date.now()); pending.set(id, starts)
    })
    await ctx.tool.hook("execute.after", async (event: any) => {
      const id = key(event), starts = pending.get(id) ?? []
      const started = starts.shift()
      if (!starts.length) pending.delete(id)
      const exit = event.result?.output?.exit ?? event.result?.output?.exitCode ?? event.result?.metadata?.exitCode
      const failure = event.error ?? event.result?.output?.error ?? event.result?.metadata?.error ?? (typeof exit === "number" && exit !== 0 ? `process exited ${exit}` : null)
      const error = failure == null ? (event.status === "completed" ? null : "tool failed")
        : String(failure.message ?? (typeof failure === "string" ? failure : JSON.stringify(failure))).slice(0, 180)
      await record({ event: "tool", sessionID: event.sessionID, tool: event.tool,
        callID: event.callID ?? event.toolCallID ?? event.id ?? null,
        status: event.status, elapsedMs: started == null ? null : Date.now() - started,
        resultKeys: event.result && typeof event.result === "object" ? Object.keys(event.result) : [],
        outputType: typeof event.result?.output,
        outputKeys: event.result?.output && typeof event.result.output === "object" ? Object.keys(event.result.output) : [],
        nestedToolCalls: (event.result?.output?.toolCalls ?? []).slice(0, 50).map((call: any) => ({ tool: call.tool ?? call.name, status: call.status })),
        error })
    })
  },
}
