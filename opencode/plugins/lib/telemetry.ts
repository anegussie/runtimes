import { appendFile, mkdir } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"

export const telemetryInstanceID = randomUUID()
export const telemetryContext = new AsyncLocalStorage<Record<string, unknown>>()
let writeFailures = 0, writtenEvents = 0
export const telemetryHealth = () => ({ writeFailures, writtenEvents })

export async function record(event: Record<string, unknown>) {
  const directory = process.env.OPENCODE_TELEMETRY_DIR ?? (process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC === "1"
    ? join(tmpdir(), `opencode-performance-diagnostic-${process.pid}`)
    : join(homedir(), ".local/state/opencode"))
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // No prompts, source excerpts or tool payloads in this performance journal.
    await appendFile(join(directory, "performance.jsonl"), JSON.stringify({
      ...telemetryContext.getStore(), ...event,
      schemaVersion: 2, eventID: randomUUID(), processInstanceID: telemetryInstanceID,
      pid: process.pid, timestamp: new Date().toISOString(), wallTimeMs: Date.now(),
      monotonicMs: performance.now(),
      ...(process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC === "1" || String(event.sessionID ?? "").startsWith("unit-") ? { diagnostic: true } : {}),
    }) + "\n", { mode: 0o600 })
    writtenEvents++
  } catch (error) {
    writeFailures++
    if (writeFailures === 1 || writeFailures % 1000 === 0)
      console.warn(`[PERFORMANCE_LOG_FAILED] count=${writeFailures} class=${(error as any)?.name ?? "Error"}`)
  }
}
