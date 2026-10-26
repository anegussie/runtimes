import { revision } from "./lib/progress-ledger.ts"
import { record } from "./lib/telemetry.ts"
import { resolve } from "node:path"
import { directReadProgress } from "./lib/direct-read-progress.ts"

type Range = [number, number]
type Scope = { path: string; revision: string; ranges: Range[]; partial?: boolean }
type Progress = { user: string; latest: string; history: Scope[]; stopped?: Scope; blocked: number; compacting: boolean }
const delegation = (name: string) => name === "subagent" || name === "task"
const whole = (scope: Scope) => scope.ranges[0]?.[1] === Number.MAX_SAFE_INTEGER - 1
const textOf = (value: any): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map(textOf).join("\n") : value?.text ?? ""

function merge(ranges: Range[]): Range[] {
  const result: Range[] = []
  for (const [start, end] of ranges.sort((a,b) => a[0]-b[0])) {
    const last = result.at(-1)
    if (last && start <= last[1]+1) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}

function repeatedLines(ranges: Range[], history: Scope[]): number {
  const points = new Map<number, number>()
  for (const row of history) for (const [start,end] of row.ranges) {
    points.set(start, (points.get(start) ?? 0)+1)
    points.set(end+1, (points.get(end+1) ?? 0)-1)
  }
  let count = 0, previous = 0, repeated = 0
  for (const [position,delta] of [...points].sort((a,b) => a[0]-b[0])) {
    if (count >= 2) for (const [start,end] of ranges)
      repeated += Math.max(0, Math.min(position,end+1)-Math.max(previous,start))
    previous = position; count += delta
  }
  return repeated
}

async function scope(prompt: string): Promise<Scope | undefined> {
  const objective = prompt.match(/(?:^|\n)OBJECTIVE:\s*([^\n]+)/i)?.[1] ?? prompt.split("\n")[0]
  const sourceCopy = /\bREAD[- ]ONLY\b|\bverbatim\b|\bexact (?:text|content|source)\b/i.test(prompt)
  if (!/^\s*(read|retrieve|show|copy)\b/i.test(objective)
    || (!sourceCopy && /\b(review|audit|analy[sz]e|security|accessibility|correctness|bugs|issues)\b/i.test(objective))
    || /\b(?:and|then)\s+(?:fix|edit|implement|apply|change|update|verify|test)\b/i.test(objective)) return
  const found: string[] = []
  // Extract quoted filenames before scanning raw command text. This also
  // keeps spaces in filenames and avoids matching a fragment of that path.
  const raw = prompt.replace(/(["'`])(\/[^\n]+?)\1/g, (match, _quote, path) => {
    if (!/\.[a-zA-Z0-9]{1,12}$/.test(path)) return match
    found.push(path); return " "
  })
  found.push(...(raw.match(/\/[^\s"'`<>]+\.[a-zA-Z0-9]{1,12}(?=[\s"'`:;,.)\]]|$)/g) ?? []))
  const paths = [...new Set(found.map(path => resolve(path)))]
  if (paths.length !== 1) return
  const ranges: Range[] = []
  const matches = [
    ...prompt.matchAll(/\blines?\s+(?:from\s+)?(\d+)\s*(?:[-\u2013:]|to|through)\s*(\d+)/gi),
    ...prompt.matchAll(/\bsed\s+(?:-[a-zA-Z]+\s+)*["'](\d+)\s*,\s*(\d+)p["']/g),
  ]
  for (const match of matches) {
    const start = Number(match[1]), end = Number(match[2])
    if (start < 1 || end < start || !Number.isSafeInteger(end+1)) return
    ranges.push([start, end])
  }
  // Whole-file source copying has the same scope even when its title or
  // description changes. Named sections without a numeric range remain free.
  if (!ranges.length) {
    const wholeFile = /\b(?:entire|whole|full|complete)\s+(?:file\b|["'`]?\/\S+|["'`]?\S+\s+file\b)/i.test(objective)
    if (!wholeFile) return
    ranges.push([1, Number.MAX_SAFE_INTEGER - 1])
  }
  const current = await revision(paths[0])
  if (current !== "unavailable") return { path: paths[0], revision: current, ranges: merge(ranges) }
}

// Detect repeated overlapping read assignments across fresh children, while
// allowing one targeted reread. This is not a total delegation/tool budget.
export default {
  id: "parent-progress",
  async setup(ctx: any) {
    const direct = directReadProgress()
    const parents = new Map<string, Progress>()
    const pending = new Map<string, { parent: string; scope: Scope; state: Progress }>()
    await ctx.session.hook("compaction", async (event: any) => {
      await direct.compaction(event)
      const state = parents.get(event.sessionID)
      if (state) state.compacting = true
    })
    await ctx.session.hook("context", async (event: any) => {
      await direct.context(event)
      if (event.model?.providerID !== "local-llama") { parents.delete(event.sessionID); return }
      const users = (event.messages ?? []).filter((m: any) => m.role === "user")
      const latest = users.at(-1)
      const latestText = textOf(latest?.content)
      const user = JSON.stringify([users.length, latest?.id ?? textOf(latest?.content)])
      let state = parents.get(event.sessionID)
      if (state?.compacting) {
        const checkpoint = latestText.startsWith("## Binding user instructions (verbatim; authoritative)")
          || (latestText.startsWith("<conversation-checkpoint>\n") && latestText.includes("\n<summary>\n"))
        if (latestText === state.latest || checkpoint) state.user = user
        state.compacting = false
      }
      if (!state || state.user !== user) {
        state = { user, latest: latestText, history: [], blocked: 0, compacting: false }
        parents.set(event.sessionID, state)
      }
      state.latest = latestText
      if (parents.size > 128) parents.delete(parents.keys().next().value!)
      if (state.stopped && await revision(state.stopped.path) !== state.stopped.revision) {
        state.stopped = undefined; state.blocked = 0
      }
      if (!state.stopped) return
      // Keep one corrective edit/check delegation available. Only repeated
      // refusal to leave the same source-copy scope ends the turn.
      if (state.blocked >= 2) event.tools = {}
      const text = state.blocked >= 2
        ? "PARENT_PROGRESS_STOP: Repeated unchanged source-only assignments were blocked twice. Return STATUS: PARTIAL with actual findings, missing edits/checks and the blocker. No retry or replacement worker."
        : "PARENT_PROGRESS_STOP: The repeated source-only assignment was blocked. Retain the confirmed findings. If implementation is authorized, delegate ONE concrete improvement as read -> edit -> verify in the same worker, returning changed paths and checks. Do not ask another worker to copy the file or compile verbatim source. If essential scope or evidence is missing, report STATUS: PARTIAL with that blocker."
      event.messages.push({ role: "system", content: [{ type: "text", text }] })
    })
    await ctx.tool.hook("execute.before", async (event: any) => {
      await direct.before(event)
      const state = parents.get(event.sessionID)
      const call = event.callID ?? event.toolCallID ?? event.id
      if (!state || !call || !delegation(event.tool) || typeof event.input?.prompt !== "string") return
      const next = await scope(event.input.prompt)
      if (!next) return
      const previous = state.history.filter(row => row.path === next.path && row.revision === next.revision)
      const requested = next.ranges.reduce((sum, [start,end]) => sum+end-start+1, 0)
      const repeated = whole(next)
        ? (previous.filter(whole).length >= 2 ? requested : 0)
        : repeatedLines(next.ranges, previous.filter(row => !row.partial))
      if (repeated / requested >= 0.8) {
        state.stopped = next
        state.blocked++
        await record({ event: "parent_progress_stopped", sessionID: event.sessionID, path: next.path, repeatedLines: repeated, requestedLines: requested })
        throw new Error("PARENT_PROGRESS_STOP: These unchanged source ranges were already assigned to two completed readers. Reuse findings and implement/verify the known fix in one worker; do not launch another source-copy handoff. Report partial progress if implementation lacks essential evidence.")
      }
      pending.set(`${event.sessionID}:${call}`, { parent: event.sessionID, scope: next, state })
      if (pending.size > 128) pending.delete(pending.keys().next().value!)
    })
    await ctx.tool.hook("execute.after", async (event: any) => {
      await direct.after(event)
      if (!delegation(event.tool)) return
      const call = event.callID ?? event.toolCallID ?? event.id
      const key = `${event.sessionID}:${call}`, entry = pending.get(key)
      pending.delete(key)
      if (!entry || event.status !== "completed" || event.error
        || /STATUS:\s*BLOCKED|CHILD_LOOP_|TOOL_FAILURE_STOP|resource_timeout/i.test(JSON.stringify(event.result ?? {}))
        || parents.get(entry.parent) !== entry.state
        || await revision(entry.scope.path) !== entry.scope.revision) return
      const partial = /STATUS:\s*PARTIAL/i.test(JSON.stringify(event.result ?? {}))
      // A partial whole-file checkpoint is an attempted copy, not coverage.
      // Repeating it indefinitely is blocked; smaller targeted slices stay free.
      if (partial && !whole(entry.scope)) return
      entry.scope.partial = partial
      entry.state.history.push(entry.scope)
      if (entry.state.history.length > 64) entry.state.history.shift()
    })
  },
}
