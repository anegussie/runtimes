import { createHash } from "node:crypto"
import { revision, loadLedger, coverage, rememberLoopStop, rememberChange, beginReadEpoch } from "./lib/progress-ledger.ts"
import { record } from "./lib/telemetry.ts"
import { resolve } from "node:path"
import { guardTextStream } from "./lib/text-loop.ts"
import { ReviewProgress, reviewKey, textOf } from "./lib/review-progress.ts"

type RepeatState = { signature: string; output: string; count: number; readVisits: number; tool: string; evidence: string }

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? "")).digest("hex")
const describeError = (value: unknown) => {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "message" in value) return String(value.message)
  try { return JSON.stringify(value ?? "unknown error") } catch { return String(value) }
}

// Keep raw payloads out of performance telemetry. Only a bounded, redacted
// excerpt of the actual completed tool enters the cancellation handoff.
const excerpt = (value: unknown, limit: number) => String(value ?? "")
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
  .replace(/((?:api[_-]?key|token|password|secret|authorization)[\w-]*["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1[REDACTED]")
  .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, limit)
const toolEvidence = (event: any) => {
  const result = event.result
  const output = result?.output
  const text = typeof output === "string" ? output
    : (result?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
      || [output?.stdout, output?.stderr, output?.content].filter(value => typeof value === "string").join("\n")
  const exit = output?.exit ?? output?.exitCode ?? result?.metadata?.exitCode ?? result?.metadata?.exit
  const detail = event.tool === "read" ? `path=${excerpt(event.input?.path, 300)}; offset=${event.input?.offset ?? 1}; limit=${Math.min(event.input?.limit ?? 80, 160)}`
    : `exit=${typeof exit === "number" ? exit : "unknown"}`
  return `LAST COMPLETED TOOL (observed result, not a completion claim): ${event.tool}; ${detail}\nINPUT: ${excerpt(event.input?.command ?? JSON.stringify(event.input ?? {}), 520)}\nRESULT: ${excerpt(text, 400) || "[no text returned]"}`
}

// Tool repetition is child-only; prose stream repetition covers parents too.
// Neither guard has a total tool-call budget.
export default {
  id: "repeated-child-call-guard",
  async setup(ctx: any) {
    const childSessions = new Set<string>()
    const nonChildSessions = new Set<string>()
    const repeats = new Map<string, RepeatState>()
    const readRepeats = new Map<string, Map<string, number>>()
    const stopped = new Map<string, string>()
    const reviews = new Map<string, ReviewProgress>()
    const preserveStop = async (sessionID: string, handoff: string) => {
      stopped.set(sessionID, handoff)
      if (stopped.size > 128) stopped.delete(stopped.keys().next().value!)
      try { await rememberLoopStop(sessionID, handoff) }
      catch (error) { await record({ event: "loop_stop_write_failed", sessionID, error: describeError(error).slice(0, 180) }) }
    }
    const readKey = async (event: any) => event.tool === "read" && event.input?.path
      ? digest([event.input.path, event.input.offset ?? 1, Math.min(event.input.limit ?? 80, 160), await revision(event.input.path)]) : null
    const persistedReadVisits = (ledger: Awaited<ReturnType<typeof loadLedger>>, input: any, current: string) => ledger.reads
      .filter(row => row.path === resolve(input.path) && row.revision === current && row.start === (input.offset ?? 1)
        && row.limit === Math.min(input.limit ?? 80, 160) && (row.epoch ?? 0) === (ledger.readEpoch ?? 0))
      .reduce((sum, row) => sum + (row.epochVisits ?? row.visits), 0)

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

    await ctx.session.hook("compaction", async (event: any) => {
      if (!(await isChildSession(event.sessionID))) return
      reviews.delete(event.sessionID)
      await beginReadEpoch(event.sessionID)
      readRepeats.delete(event.sessionID)
      if (repeats.get(event.sessionID)?.tool === "read") repeats.delete(event.sessionID)
    })

    await ctx.session.hook("http.response", async (event: any) => {
      if (event.kind !== "primary" || event.model?.providerID !== "local-llama"
        || !new URL(event.request.url).pathname.endsWith("/chat/completions")
        || !event.response.ok || !event.response.body
        || !event.response.headers.get("content-type")?.includes("text/event-stream")) return
      const child = await isChildSession(event.sessionID)
      event.response = guardTextStream(event.response, async () => {
        if (!child) {
          const handoff = `STATUS: PARTIAL\nPARENT_LOOP_ABORTED: repeated action promises without tool calls; provider stream stopped.\nCHANGED/CHECKS: This response issued no tool calls and proves no new edit or verification. Earlier worker findings remain in this session.\nNEXT: Report the unfinished task and the actual blocker; do not claim completion or automatically relaunch the failed scope.`
          await record({ event: "parent_loop_stopped", sessionID: event.sessionID, reason: "repeated_text_without_tools" })
          return handoff
        }
        const handoff = `STATUS: PARTIAL\nCHILD_LOOP_ABORTED: repeated text without tool calls; provider stream stopped.\nSession: ${event.sessionID}\nCHANGED/CHECKS: This response issued no tool calls; it proves no new edit or verification. Earlier work, if any, remains recorded in this session.\nNEXT: Report the unfinished assignment and saved findings. Do not claim completion or automatically relaunch the failed scope.`
        await preserveStop(event.sessionID, handoff)
        await record({ event: "child_loop_stopped", sessionID: event.sessionID, reason: "repeated_text_without_tools" })
        return handoff
      })
    })

    await ctx.tool.hook("execute.before", async (event) => {
      if (!(await isChildSession(event.sessionID))) return
      const read = await readKey(event)
      let persistedVisits = 0
      if (read) {
        const current = await revision(event.input.path)
        const ledger = await loadLedger(event.sessionID)
        persistedVisits = persistedReadVisits(ledger, event.input, current)
      }
      const cycling = read && Math.max(readRepeats.get(event.sessionID)?.get(read) ?? 0, persistedVisits) >= 3
      const sig = read ?? signature(event.tool, event.input)
      const previous = repeats.get(event.sessionID)
      if (!cycling && (previous?.signature !== sig || previous.count < 3)) return

      const ledger = await loadLedger(event.sessionID)
      const covered = await coverage(event.sessionID)
      const changed = ledger.changes?.length ? ledger.changes.slice(-2).map(change => change.evidence).join("\n").slice(0, 400) + " (execution observed; correctness not established)" : "Unknown; interruption is not proof of completed edits."
      const evidence = `\nSession: ${event.sessionID}\nCHANGED: ${changed}\n${previous?.evidence.slice(0, 1000) ?? "No completed tool result retained."}\nCHECKPOINT (historical findings; verify against current source): ${ledger.checkpoint?.slice(0, 650) || "No saved findings available."}\nREAD COVERAGE (not proof of review or edits): ${covered.slice(0, 350) || "No current coverage recorded."}\nTESTS: The observed tool result above does not establish full task verification.\nNEXT: Report this partial result and reuse saved evidence; do not restart the same lookup or ask the user to choose a retry order.`
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
      if (event.sessionID && await isChildSession(event.sessionID)) {
        const user = [...(event.messages ?? [])].reverse().find((message: any) => message.role === "user")
        const key = reviewKey(textOf(user?.content))
        if (!key) reviews.delete(event.sessionID)
        else if (reviews.get(event.sessionID)?.key !== key) {
          reviews.set(event.sessionID, new ReviewProgress(key))
          if (reviews.size > 128) reviews.delete(reviews.keys().next().value!)
        }
        if ((reviews.get(event.sessionID)?.stale ?? 0) >= 4) event.messages.push({ role: "system", content: [{ type: "text", text:
          "REVIEW_EVIDENCE_STALLED: Recent completed reads/searches returned already-covered lines or repeated negative results for unchanged source. Return supported findings and missing verification now, or perform one targeted behavioral/check tool resolving a named remaining question. Fresh ranges, source changes, and a new user-assigned review lens remain allowed. This review does not authorize edits. Continued unchanged research will stop with a factual PARTIAL handoff." }] })
      }
      const repeated = repeats.get(event.sessionID)
      if (repeated && Math.max(repeated.count, repeated.readVisits) >= 2 && !stopped.has(event.sessionID)) {
        // Native shell output is structured; mutating output only when it is
        // a string silently loses the warning. Context is model-visible for
        // both output shapes and leaves exit codes and tool content intact.
        event.messages.push({ role: "system", content: [{ type: "text", text:
          `REPEAT_GUARD: ${repeated.readVisits >= 2 ? `read returned this unchanged source window ${repeated.readVisits} times, including intervening calls` : `${repeated.tool} returned identical evidence ${repeated.count} times for the same arguments`}. Reuse the observed result. If this satisfies the assignment, return the factual handoff now; otherwise choose a different meaningful unfinished edit/check. Do not repeat this call. A fourth identical call will be blocked.\n${repeated.evidence}` }] })
      }
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
      const review = reviews.get(event.sessionID)
      if (review) {
        const stale = await review.observe(event)
        if (stale === 4) await record({ event: "review_stagnation_warning", sessionID: event.sessionID, unchangedResults: stale })
        if (stale >= 7) {
          const handoff = `STATUS: PARTIAL\nCHILD_LOOP_ABORTED: review stagnation after repeated unchanged delivered evidence; no new source coverage or behavioral verification followed the warning.\n${toolEvidence(event)}\nREAD COVERAGE (not completed review): ${(await coverage(event.sessionID)).slice(0, 700) || "No persisted coverage available."}\nNEXT: Report supported findings and missing verification. This review did not authorize edits. Do not automatically relaunch the failed scope.`
          await preserveStop(event.sessionID, handoff)
          try { await ctx.session.interrupt({ sessionID: event.sessionID, continue: false }) }
          catch (error) {
            await preserveStop(event.sessionID, `STATUS: PARTIAL\nCHILD_LOOP_ABORT_FAILED: review stagnation interruption failed: ${describeError(error)}\n${toolEvidence(event)}`)
            throw new Error(`CHILD_LOOP_ABORT_FAILED: ${describeError(error)}`)
          }
          await record({ event: "child_loop_stopped", sessionID: event.sessionID, reason: "review_stagnation" })
          throw new Error("CHILD_LOOP_ABORTED: review stagnation; return the saved factual partial handoff.")
        }
      }
      if (["edit", "write"].includes(event.tool) && typeof event.input?.path === "string") {
        try { await rememberChange(event.sessionID, {
          tool: event.tool, path: resolve(event.input.path), revision: await revision(event.input.path),
          evidence: `${event.tool} ${excerpt(event.input.path, 300)}: completed; ${excerpt(event.result?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") || event.result?.output?.content || (typeof event.result?.output === "string" ? event.result.output : ""), 220)}`,
        }) } catch (error) { await record({ event: "progress_write_failed", sessionID: event.sessionID, error: describeError(error).slice(0, 180) }) }
      }
      const read = await readKey(event)
      let readVisits = 0
      if (read) {
        const visits = readRepeats.get(event.sessionID) ?? new Map<string, number>()
        visits.set(read, (visits.get(read) ?? 0) + 1)
        readRepeats.set(event.sessionID, visits)
        const ledger = await loadLedger(event.sessionID)
        const current = await revision(event.input.path)
        readVisits = Math.max(visits.get(read)!, persistedReadVisits(ledger, event.input, current))
      }
      const sig = read ?? signature(event.tool, event.input)
      const previous = repeats.get(event.sessionID)
      const result = event.result && typeof event.result === "object"
        ? event.result as { output?: string; title?: string; metadata?: unknown }
        : { output: String(event.result ?? "") }
      const outputSig = digest(result)
      const count = previous?.signature === sig && previous.output === outputSig ? previous.count + 1 : 1
      repeats.set(event.sessionID, { signature: sig, output: outputSig, count, readVisits, tool: event.tool, evidence: toolEvidence(event) })

      if (count === 3) {
        // Preserve structured v2 output; do not stringify it as [object Object].
        if (typeof result.output === "string") result.output += "\n\nREPEAT_GUARD: Reuse this evidence and return findings. Do not repeat the call."
        console.warn(`[REPEAT_GUARD] session=${event.sessionID} tool=${event.tool} identical_results=${count}`)
      }
    })
  },
}
