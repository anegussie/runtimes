import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../plugins/repeated-child-call-guard.ts"
import { rememberCheckpoint, rememberRead, revision } from "../plugins/lib/progress-ledger.ts"

process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"
process.env.OPENCODE_PROGRESS_TEST_DIR = await mkdtemp(join(tmpdir(), "opencode-loop-tests-"))
let serial = 0
async function runtime(parent = true, failure?: string) {
  const hooks: Record<string, any> = {}
  const id = `unit-child-${++serial}`
  const interrupts: string[] = []
  await plugin.setup({
    tool: { hook: async (name: string, handler: any) => { hooks[name] = handler } },
    session: {
      get: async () => ({ parentID: parent ? "parent" : undefined }),
      interrupt: async ({ sessionID }: any) => {
        interrupts.push(sessionID)
        if (failure) throw new Error(failure)
      },
      hook: async (name: string, handler: any) => { hooks[name] = handler },
    },
  })
  const call = async (tool: string, input: any, output: any = "same", metadata: any = {}) => {
    const event = { sessionID: id, tool, input, status: "completed", result: { output, metadata } }
    await hooks["execute.before"](event)
    await hooks["execute.after"](event)
    return event.result
  }
  return { id, hooks, call, interrupts }
}

test("replays cyclic rereads through child cancellation into the parent model context", async () => {
  const r = await runtime()
  const path = join(process.env.OPENCODE_PROGRESS_TEST_DIR!, "guide.md")
  await writeFile(path, "# Example 1\nExisting source\n")
  await rememberCheckpoint(r.id, "Evidence: Example 1 lacks an integrating-factor derivation. Remaining: edit Example 1 only.")
  await rememberRead(r.id, { path, revision: await revision(path), start: 1, end: 2, limit: 22, partial: false })
  for (let i = 0; i < 3; i++) {
    await r.call("read", { path, limit: 22 })
    await r.call("grep", { path, pattern: `different-${i}` })
  }
  await assert.rejects(r.call("read", { path, limit: 22 }), /CHILD_LOOP_ABORTED/)
  assert.deepEqual(r.interrupts, [r.id])
  const part = { type: "tool-result", name: "subagent", result: { type: "error-text", value: `Subagent cancelled (sessionID: ${r.id})` } }
  if (r.hooks.context) await r.hooks.context({ sessionID: "parent", messages: [{ role: "tool", content: [part] }] })
  assert.match(part.result.value, /CHILD_LOOP_ABORTED.*repeated-read loop stopped/)
  assert.match(part.result.value, /Example 1 lacks an integrating-factor derivation/)
  assert.match(part.result.value, /confirmed lines 1-2/)
  assert.match(part.result.value, /not proof of review or edits/)
  assert.equal(part.result.type, "error-text")
  const nativePart = { type: "tool-result", name: "subagent", result: { type: "error", value: { error: { type: "tool.execution", message: `Subagent cancelled (sessionID: ${r.id})` }, content: [] as any[] } } }
  await r.hooks.context({ messages: [{ content: [nativePart] }] })
  assert.equal(nativePart.result.type, "error")
  assert.equal(nativePart.result.value.error.type, "tool.execution")
  assert.match(nativePart.result.value.error.message, /CHILD_LOOP_ABORTED/)
  // A fresh plugin instance must recover the same reason after a reload.
  const resumed = await runtime()
  const resumedPart = { type: "tool-result", name: "subagent", result: { type: "error-text", value: `Subagent cancelled (sessionID: ${r.id})` } }
  await resumed.hooks.context({ messages: [{ content: [resumedPart] }] })
  assert.match(resumedPart.result.value, /CHILD_LOOP_ABORTED/)
})

test("changed source revisions reopen reads; persisted visits block a resumed loop", async () => {
  const r = await runtime()
  const path = join(process.env.OPENCODE_PROGRESS_TEST_DIR!, "changed.md")
  await writeFile(path, "before\n")
  await rememberRead(r.id, { path, revision: await revision(path), start: 1, end: 1, limit: 22, partial: false })
  await rememberRead(r.id, { path, revision: await revision(path), start: 1, end: 1, limit: 22, partial: false })
  await rememberRead(r.id, { path, revision: await revision(path), start: 1, end: 1, limit: 22, partial: false })
  await assert.rejects(r.call("read", { path, limit: 22 }), /CHILD_LOOP_ABORTED/)
  await writeFile(path, "after with changed size\n")
  await r.call("read", { path, limit: 22 })
})

test("warns on third identical result, blocks fourth, and ignores parent sessions", async () => {
  const child = await runtime()
  for (let i = 0; i < 3; i++) await child.call("shell", { command: "pwd" })
  await assert.rejects(child.call("shell", { command: "pwd" }), /CHILD_LOOP_ABORTED/)
  const parent = await runtime(false)
  for (let i = 0; i < 5; i++) await parent.call("shell", { command: "pwd" })
  assert.equal(parent.interrupts.length, 0)
})

test("changed output, metadata, or intervening successful calls break a shell streak", async () => {
  const r = await runtime()
  await r.call("shell", { command: "pwd" }, "a")
  await r.call("shell", { command: "pwd" }, "b")
  await r.call("shell", { command: "pwd" }, "b", { changed: true })
  await r.call("shell", { command: "other" })
  await r.call("shell", { command: "pwd" }, "b", { changed: true })
  assert.equal(r.interrupts.length, 0)
})

test("failed interruptions remain failures and preserve their actual reason", async () => {
  const r = await runtime(true, "interrupt denied")
  for (let i = 0; i < 3; i++) await r.call("shell", { command: "pwd" })
  await assert.rejects(r.call("shell", { command: "pwd" }), /CHILD_LOOP_ABORT_FAILED.*interrupt denied/)
  const part = { type: "tool-result", name: "task", result: { type: "error-text", value: `Subagent cancelled (sessionID: ${r.id})` } }
  if (r.hooks.context) await r.hooks.context({ messages: [{ content: [part] }] })
  assert.match(part.result.value, /CHILD_LOOP_ABORT_FAILED.*interrupt denied/)
  assert.doesNotMatch(part.result.value, /CHILD_LOOP_ABORTED/)
})

test("unrelated cancellations and completed results are preserved", async () => {
  const r = await runtime()
  const parts = [
    { type: "tool-result", name: "subagent", result: { type: "error-text", value: "Subagent cancelled (sessionID: unrelated)" } },
    { type: "tool-result", name: "subagent", result: { type: "text", value: "STATUS: DONE" } },
    { type: "tool-result", name: "read", result: { type: "text", value: `Subagent cancelled (sessionID: ${r.id})` } },
  ]
  const before = JSON.stringify(parts)
  if (r.hooks.context) await r.hooks.context({ messages: [{ content: parts }] })
  assert.equal(JSON.stringify(parts), before)
})
