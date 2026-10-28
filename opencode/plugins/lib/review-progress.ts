import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { revision } from "./progress-ledger.ts"

export const textOf = (value: any): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map(textOf).join("\n") : value?.text ?? ""
const outputText = (result: any): string => typeof result?.output === "string" ? result.output
  : textOf(result?.content) || textOf(result?.output?.content) || result?.output?.stdout || ""

export function reviewKey(prompt: string): string | undefined {
  const assignment = prompt.split(/\n(?:PRIOR SLICE EVIDENCE|BEGIN HISTORICAL HANDOFF)/)[0]
  const objective = assignment.match(/(?:^|\n)OBJECTIVE:\s*([^\n]+)/i)?.[1]
  const target = assignment.match(/(?:^|\n)TARGET:\s*([^\n]+)/i)?.[1]
  if (!objective || !target || !/^\s*(?:review|audit|inspect|analy[sz]e|diagnose|debug|find\s+(?:why|the (?:root )?cause)|explain why)\b/i.test(objective)
    || /(?:[.;,]\s*|\b(?:and|then)\s+)(?:edit|fix|implement|apply|write|change|repair|update|create)\b/i.test(objective)) return
  return JSON.stringify([objective, target, assignment.match(/(?:^|\n)DONE WHEN:\s*([^\n]+)/i)?.[1] ?? ""])
}

// Session-local review evidence, using the ledger's source revisions. No tool
// budget: only repeated unchanged delivered evidence advances the streak.
export class ReviewProgress {
  stale = 0
  private files = new Map<string, { revision: string; lines: Set<number>; matches: Set<number> }>()
  private negatives = new Set<string>()
  readonly key: string
  constructor(key: string) { this.key = key }
  private async source(name: string) {
    const path = resolve(name)
    try { if (!(await stat(path)).isFile()) return } catch { return }
    const current = await revision(path)
    if (current === "unavailable") return
    let file = this.files.get(path), fresh = false
    if (!file || file.revision !== current) {
      file = { revision: current, lines: new Set(), matches: new Set() }; this.files.set(path, file); fresh = true
      if (this.files.size > 32) this.files.delete(this.files.keys().next().value!)
    }
    return { path, file, fresh }
  }
  async observe(event: any): Promise<number> {
    const novel = await this.novelty(event)
    this.stale = novel === false ? this.stale + 1 : 0
    return this.stale
  }
  private async novelty(event: any): Promise<boolean | undefined> {
    const text = outputText(event.result), metadata = event.result?.metadata ?? {}
    const completeWindow = event.tool === "read" && Number.isInteger(metadata.returnedStart)
      && Number.isInteger(metadata.returnedEnd) && !metadata.partialLine && !metadata.byteLimited
    if (metadata.partialLine || metadata.byteLimited || Buffer.byteLength(text) > 8000
      || /partial (?:historical )?output|partial_line=true|byte_limited=true/i.test(text)
      || (!completeWindow && /\[.*truncat/i.test(text))
      || (event.tool === "grep" && (metadata.truncated || event.result?.output?.truncated))) return
    if (event.tool === "read") {
      const lines = [...text.matchAll(/^(\d+):/gm)].map(match => Number(match[1]))
      if (!lines.length || typeof event.input?.path !== "string") return
      const found = await this.source(event.input.path)
      if (!found) return
      const novel = found.fresh || lines.some(line => !found.file.lines.has(line))
      for (const line of lines) found.file.lines.add(line)
      while (found.file.lines.size > 8192) found.file.lines.delete(found.file.lines.values().next().value!)
      return novel
    }
    if (event.tool !== "grep" || typeof event.input?.path !== "string") return
    const input = await this.source(event.input.path)
    if (/^No matches found\s*$/i.test(text.trim()) || metadata.matches === 0) {
      if (!input) return // A directory mtime cannot establish file freshness.
      const key = JSON.stringify([input.path, input.file.revision, event.input.literal ?? true])
      const novel = !this.negatives.has(key); this.negatives.add(key)
      if (this.negatives.size > 128) this.negatives.delete(this.negatives.values().next().value!)
      return novel
    }
    let path = input?.path, observed = false, novel = false
    for (const line of text.split("\n")) {
      const heading = line.match(/^\s*(\/[^\n]+):\s*$/)
      if (heading) { path = heading[1]; continue }
      const qualified = line.match(/^\s*(\/[^\n]+?):(\d+):/)
      const local = line.match(/^\s*(?:Line\s+)?(\d+):/i)
      if (!qualified && !local) continue
      const found = await this.source(qualified?.[1] ?? path ?? "")
      if (!found) return
      const number = Number(qualified?.[2] ?? local?.[1])
      observed = true; novel ||= found.fresh || (!found.file.lines.has(number) && !found.file.matches.has(number))
      // A search gives a location/snippet, not full read coverage of that line.
      found.file.matches.add(number)
      while (found.file.matches.size > 8192) found.file.matches.delete(found.file.matches.values().next().value!)
    }
    return observed ? novel : undefined
  }
}
