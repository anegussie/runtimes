import { record } from "./lib/telemetry.ts"
import { rememberRead, revision } from "./lib/progress-ledger.ts"

// A byte budget controls context growth; returned offsets are explicit.
export default {
  id: "read-window-default",
  async setup(ctx: any) {
    const pending = new Map<string, any[]>()
    const boundedResults = new Map<string, string>()
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "read") return
      const input = event.input as { path?: string; offset?: number; limit?: number | null }
      const rows = pending.get(event.sessionID) ?? []
      rows.push({ path: input.path, offset: Math.max(1, input.offset ?? 1), requested: input.limit ?? 80, revision: input.path ? await revision(input.path) : "unavailable" })
      pending.set(event.sessionID, rows)
      if (input.limit == null) input.limit = 80
      else if (typeof input.limit === "number" && input.limit > 160) input.limit = 160
    })
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "read") return
      const rows = pending.get(event.sessionID) ?? []
      const index = rows.findIndex(row => row.path === event.input?.path && row.offset === Math.max(1, event.input?.offset ?? 1))
      const requested = rows.splice(index < 0 ? 0 : index, 1)[0]
      if (!rows.length) pending.delete(event.sessionID)
      const result = event.result
      if (event.status !== "completed" || !result) return
      const structured = result.output && typeof result.output === "object" && result.output.type === "text"
      let output = typeof result.output === "string" ? result.output
        : (result.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
      if (!output) return
      let byteLimited = false
      let partialLine = false
      const kept: string[] = []
      let bytes = 0
      for (const line of output.split("\n")) {
        const size = Buffer.byteLength(line + "\n")
        if (bytes + size > 7200) {
          byteLimited = true
          if (!kept.some(line => /^\d+:/.test(line))) {
            let excerpt = line
            while (Buffer.byteLength(excerpt) > Math.max(0, 6800 - bytes)) excerpt = excerpt.slice(0, Math.max(0, excerpt.length - 256))
            kept.push(`${excerpt} [PARTIAL SOURCE LINE: remainder omitted]`)
            partialLine = true
          }
          break
        }
        kept.push(line); bytes += size
      }
      if (byteLimited) output = kept.join("\n")
      const header = output.match(/lines (\d+)-(\d+)/)
      const numbered = [...output.matchAll(/^(\d+):/gm)]
      const first = header ? Number(header[1]) : numbered.length ? Number(numbered[0][1]) : null
      const last = numbered.length ? Number(numbered.at(-1)![1]) : header ? Number(header[2]) : null
      if (first != null && last != null) {
        if (byteLimited && header) output = output.replace(header[0], `lines ${first}-${last}`)
        const more = byteLimited || result.output?.truncated === true || result.metadata?.truncated === true || /Output truncated|Continue reading with offset/i.test(output) || (requested && requested.requested > 160 && last - first + 1 >= 160)
        const notice = `READ_WINDOW: returned=${first}-${last}; requested_limit=${requested?.requested ?? "unknown"}; next_offset=${more && !partialLine ? last + 1 : "none"}; byte_limited=${byteLimited}; partial_line=${partialLine}. ${partialLine ? "This line is NOT fully read. Use a targeted substring/search or byte slice; another line read cannot recover its remainder." : "Use returned offsets. Read further only within assigned scope; reuse covered ranges."}`
        const raw = byteLimited ? output.split("\n").filter(line => /^\d+:/.test(line)).map(line => line.replace(/^\d+: ?/, "")).join("\n") : result.output?.content
        output += `\n\n${notice}`
        // Hooks share the result object; replacing event.result in a callback
        // does not update the caller's reference in OpenCode v2.
        Object.assign(result, {
          output: structured ? { ...result.output, content: `${raw ?? ""}\n\n${notice}`, offset: first, next: more && !partialLine ? last + 1 : null, truncated: Boolean(more) } : output,
          content: structured ? [{ type: "text", text: output }] : result.content,
          metadata: { ...result.metadata, truncated: Boolean(more), returnedStart: first, returnedEnd: last, nextOffset: more && !partialLine ? last + 1 : null, byteLimited, partialLine } })
        if (event.input?.path) {
          try {
            const current = await revision(event.input.path)
            if (current !== "unavailable" && current === requested?.revision) await rememberRead(event.sessionID, { path: event.input.path, revision: current, start: first, end: last, partial: partialLine, limit: Math.min(requested.requested, 160) })
          }
          catch (error) { await record({ event: "progress_write_failed", sessionID: event.sessionID, error: String(error).slice(0, 180) }) }
        }
        const callID = event.callID ?? event.toolCallID ?? event.id
        if (callID) {
          boundedResults.set(callID, output)
          if (boundedResults.size > 2048) boundedResults.delete(boundedResults.keys().next().value!)
        }
        await record({ event: "read_window", sessionID: event.sessionID, path: event.input?.path, requestedLimit: requested?.requested, returnedStart: first, returnedEnd: last, nextOffset: more ? last + 1 : null, byteLimited, outputBytes: Buffer.byteLength(output) })
      } else if (byteLimited) {
        output += "\nREAD_WINDOW: partial output; no reliable line offsets. Use a targeted search/substring, not an identical read."
        Object.assign(result, { output: structured ? { ...result.output, content: output, truncated: true, next: null } : output,
          content: [{ type: "text", text: output }], metadata: { ...result.metadata, truncated: true, partialLine: true, byteLimited: true } })
        const id = event.callID ?? event.toolCallID ?? event.id
        if (id) boundedResults.set(id, output)
      }
    })
    if (ctx.session?.hook) await ctx.session.hook("context", async (event: any) => {
      // Native tools can publish their saved UI state before execute.after.
      // Apply the same bounded result to the actual model transcript as well.
      let changed = 0
      for (const message of event.messages ?? []) {
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part.type !== "tool-result") continue
          let output = boundedResults.get(part.id ?? part.toolCallID ?? part.toolCallId)
          if (!output && (part.name === "read" || part.tool === "read") && typeof part.result?.value === "string" && Buffer.byteLength(part.result.value) > 8000) {
            output = part.result.value
            while (Buffer.byteLength(output) > 7000) output = output.slice(0, Math.max(0, output.length - 256))
            output += "\nREAD_WINDOW: partial historical output; omitted remainder is not read coverage. Use targeted search if needed."
          }
          if (!output) continue
          part.result = { type: "text", value: output }
          changed++
        }
      }
      if (changed) await record({ event: "read_context", sessionID: event.sessionID, boundedResults: changed })
    })
  },
}
