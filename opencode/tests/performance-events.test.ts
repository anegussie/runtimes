import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../plugins/performance-events.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

test("durable tool starts, cancellation requests and missing terminal reconciliation retain uncertainty", async () => {
  const session: any = {}, tool: any = {}
  await plugin.setup({ session: { hook: async (n: string, f: any) => { session[n] = f }, get: async () => ({ parentID: "parent" }) },
    tool: { hook: async (n: string, f: any) => { tool[n] = f } } })
  const id = `unit-telemetry-${Date.now()}`, signal = new AbortController()
  try {
    await session.context({ sessionID: id, agent: "worker", model: { providerID: "local-llama", id: "bonsai-27b-splash" } })
    await tool["execute.before"]({ sessionID: id, tool: "question", callID: "call-q", signal: signal.signal, input: { secret: "PRIVATE_TOOL_INPUT" } })
    signal.abort(); await new Promise(r => setTimeout(r, 0))
    await session.context({ sessionID: id, agent: "worker", messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-q", result: { type: "error", value: "PRIVATE_ERROR" } }] }] })
    await tool["execute.after"]({ sessionID: id, tool: "shell", callID: "missing-start", status: "completed", result: { output: { exit: 1 } } })
    const events = (await readFile(join(tmpdir(), `opencode-performance-diagnostic-${process.pid}/performance.jsonl`), "utf8")).trim().split("\n").map(JSON.parse).filter(e => e.sessionID === id)
    assert.ok(events.some(e => e.event === "tool_start" && e.kind === "question_wait"))
    assert.ok(events.some(e => e.event === "tool_cancel_requested"))
    const reconciled = events.find(e => e.event === "tool_terminal_reconciled")
    assert.equal(reconciled.elapsedMs, null); assert.equal(reconciled.exactEndMissing, true)
    const missing = events.find(e => e.callID === "missing-start")
    assert.equal(missing.startMissing, true); assert.equal(missing.elapsedMs, null)
    assert.equal(missing.nonzeroExit, true); assert.equal(missing.errorClass, "nonzero_exit")
    assert.ok(events.every(e => e.schemaVersion === 2 && e.eventID && e.monotonicMs >= 0 && e.processInstanceID))
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/)
  } finally { clearInterval((globalThis as any)[Symbol.for("opencode.performance.telemetry")].timer) }
})
