import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

type Entry = { path: string; revision: string; start: number; end: number; partial: boolean; visits: number; limit?: number; epoch?: number; epochVisits?: number }
export type Slice = { request: string; key: string; path: string; revision: string; objective: string; target: string; child: string; handoff: string; truncated?: boolean; done: boolean }
type Change = { tool: string; path: string; revision: string; evidence: string }
type Ledger = { version: number; reads: Entry[]; readEpoch?: number; checkpoint?: string; loopStop?: string; slices?: Slice[]; changes?: Change[] }
const root = () => process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC === "1"
  ? process.env.OPENCODE_PROGRESS_TEST_DIR ?? join(tmpdir(), `opencode-progress-diagnostic-${process.pid}`)
  : join(homedir(), ".local/state/opencode/progress")
const pending = new Map<string, Promise<unknown>>()
const location = (id: string) => /^[A-Za-z0-9_-]+$/.test(id) ? join(root(), `${id}.json`) : null

export async function revision(path: string): Promise<string> {
  try { const s = await stat(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
  catch { return "unavailable" }
}

export async function loadLedger(id: string): Promise<Ledger> {
  const path = location(id)
  if (!path) return { version: 1, reads: [] }
  try {
    const value = JSON.parse(await readFile(path, "utf8"))
    if (value.version === 1 && Array.isArray(value.reads)) return value
  } catch {}
  return { version: 1, reads: [] }
}

export async function rememberRead(id: string, entry: Omit<Entry, "visits" | "epoch" | "epochVisits">) {
  const path = location(id)
  if (!path) return
  const prior = pending.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    const ledger = await loadLedger(id)
    entry.path = resolve(entry.path)
    ledger.reads = ledger.reads.filter(row => row.path !== entry.path || row.revision === entry.revision)
    const existing = ledger.reads.find(row => row.path === entry.path && row.start === entry.start && row.end === entry.end && row.partial === entry.partial && row.limit === entry.limit)
    const epoch = ledger.readEpoch ?? 0
    if (existing) {
      existing.epochVisits = (existing.epoch ?? 0) === epoch ? (existing.epochVisits ?? existing.visits) + 1 : 1
      existing.epoch = epoch
      existing.visits++
    } else ledger.reads.push({ ...entry, visits: 1, epoch, epochVisits: 1 })
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temp, path)
  })
  pending.set(id, next)
  try { await next } finally { if (pending.get(id) === next) pending.delete(id) }
}

// Compaction removes source results from model context. Retain historical
// coverage and lifetime visits, but persist a new repeat-counting epoch so
// process/plugin reloads cannot reopen a loop within that same epoch.
export async function beginReadEpoch(id: string) {
  const path = location(id)
  if (!path) return
  const prior = pending.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    const ledger = await loadLedger(id)
    ledger.readEpoch = (ledger.readEpoch ?? 0) + 1
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temp, path)
  })
  pending.set(id, next)
  try { await next } finally { if (pending.get(id) === next) pending.delete(id) }
}

export async function coverage(id: string): Promise<string> {
  const ledger = await loadLedger(id)
  const rows: string[] = []
  for (const path of [...new Set(ledger.reads.map(row => row.path))]) {
    const current = await revision(path)
    if (current === "unavailable") continue
    const entries = ledger.reads.filter(row => row.path === path && row.revision === current)
    const ranges: number[][] = []
    for (const row of entries.filter(row => !row.partial).sort((a,b) => a.start-b.start)) {
      const last = ranges.at(-1)
      if (last && row.start <= last[1]+1) last[1] = Math.max(last[1], row.end)
      else ranges.push([row.start, row.end])
    }
    if (entries.length) rows.push(`${path}: confirmed lines ${ranges.map(([a,b]) => `${a}-${b}`).join(", ") || "none"}; partial lines ${entries.filter(row => row.partial).map(row => row.start).join(", ") || "none"}.`)
  }
  return rows.join("\n")
}

export async function rememberCheckpoint(id: string, checkpoint: string) {
  const path = location(id)
  if (!path) return
  const prior = pending.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    const ledger = await loadLedger(id)
    ledger.checkpoint = checkpoint.slice(0, 1600)
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temp, path)
  })
  pending.set(id, next)
  try { await next } finally { if (pending.get(id) === next) pending.delete(id) }
}

// Completed edit/write execution is runtime evidence, independent of a model
// checkpoint. Keep bounded diagnostics, never old/new source payloads.
export async function rememberChange(id: string, change: Change) {
  const path = location(id)
  if (!path) return
  const prior = pending.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    const ledger = await loadLedger(id)
    ledger.changes = [...(ledger.changes ?? []), change].slice(-8)
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temp, path)
  })
  pending.set(id, next)
  try { await next } finally { if (pending.get(id) === next) pending.delete(id) }
}

// Persist the reason independently of compaction so a resumed parent can
// recover a useful handoff after native cancellation hides the hook error.
export async function rememberLoopStop(id: string, handoff: string) {
  const path = location(id)
  if (!path) return
  const prior = pending.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    const ledger = await loadLedger(id)
    ledger.loopStop = handoff.slice(0, 3200)
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temp, path)
  })
  pending.set(id, next)
  try { await next } finally { if (pending.get(id) === next) pending.delete(id) }
}

// Parent-session-local worker provenance. This stores handoffs, never source.
export async function rememberSlice(id: string, slice: Slice) {
  const path = location(id)
  if (!path) return
  const prior = pending.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    const ledger = await loadLedger(id)
    ledger.slices = [...(ledger.slices ?? []).filter(row => row.key !== slice.key || row.revision !== slice.revision), slice].slice(-24)
    await mkdir(root(), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temp, path)
  })
  pending.set(id, next)
  try { await next } finally { if (pending.get(id) === next) pending.delete(id) }
}
