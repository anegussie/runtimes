import { appendFile, mkdir } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export async function record(event: Record<string, unknown>) {
  const directory = process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC === "1"
    ? join(tmpdir(), `opencode-performance-diagnostic-${process.pid}`)
    : join(homedir(), ".local/state/opencode")
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // No prompts, source excerpts or tool payloads in this performance journal.
    await appendFile(join(directory, "performance.jsonl"), JSON.stringify({
      timestamp: new Date().toISOString(), ...event,
      ...(process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC === "1" || String(event.sessionID ?? "").startsWith("unit-") ? { diagnostic: true } : {}),
    }) + "\n", { mode: 0o600 })
  } catch (error) {
    console.warn(`[PERFORMANCE_LOG_FAILED] ${String(error)}`)
  }
}
