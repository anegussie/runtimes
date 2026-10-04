import { createHash } from "node:crypto"
import { revision, loadLedger, coverage, rememberLoopStop } from "./lib/progress-ledger.ts"
import { record } from "./lib/telemetry.ts"
import { resolve } from "node:path"

type RepeatState = { signature: string; output: string; count: number }

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? "")).digest("hex")
const describeError = (value: unknown) => {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "message" in value) return String(value.message)
  try { return JSON.stringify(value ?? "unknown error") } catch { return String(value) }
}

// This guard only watches child sessions. It has no total tool-call budget.
export default {
  id: "repeated-child-call-guard",
  async setup(ctx: any) {
    const childSessions = new Set<string>()
    const nonChildSessions = new Set<string>()
    const repeats = new Map<string, RepeatState>()
    const readRepeats = new Map<string, Map<string, number>>()
    const stopped = new Map<string, string>()
    const preserveStop = async (sessionID: string, handoff: string) => {
      stopped.set(sessionID, handoff)
      if (stopped.size > 128) stopped.delete(stopped.keys().next().value!)
      try { await rememberLoopStop(sessionID, handoff) }
      catch (error) { await record({ event: "loop_stop_write_failed", sessionID, error: describeError(error).slice(0, 180) }) }
    }
    const readKey = async (event: any) => event.tool === "read" && event.input?.path
      ? digest([event.input.path, event.input.offset ?? 1, Math.min(event.input.limit ?? 80, 160), await revision(event.input.path)]) : null

    const signature = (tool: string, args: unknown) => digest([tool, args])
    const isChildSession = async (sessionID: string) => {
      if (childSessions.has(sessionID)) return true
      if (nonChildSessions.has(sessionID)) return false
      try {
        const info = await ctx.session.get({ sessionID })
        if (info?.parentID) {
          childSessions.add(sessionID)
          nonChildSessions.delete(sessionID)
          return true
        }
        nonChildSessions.add(sessionID)
      } catch {
        // A transient lookup failure must not block an otherwise valid tool call.
      }
      return false
    }

    await ctx.tool.hook("execute.before", async (event) => {
      if (!(await isChildSession(event.sessionID))) return
      const read = await readKey(event)
      let persistedVisits = 0
      if (read) {
        const current = await revision(event.input.path)
        const ledger = await loadLedger(event.sessionID)
        persistedVisits = ledger.reads.filter(row => row.path === resolve(event.input.path) && row.revision === current && row.start === (event.input.offset ?? 1) && row.limit === Math.min(event.input.limit ?? 80, 160)).reduce((sum, row) => sum + row.visits, 0)
      }
      const cycling = read && Math.max(readRepeats.get(event.sessionID)?.get(read) ?? 0, persistedVisits) >= 3
      const sig = read ?? signature(event.tool, event.input)
      const previous = repeats.get(event.sessionID)
      if (!cycling && (previous?.signature !== sig || previous.count < 3)) return

      const ledger = await loadLedger(event.sessionID)
      const covered = await coverage(event.sessionID)
      const evidence = `\nSession: ${event.sessionID}\nCHANGED: Unknown; interruption is not proof of completed edits.\nCHECKPOINT (historical findings; verify against current source): ${ledger.checkpoint?.slice(0, 1200) || "No saved findings available."}\nREAD COVERAGE (not proof of review or edits): ${covered.slice(0, 900) || "No current coverage recorded."}\nTESTS: No completed verification reported by this guard.\nNEXT: Report this partial result and reuse saved evidence; do not restart the same lookup or ask the user to choose a retry order.`
      await preserveStop(event.sessionID, `STATUS: PARTIAL\nCHILD_LOOP_STOP_REQUESTED: repeated-read/tool loop; interruption requested.${evidence}`)
      try {
        await ctx.session.interrupt({ sessionID: event.sessionID, continue: false })
      } catch (error) {
        await preserveStop(event.sessionID, `STATUS: PARTIAL\nCHILD_LOOP_ABORT_FAILED: ${describeError(error).slice(0, 180)}; repeated tool blocked, child interruption not confirmed.${evidence}`)
        throw new Error(`CHILD_LOOP_ABORT_FAILED: OpenCode could not interrupt this child session (${describeError(error)}); the repeated tool was blocked and the parent must return PARTIAL.`)
      }
      await preserveStop(event.sessionID, `STATUS: PARTIAL\nCHILD_LOOP_ABORTED: ${read ? "repeated-read" : "repeated-tool"} loop stopped.${evidence}`)
      await record({ event: "child_loop_stopped", sessionID: event.sessionID, tool: event.tool, reason: read ? "cyclic_reread" : "identical_results" })
      throw new Error("CHILD_LOOP_ABORTED: repeated unchanged evidence, including cyclic rereads. Return STATUS: PARTIAL with accumulated findings; do not restart discovery.")
    })

    // Native interruption discards the thrown hook error. Restore the reason
    // only for the matching failed delegation in the actual model transcript.
    if (ctx.session?.hook) await ctx.session.hook("context", async (event: any) => {
      for (const message of event.messages ?? []) {
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part.type !== "tool-result" || !["subagent", "task"].includes(part.name ?? part.tool)) continue
          if (!["error", "error-text", "error-json"].includes(part.result?.type)) continue
          const value = part.result.value
          const child = (typeof value === "string" ? value : JSON.stringify(value ?? "")).match(/Subagent cancelled \(sessionID: ([A-Za-z0-9_-]+)\)/)?.[1]
          if (!child) continue
          const handoff = stopped.get(child) ?? (await loadLedger(child)).loopStop
          if (!handoff) continue
          if (part.result.type === "error" && value && typeof value === "object") {
            part.result = { type: "error", value: {
              ...value, error: { ...value.error, message: handoff },
              content: [...(Array.isArray(value.content) ? value.content : []), { type: "text", text: handoff }],
            } }
          } else {
            part.result = { ...part.result, value: part.result.type === "error-json" ? { error: handoff } : handoff }
          }
        }
      }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || !childSessions.has(event.sessionID)) return
      const read = await readKey(event)
      if (read) {
        const visits = readRepeats.get(event.sessionID) ?? new Map<string, number>()
        visits.set(read, (visits.get(read) ?? 0) + 1)
        readRepeats.set(event.sessionID, visits)
      }
      const sig = read ?? signature(event.tool, event.input)
      const previous = repeats.get(event.sessionID)
      const result = event.result && typeof event.result === "object"
        ? event.result as { output?: string; title?: string; metadata?: unknown }
        : { output: String(event.result ?? "") }
      const outputSig = digest(result)
      const count = previous?.signature === sig && previous.output === outputSig ? previous.count + 1 : 1
      repeats.set(event.sessionID, { signature: sig, output: outputSig, count })

      if (count === 3) {
        // Preserve structured v2 output; do not stringify it as [object Object].
        if (typeof result.output === "string") result.output += "\n\nREPEAT_GUARD: Reuse this evidence and return findings. Do not repeat the call."
        console.warn(`[REPEAT_GUARD] session=${event.sessionID} tool=${event.tool} identical_results=${count}`)
      }
    })
  },
}
