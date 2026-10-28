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

async function review(r: Awaited<ReturnType<typeof runtime>>, path: string, objective = "Review the filtering behavior") {
  const event = { sessionID: r.id, messages: [{ role: "user", content: [{ type: "text", text:
    `OBJECTIVE: ${objective}\nTARGET: ${path} lines 1-100\nDONE WHEN: Return findings and missing verification.` }] }] }
  await r.hooks.context(event)
  return JSON.stringify(event.messages)
}
async function reviewFile(r: Awaited<ReturnType<typeof runtime>>) {
  const path = join(process.env.OPENCODE_PROGRESS_TEST_DIR!, `${r.id}.md`)
  await writeFile(path, Array.from({ length: 100 }, (_, i) => `source ${i + 1}`).join("\n"))
  await review(r, path)
  return path
}
const readRange = (r: Awaited<ReturnType<typeof runtime>>, path: string, start: number, end: number, metadata: any = {}) =>
  r.call("read", { path, offset: start, limit: end - start + 1 },
    Array.from({ length: end - start + 1 }, (_, i) => `${start + i}: source ${start + i}`).join("\n") +
      `\n[Output truncated. Continue reading with offset: ${end + 1}]`,
    { returnedStart: start, returnedEnd: end, partialLine: false, byteLimited: false, truncated: true, ...metadata })
const unchanged = (r: Awaited<ReturnType<typeof runtime>>, path: string, i: number) => i % 2
  ? r.call("grep", { path, pattern: `rephrased-${i}`, literal: false }, `Found 1 matches\n${path}:\n  Line 1: source 1`, { matches: 1, truncated: false })
  : readRange(r, path, 2 + i, 3 + i)

test("review warns on unchanged overlap/search evidence and stops only continued stagnation", async () => {
  const r = await runtime(), path = await reviewFile(r)
  await readRange(r, path, 1, 30)
  for (let i = 0; i < 4; i++) await unchanged(r, path, i)
  assert.match(await review(r, path), /REVIEW_EVIDENCE_STALLED/)
  assert.deepEqual(r.interrupts, [])
  for (let i = 4; i < 6; i++) await unchanged(r, path, i)
  await assert.rejects(unchanged(r, path, 6), /CHILD_LOOP_ABORTED: review stagnation/)
  assert.deepEqual(r.interrupts, [r.id])
  const part = { type: "tool-result", name: "subagent", result: { type: "error-text", value: `Subagent cancelled (sessionID: ${r.id})` } }
  await r.hooks.context({ messages: [{ content: [part] }] })
  assert.match(part.result.value, /review stagnation/)
  assert.match(part.result.value, /did not authorize edits/)
  assert.match(part.result.value, /LAST COMPLETED TOOL/)
})

test("review has no total tool budget and accepts new read ranges and match locations", async () => {
  const r = await runtime(), path = await reviewFile(r)
  for (let i = 1; i <= 25; i++) {
    await readRange(r, path, i, i)
    await r.call("grep", { path, pattern: `fresh-${i}`, literal: false }, `${path}:${50 + i}: new match`)
  }
  assert.deepEqual(r.interrupts, [])
  assert.doesNotMatch(await review(r, path), /REVIEW_EVIDENCE_STALLED/)
})

test("grep locations do not claim that the full source line was delivered", async () => {
  const r = await runtime(), path = await reviewFile(r)
  await readRange(r, path, 1, 30)
  await r.call("grep", { path, pattern: "line-90", literal: false }, `${path}:90: short match snippet`)
  await readRange(r, path, 2, 3)
  await r.call("grep", { path, pattern: "rephrased-90", literal: false }, `${path}:90: short match snippet`)
  await readRange(r, path, 4, 5)
  await readRange(r, path, 90, 90)
  assert.doesNotMatch(await review(r, path), /REVIEW_EVIDENCE_STALLED/)
})

test("source changes, a new assigned review lens, and compaction allow necessary rereads", async () => {
  for (const reset of ["revision", "lens", "compaction"]) {
    const r = await runtime(), path = await reviewFile(r)
    await readRange(r, path, 1, 30)
    for (let i = 0; i < 4; i++) await unchanged(r, path, i)
    if (reset === "revision") await writeFile(path, "changed source revision\n")
    if (reset === "lens") await review(r, path, "Review accessibility instead of filtering")
    if (reset === "compaction") { await r.hooks.compaction({ sessionID: r.id }); await review(r, path) }
    await readRange(r, path, 5, 6)
    assert.deepEqual(r.interrupts, [], reset)
    assert.doesNotMatch(await review(r, path, reset === "lens" ? "Review accessibility instead of filtering" : undefined), /REVIEW_EVIDENCE_STALLED/, reset)
  }
})

test("partial delivery and truncated search results do not prove review stagnation", async () => {
  for (const partial of ["byteLimited", "partialLine", "grep"]) {
    const r = await runtime(), path = await reviewFile(r)
    await readRange(r, path, 1, 30)
    for (let i = 0; i < 4; i++) await unchanged(r, path, i)
    if (partial === "grep") await r.call("grep", { path, pattern: "partial" }, "No matches found", { matches: 0, truncated: true })
    else await readRange(r, path, 10, 11, { [partial]: true })
    assert.doesNotMatch(await review(r, path), /REVIEW_EVIDENCE_STALLED/)
    assert.deepEqual(r.interrupts, [])
  }
})

test("behavioral checks reset research stagnation and implementation tasks are excluded", async () => {
  const r = await runtime(), path = await reviewFile(r)
  await readRange(r, path, 1, 30)
  for (let i = 0; i < 4; i++) await unchanged(r, path, i)
  await r.call("shell", { command: "node check.cjs" }, { stdout: "Behavior verified", exit: 0 })
  assert.doesNotMatch(await review(r, path), /REVIEW_EVIDENCE_STALLED/)
  for (const objective of ["Review and fix the filtering behavior", "Review the filtering; implement corrections"]) {
    await review(r, path, objective)
    for (let i = 0; i < 10; i++) await unchanged(r, path, i)
  }
  assert.deepEqual(r.interrupts, [])
})

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
