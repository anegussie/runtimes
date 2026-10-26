import { randomUUID, createHash } from "node:crypto"
import { resolve } from "node:path"
import { coverage, loadLedger, rememberSlice, revision, type Slice } from "./lib/progress-ledger.ts"
import { record } from "./lib/telemetry.ts"

type Assignment = { parentID: string; inventory: boolean; scope?: Omit<Slice, "child" | "handoff" | "done">; cached?: string }
type Worker = Assignment & { compacted: boolean; initialUser: string; checkpointUser?: string }
const readOnlyReview = (objective: string) => /^\s*(?:review|audit|analy[sz]e|inspect)\b/i.test(objective)
  && !/\b(?:fix|edit|implement|apply|change|update|verify|test|run|check)\b/i.test(objective)
const excerpt = (text: string, size: number) => text.length <= size ? text : `${text.slice(0, size)}\n[handoff excerpt; full result remains in worker session]`
const callKey = (event: any) => `${event.sessionID}:${event.callID ?? event.toolCallID ?? event.id ?? ""}`
async function assignedScope(prompt: string) {
  const objective = prompt.match(/(?:^|\n)OBJECTIVE:\s*([^\n]+)/i)?.[1]?.trim()
  const target = prompt.match(/(?:^|\n)TARGET:\s*([^\n]+)/i)?.[1]?.trim()
  if (!objective || !target) return
  const match = target.match(/^(?:["'`])?(\/[^"'`\n]+?\.[A-Za-z0-9]{1,12})(?:["'`])?(?=\s|$)/)
  if (!match) return
  const path = resolve(match[1]), current = await revision(path)
  if (current === "unavailable") return
  const normalize = (text: string) => text.toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim()
  // Exact deliverable identity, not a semantic classifier. Findings/out-of-scope
  // text cannot turn a different review lens or edit into a duplicate.
  const done = prompt.match(/(?:^|\n)DONE WHEN:\s*([^\n]+)/i)?.[1] ?? ""
  const key = createHash("sha256").update(JSON.stringify([normalize(objective), normalize(target), normalize(done)])).digest("hex")
  return { key, path, revision: current, objective, target }
}
const textOf = (value: any): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map(textOf).join("\n") : value?.text ?? ""
const lastUser = (messages: any[]) => [...messages].reverse().find(message => message.role === "user")
const currentResults = (messages: any[]) => {
  let boundary = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { boundary = i; break }
  return boundary < 0 ? [] : messages.slice(boundary + 1).flatMap(message =>
    message.role === "tool" && Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "tool-result") : [])
}
function addInstruction(event: any, text: string) {
  if (!event.messages.some((message: any) => message.role === "system" && textOf(message.content) === text))
    event.messages.push({ role: "system", content: [{ type: "text", text }] })
}
function broadReview(prompt: string) {
  const objective = prompt.match(/(?:^|\n)OBJECTIVE:\s*([^\n]+)/i)?.[1]
    ?? prompt.split(/\n(?:OUT OF SCOPE|KNOWN EVIDENCE|DONE WHEN):/i)[0]
  return /\b(review|audit|analy[sz]e)\b.*\b(all|every|each|entire|whole|complete)\b.*\b(files?|content|directory|workspace|project|tutorials?|documents?|sections?)\b/i.test(objective)
}

// Scope lifecycle, not a global/file/turn tool-count budget. No persisted lock.
export default {
  id: "worker-slice-policy",
  async setup(ctx: any) {
    const pending = new Map<string, Assignment>()
    const workers = new Map<string, Worker>()
    const calls = new Map<string, Assignment>()
    const rechecks = new Map<string, string>()
    const consumedRechecks = new Map<string, string>()
    const requests = new Map<string, string>()
    const identify = async (event: any) => {
      if (workers.has(event.sessionID)) return workers.get(event.sessionID)
      const texts = (event.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => textOf(m.content))
      const token = texts.map((s: string) => s.match(/WORKER_SLICE_ID: ([a-f0-9-]{36})/)?.[1]).find(Boolean)
      if (!token || !pending.has(token)) return
      let info
      try { info = await ctx.session.get({ sessionID: event.sessionID }) } catch { return }
      const assignment = pending.get(token)!
      if (info?.parentID !== assignment.parentID) return
      const state = { ...assignment, compacted: false, initialUser: textOf(lastUser(event.messages)?.content) }
      workers.set(event.sessionID, state)
      pending.delete(token)
      return state
    }
    await ctx.tool.hook("execute.before", async (event: any) => {
      if (!["subagent", "task"].includes(event.tool)) return
      const input = event.input
      const agent = input?.agent ?? input?.subagent_type
      if (!["context_worker", "general_worker"].includes(agent) || typeof input?.prompt !== "string" || typeof input.description !== "string") return
      const supplied = input.prompt.match(/WORKER_SLICE_ID: ([a-f0-9-]{36})/)?.[1]
      if (supplied && pending.get(supplied)?.parentID === event.sessionID && calls.get(callKey(event)) === pending.get(supplied)) return
      // Model/user-pasted markers are not trusted runtime provenance.
      input.prompt = input.prompt.replace(/WORKER_SLICE_ID: [a-f0-9-]{36}/g, "")
      const parsed = await assignedScope(input.prompt)
      const scope = parsed && { ...parsed, request: requests.get(event.sessionID) ?? "" }
      const history = (await loadLedger(event.sessionID)).slices ?? []
      const prior = scope && [...history].reverse().find(row => row.path === scope.path && row.revision === scope.revision)
      const done = scope && history.find(row => row.key === scope.key && row.revision === scope.revision && row.request === scope.request && row.done && !row.truncated && readOnlyReview(scope.objective))
      const recheck = rechecks.get(event.sessionID)
      const explicitRecheck = recheck && consumedRechecks.get(event.sessionID) !== recheck
      if (scope && explicitRecheck && history.some(row => row.key === scope.key && row.done)) consumedRechecks.set(event.sessionID, recheck)
      const cached = done && !explicitRecheck ? done.handoff : undefined
      if (prior && !cached) input.prompt += `\nPRIOR SLICE EVIDENCE (historical claims, not retained source; targeted rereads for edits are allowed):\n${excerpt(prior.handoff, 1600)}\nRECORDED READ COVERAGE (not proof of completed review):\n${excerpt(await coverage(prior.child) || "Unknown", 650)}\nContinue the named unfinished deliverable; do not reset discovery or repeat completed sections.`
      const inventory = !cached && broadReview(input.prompt)
      if (inventory) {
        const target = input.prompt.match(/(?:^|\n)TARGET:\s*([^\n]+)/i)?.[1]
        // No guessed filenames or invented review findings: the larger goal
        // stays with the parent; this child only inventories its chosen target.
        input.prompt = `OBJECTIVE: INVENTORY ONLY for the first slice of a broad review.\nTARGET: ${target ?? "Use only the directory explicitly chosen by the user; if none was supplied, return PARTIAL naming the missing target."}\nDONE WHEN: return a compact path inventory from one bounded glob result; no file content review, file-size scans, or edits. Treat truncation as PARTIAL, not permission for exhaustive discovery.\nOUT OF SCOPE: reading source, reviewing every file, additional directories, and later sections. NEXT: name one candidate file/section for the parent to assign to a fresh worker within the original request.`
        input.description = "Inventory broad review targets"
        if (input.agent != null) input.agent = "context_worker"
        else input.subagent_type = "context_worker"
        await record({ event: "worker_scope_normalized", sessionID: event.sessionID, phase: "inventory" })
      }
      const token = randomUUID()
      const assignment: Assignment = { parentID: event.sessionID, inventory, scope, cached }
      pending.set(token, assignment)
      calls.set(callKey(event), assignment)
      if (cached) {
        input.prompt = `OBJECTIVE: Return the prior completed slice handoff only.\nTARGET: ${scope!.target}\nSLICE_COMPLETED_SCOPE: This exact deliverable already returned DONE for the unchanged source revision. No new review, source tools, edits, or checks are authorized by this duplicate. Return the prior findings below and identify this as reused evidence; do not claim new verification.\nPRIOR SLICE EVIDENCE:\n${cached}`
      }
      input.prompt += `\nWORKER_SLICE_ID: ${token}\nReturn after this slice. A first compaction is a checkpoint handoff, not authorization to start another section.`
    })
    await ctx.tool.hook("execute.after", async (event: any) => {
      if (!["subagent", "task"].includes(event.tool)) return
      const assignment = calls.get(callKey(event)); calls.delete(callKey(event))
      if (!assignment?.scope || assignment.cached || event.status !== "completed" || event.error) return
      const output = event.result?.output
      if (!output || typeof output !== "object" || typeof output.sessionID !== "string" || typeof output.output !== "string" || output.status !== "completed") return
      const handoff = output.output
      if (/CHILD_LOOP_|TOOL_FAILURE_STOP|resource_timeout|\b(?:cancelled|canceled|interrupted)\b/i.test(handoff)) return
      const done = /^\s*STATUS:\s*DONE\b/im.test(handoff) && !/^\s*STATUS:\s*(?:PARTIAL|BLOCKED)\b/im.test(handoff)
      if (!done && !/^\s*STATUS:\s*PARTIAL\b/im.test(handoff)) return
      let info
      try { info = await ctx.session.get({ sessionID: output.sessionID }) } catch { return }
      if (info?.parentID !== event.sessionID) return
      const current = await revision(assignment.scope.path)
      if (current === "unavailable") return
      const unchanged = current === assignment.scope.revision
      try { await rememberSlice(event.sessionID, { ...assignment.scope, revision: current, child: output.sessionID,
        handoff: excerpt(handoff, 4096), truncated: handoff.length > 4096,
        done: done && unchanged && !assignment.inventory && readOnlyReview(assignment.scope.objective) }) }
      catch (error) { await record({ event: "worker_progress_write_failed", sessionID: event.sessionID, error: String(error).slice(0, 180) }) }
    })
    await ctx.session.hook("compaction", async (event: any) => {
      const state = await identify(event)
      if (!state) return
      state.compacted = true
      state.checkpointUser = undefined
      await record({ event: "worker_slice_checkpoint", sessionID: event.sessionID, action: "handoff_after_compaction" })
    })
    await ctx.session.hook("context", async (event: any) => {
      const state = await identify(event)
      const messages = event.messages ?? []
      const user = textOf(lastUser(messages)?.content)
      if (state) {
        if (state.compacted && state.checkpointUser === undefined) state.checkpointUser = user
        // A real new instruction releases review/checkpoint gates.
        if (user !== (state.checkpointUser ?? state.initialUser)) { workers.delete(event.sessionID); return }
        if (state.cached) {
          event.tools = {}
          addInstruction(event, `SLICE_COMPLETED_SCOPE: Return only this prior completed handoff as reused evidence. No new tools or verification.\n${state.cached}`)
          return
        }
        if (state.compacted) {
          event.tools = {}
          addInstruction(event, "SLICE_CHECKPOINT_HANDOFF: This worker reached its first compaction. Return an 80-140 word DONE/PARTIAL handoff NOW using the retained checkpoint and confirmed evidence. Include scope, findings, changed paths, checks actually completed, and missing verification/next slice. No more tools, discovery, edits, or source scans in this slice. Do not claim unperformed checks. The parent can assign unfinished work within the original request to a fresh worker using this evidence; a checkpoint alone does not require user confirmation.")
          return
        }
        if (state.inventory) {
          const done = currentResults(messages).some((part: any) => (part.name ?? part.tool) === "glob")
          event.tools = done ? {} : Object.fromEntries(Object.entries(event.tools ?? {}).filter(([name]) => name === "glob"))
          addInstruction(event, done
            ? "SLICE_INVENTORY_HANDOFF: Inventory lookup returned. Return its paths and one next candidate slice NOW; mark truncated/failed inventory PARTIAL. Do not read/review content, repeat discovery, or claim the broad review is complete."
            : "SLICE_INVENTORY_ONLY: Only a bounded glob in the explicitly assigned target is allowed. No source reads, shell commands, reviews, or edits. Return its inventory and stop.")
        }
        return
      }
      // Successful child returns keep sequential delegation available. Only
      // terminal failures end the turn; schema errors still allow correction.
      if (!event.tools?.subagent && !event.tools?.task) return
      const latestUser = textOf(lastUser(messages)?.content)
      const followup = /^(?:yes|ok(?:ay)?|continue|proceed|implement(?: it| them| recommendations)?|fix(?: it| them| all)?|do it|make the updates)[.!\s]*$/i.test(latestUser.trim())
      const checkpoint = latestUser.startsWith("## Binding user instructions") || latestUser.startsWith("<conversation-checkpoint>")
      if (!checkpoint && (!requests.has(event.sessionID) || !followup)) requests.set(event.sessionID, JSON.stringify([messages.filter((m: any) => m.role === "user").length, lastUser(messages)?.id ?? latestUser]))
      if (checkpoint && !requests.has(event.sessionID)) requests.set(event.sessionID, (await loadLedger(event.sessionID)).slices?.at(-1)?.request ?? "")
      if (/\b(?:review|inspect|audit|check)\b.{0,50}\b(?:again|fresh|recheck|second time)\b/i.test(latestUser)) rechecks.set(event.sessionID, JSON.stringify([(messages.filter((m: any) => m.role === "user")).length, lastUser(messages)?.id, latestUser]))
      const slices = (await loadLedger(event.sessionID)).slices ?? []
      if (slices.length) addInstruction(event, `SLICE_RETAINED_PROGRESS: Retain these prior worker handoffs as historical claims; source text is not retained. Assign an edit/check after user approval rather than repeating the completed review. Different named sections, new review questions, and changed revisions remain valid.\n${slices.slice(-2).map(row => `${row.objective} | ${row.target}\n${excerpt(row.handoff, 1000)}`).join("\n\n")}`)
      if (event.tools?.read || event.tools?.shell || event.tools?.bash) return
      const returned = currentResults(messages).findLast((part: any) => {
        if (!["subagent", "task"].includes(part.name ?? part.tool)) return false
        const value = part.result?.value
        const error = typeof value === "string" ? value : value?.error?.message ?? value?.message ?? ""
        const incomplete = (typeof value === "string" || value?.error?.type === "tool.input-incomplete")
          && /^The tool call was not executed because the output token limit\b/.test(error)
        // These failures occurred before a child ran. They can be corrected
        // once; they are not a failed worker that must enter terminal handoff.
        return Boolean(part.result?.type)
          && !incomplete
          && !/^Invalid arguments for tool "(?:subagent|task)":|^PARENT_PROGRESS_STOP:/.test(error)
      })
      if (!returned) return
      const result = returned.result
      const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "")
      const terminal = /\bTOOL_FAILURE_STOP\b/.test(value)
        || ["error", "error-text", "error-json"].includes(result.type)
        || /\b(?:CHILD_LOOP_[A-Z_]+|LOOP_GUARD_ABORTED|resource_timeout|resource[_ -]limited|RESOURCE_EXHAUSTED)\b|\b(?:cancelled|canceled|interrupted)\b|\b(?:backend|engine|server)\s+(?:is\s+)?(?:busy|unavailable)|\b(?:out of|not enough)\s+memory\b/i.test(value)
      if (terminal) {
        event.tools = {}
        addInstruction(event, "SLICE_PARENT_HANDOFF: The worker returned a cancellation, backend/resource failure, or loop stop. Report its actual partial progress, failure evidence, and remaining scope, then STOP. Do not retry the failed scope or launch replacement work until the user requests recovery.")
        return
      }
      addInstruction(event, "SLICE_PARENT_CONTINUE: The worker returned. Retain its actual findings, changed paths, checks, and remaining scope. If the original request has unfinished tasks or verification, assign the smallest remaining slice to ONE fresh foreground worker without asking for confirmation. A normal inventory or compaction checkpoint is not completion of the whole request. Do not repeat completed work, broaden scope, or relaunch a cancelled/failed worker. If complete, report a consolidated final result; if essential information or permission is missing, ask only for that blocker.")
    })
  },
}
