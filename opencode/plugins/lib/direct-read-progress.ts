import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { revision } from "./progress-ledger.ts"
import { record } from "./telemetry.ts"

type Read = { path: string; revision: string; start: number; limit: number; end?: number }
type File = { revision: string; reads: Read[]; targeted: boolean }
type State = { user: string; latest: string; files: Map<string, File>; compacting: boolean; stopped?: Read }
const textOf = (value: any): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map(textOf).join("\n") : value?.text ?? ""
const callKey = (e: any) => `${e.sessionID}:${e.callID ?? e.toolCallID ?? e.id ?? ""}`

function repeatedLines(start: number, end: number, reads: Read[]) {
  const points = new Map<number, number>()
  for (const row of reads) {
    if (row.end == null || row.end < row.start) continue
    points.set(row.start, (points.get(row.start) ?? 0) + 1)
    points.set(row.end + 1, (points.get(row.end + 1) ?? 0) - 1)
  }
  let count = 0, previous = 0, repeated = 0
  for (const [point, delta] of [...points].sort((a,b) => a[0]-b[0])) {
    if (count >= 2) repeated += Math.max(0, Math.min(point,end+1)-Math.max(previous,start))
    previous = point; count += delta
  }
  return repeated
}

// Source-window repetition, not a total tool budget. A checkpoint retains this
// history while granting one small reread per file for missing working text.
export function directReadProgress() {
  const sessions = new Map<string, State>()
  const pending = new Map<string, { state: State; file: File; read: Read; targeted: boolean }>()
  return {
    async context(event: any) {
      if (event.model?.providerID !== "local-llama" || event.agent !== "general") {
        sessions.delete(event.sessionID); return
      }
      const users = (event.messages ?? []).filter((m: any) => m.role === "user")
      const latest = users.at(-1)
      const text = textOf(latest?.content)
      const user = JSON.stringify([users.length, latest?.id ?? text])
      let state = sessions.get(event.sessionID)
      if (state?.compacting) {
        const checkpoint = text.startsWith("## Binding user instructions (verbatim; authoritative)")
          || (text.startsWith("<conversation-checkpoint>\n") && text.includes("\n<summary>\n"))
        if (text === state.latest || checkpoint) state.user = user
        state.compacting = false
      }
      if (!state || state.user !== user) {
        state = { user, latest: text, files: new Map(), compacting: false }
        sessions.set(event.sessionID, state)
      }
      state.latest = text
      if (sessions.size > 128) sessions.delete(sessions.keys().next().value!)
      if (state.stopped && await revision(state.stopped.path) !== state.stopped.revision) state.stopped = undefined
      if (!state.stopped) return
      const instruction = `DIRECT_READ_PROGRESS_STOP: Repeated reads of unchanged source made no source progress. Do not restart a whole-file walkthrough. Retain the actual findings and unresolved checks. Use an existing project-local structural check or a bounded grep to resolve a concrete question, then make the smallest authorized edit and verify it. A targeted read of at most 40 lines is available once per file/checkpoint when necessary source text is absent; new ranges and changed source remain readable. Read coverage is not retained source text or proof of review. If essential evidence is still missing, report the actual partial result and blocker. Affected path (data): ${JSON.stringify(state.stopped.path)}`
      if (!event.messages.some((m: any) => m.role === "system" && textOf(m.content) === instruction))
        event.messages.push({ role: "system", content: [{ type: "text", text: instruction }] })
    },
    async compaction(event: any) {
      const state = sessions.get(event.sessionID)
      if (!state) return
      state.compacting = true
      for (const file of state.files.values()) file.targeted = false
    },
    async before(event: any) {
      const state = sessions.get(event.sessionID)
      if (!state || event.tool !== "read" || typeof event.input?.path !== "string") return
      if (!(event.callID ?? event.toolCallID ?? event.id)) return
      if (pending.has(callKey(event))) return
      const start = event.input.offset ?? 1, limit = Math.min(event.input.limit ?? 80, 160)
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(start+limit)) return
      let path: string
      try { path = await realpath(resolve(event.input.path)) } catch { return }
      const current = await revision(path)
      if (current === "unavailable") return
      let file = state.files.get(path)
      if (!file || file.revision !== current) {
        file = { revision: current, reads: [], targeted: false }; state.files.set(path,file)
      }
      if (state.files.size > 128) state.files.delete(state.files.keys().next().value!)
      const exact = file.reads.filter(row => row.start === start && row.limit === limit).length >= 2
      const overlapping = repeatedLines(start,start+limit-1,file.reads) / limit >= 0.8
      const targeted = (exact || overlapping) && limit <= 40 && !file.targeted
      if ((exact || overlapping) && !targeted) {
        state.stopped = { path, revision: current, start, limit }
        await record({ event: "direct_read_progress_stopped", sessionID: event.sessionID, path, offset: start, limit, exactRepeat: exact })
        throw new Error("DIRECT_READ_PROGRESS_STOP: This unchanged read window was already returned twice. Do not repeat the walkthrough. Reuse reported findings and run a project-local structural check or bounded search; make and verify the smallest authorized fix. If necessary text is absent, request one targeted read of at most 40 lines, or report PARTIAL with the missing evidence.")
      }
      if (targeted) file.targeted = true
      pending.set(callKey(event), { state, file, read: { path, revision: current, start, limit }, targeted })
      if (pending.size > 256) pending.delete(pending.keys().next().value!)
    },
    async after(event: any) {
      if (event.tool !== "read") return
      const entry = pending.get(callKey(event)); pending.delete(callKey(event))
      if (!entry || sessions.get(event.sessionID) !== entry.state) return
      if (event.status !== "completed" || event.error || await revision(entry.read.path) !== entry.read.revision) {
        if (entry.targeted) entry.file.targeted = false
        return
      }
      const result = event.result
      const text = typeof result?.output === "string" ? result.output : textOf(result?.content)
      const numbered = [...text.matchAll(/^(\d+):/gm)]
      const first = result?.metadata?.returnedStart ?? (numbered.length ? Number(numbered[0][1]) : undefined)
      let last = result?.metadata?.returnedEnd ?? (numbered.length ? Number(numbered.at(-1)![1]) : undefined)
      const partial = result?.metadata?.partialLine || /PARTIAL SOURCE LINE/.test(text)
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first !== entry.read.start || last < first) {
        if (entry.targeted) entry.file.targeted = false
        return
      }
      if (partial) last--
      // Exact repetition of partial output is still unproductive; only fully
      // returned lines participate in the overlapping-coverage calculation.
      entry.read.end = Math.min(last,entry.read.start+entry.read.limit-1)
      entry.file.reads.push(entry.read)
      if (entry.file.reads.length > 512) entry.file.reads.shift()
    },
  }
}
