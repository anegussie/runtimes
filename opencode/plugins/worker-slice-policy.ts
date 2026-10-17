import { randomUUID } from "node:crypto"
import { record } from "./lib/telemetry.ts"

type Assignment = { parentID: string; inventory: boolean }
type Worker = Assignment & { compacted: boolean; initialUser: string; checkpointUser?: string }
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
      if (/WORKER_SLICE_ID: [a-f0-9-]{36}/.test(input.prompt)) return
      const inventory = broadReview(input.prompt)
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
      pending.set(token, { parentID: event.sessionID, inventory })
      input.prompt += `\nWORKER_SLICE_ID: ${token}\nReturn after this slice. A first compaction is a checkpoint handoff, not authorization to start another section.`
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
        // Explicit new user input releases this slice's handoff gate; no old
        // checkpoint can permanently disable a future request.
        if (user !== (state.checkpointUser ?? state.initialUser)) { workers.delete(event.sessionID); return }
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
      if (event.tools?.read || event.tools?.shell || event.tools?.bash) return
      const returned = currentResults(messages).findLast((part: any) => {
        if (!["subagent", "task"].includes(part.name ?? part.tool)) return false
        const value = part.result?.value
        const error = typeof value === "string" ? value : value?.error?.message ?? value?.message ?? ""
        return Boolean(part.result?.type) && !/^Invalid arguments for tool "(?:subagent|task)":/.test(error)
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
