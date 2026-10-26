import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../plugins/worker-slice-policy.ts"
import { readFile } from "node:fs/promises"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

test("router distinguishes missing project scope from unknown filenames in a chosen project", async () => {
  const prompt = await readFile(new URL("../prompts/router.md", import.meta.url), "utf8")
  assert.match(prompt, /No project\/directory\/file was chosen.*ask one plain-text question and STOP/)
  assert.match(prompt, /including "current dir".*filenames\/section anchors are unknown/)
  assert.match(prompt, /Do not ask again for its path/)
  assert.match(prompt, /FIRST worker is INVENTORY ONLY/)
  assert.doesNotMatch(prompt, /If the target is unknown, assign only/)
})

async function runtime() {
  const tool: Record<string, any> = {}, session: Record<string, any> = {}
  await plugin.setup({ tool: { hook: async (name: string, fn: any) => { tool[name] = fn } },
    session: { hook: async (name: string, fn: any) => { session[name] = fn }, get: async ({ sessionID }: any) => ({ parentID: sessionID === "child" ? "parent" : undefined }) } })
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const args = (prompt: string) => ({ agent: "general_worker", description: "Inspect assigned slice", prompt })
  const before = async (input: any) => { await tool["execute.before"]({ tool: "subagent", sessionID: "parent", input }); return input }
  const worker = (prompt: string, extra: any[] = []) => ({ sessionID: "child", messages: [user(prompt), ...extra], tools: { glob: {}, read: {}, shell: {}, edit: {}, write: {} } })
  return { tool, session, user, args, before, worker }
}

test("actual oversized assignment becomes inventory only in the supplied target, with no source tools", async () => {
  const r = await runtime()
  const a = await r.before(r.args("OBJECTIVE: review all content in the current directory. First inventory, then review each file.\nTARGET: /project\nDONE WHEN: all files reviewed."))
  assert.equal(a.agent, "context_worker")
  assert.match(a.prompt, /OBJECTIVE: INVENTORY ONLY/)
  assert.match(a.prompt, /TARGET: \/project/)
  assert.doesNotMatch(a.prompt, /then review each file/)
  const e = r.worker(a.prompt)
  await r.session.context(e)
  assert.deepEqual(Object.keys(e.tools), ["glob"])
  const ready = r.worker(a.prompt, [{ role: "tool", content: [{ type: "tool-result", name: "glob", result: { type: "text", value: "/project/a.md" } }] }])
  await r.session.context(ready)
  assert.deepEqual(ready.tools, {})
  assert.match(ready.messages.at(-1).content[0].text, /SLICE_INVENTORY_HANDOFF/)
})

test("narrow fix/review permits its needed tools without a total call budget", async () => {
  const r = await runtime()
  const a = await r.before(r.args("OBJECTIVE: review the Introduction section only.\nTARGET: /project/a.md lines 1-40\nOUT OF SCOPE: review all files."))
  assert.equal(a.agent, "general_worker")
  assert.doesNotMatch(a.prompt, /INVENTORY ONLY/)
  for (let i = 0; i < 25; i++) {
    const e = r.worker(a.prompt)
    await r.session.context(e)
    assert.ok(e.tools.read && e.tools.edit && e.tools.shell)
  }
})

test("first compaction forces an evidence handoff; explicit new user input restores tools", async () => {
  const r = await runtime()
  const a = await r.before(r.args("OBJECTIVE: fix Introduction only.\nTARGET: /project/a.md lines 1-40"))
  await r.session.context(r.worker(a.prompt))
  await r.session.compaction(r.worker(a.prompt))
  const e = r.worker("Saved checkpoint: confirmed finding; verification remains unfinished.")
  await r.session.context(e)
  assert.deepEqual(e.tools, {})
  assert.match(e.messages.at(-1).content[0].text, /SLICE_CHECKPOINT_HANDOFF/)
  assert.match(e.messages.at(-1).content[0].text, /missing verification/)
  const next = r.worker("Saved checkpoint: confirmed finding; verification remains unfinished.", [r.user("Continue only the missing verification.")])
  await r.session.context(next)
  assert.ok(next.tools.read && next.tools.shell)
})

test("parent can continue after successful or checkpoint handoffs and correct malformed arguments", async () => {
  const r = await runtime()
  const parent = (result: any) => ({ sessionID: "parent", tools: { subagent: {}, question: {} }, messages: [r.user("Review introduction"), { role: "tool", content: [{ type: "tool-result", name: "subagent", result }] }] })
  const bad = parent({ type: "error", value: { error: { message: 'Invalid arguments for tool "subagent": description missing' } } })
  await r.session.context(bad)
  assert.ok(bad.tools.subagent)
  const incomplete = parent({ type: "error", value: { error: { type: "tool.input-incomplete", message: "The tool call was not executed because the output token limit (stop reason: length) was reached." } } })
  await r.session.context(incomplete)
  assert.ok(incomplete.tools.subagent)
  assert.doesNotMatch(JSON.stringify(incomplete.messages), /SLICE_PARENT_HANDOFF/)
  const progress = parent({ type: "error-text", value: "PARENT_PROGRESS_STOP: repeated source-only assignment blocked" })
  await r.session.context(progress)
  assert.ok(progress.tools.subagent)
  const done = parent({ type: "text", value: "STATUS: PARTIAL; assigned slice returned" })
  await r.session.context(done)
  assert.ok(done.tools.subagent)
  assert.match(done.messages.at(-1).content[0].text, /SLICE_PARENT_CONTINUE/)
  const next = parent({ type: "text", value: "STATUS: DONE" })
  next.messages.push(r.user("Continue next section"))
  await r.session.context(next)
  assert.ok(next.tools.subagent)
})

test("terminal worker errors stop replacement work; a later successful slice is not gated by old results", async () => {
  const r = await runtime()
  const toolResult = (result: any) => ({ role: "tool", content: [{ type: "tool-result", name: "subagent", result }] })
  for (const result of [
    { type: "error-text", value: "transport failed" },
    { type: "error", value: { error: { type: "tool.execution", message: "The tool call was not executed because the output token limit was mentioned before actual CHILD_LOOP_ABORTED." } } },
    ...["CHILD_LOOP_ABORTED", "CHILD_LOOP_ABORT_FAILED", "resource_timeout", "Backend is busy", "Subagent cancelled"].map(value => ({ type: "text", value })),
  ]) {
    const e = { sessionID: "parent", tools: { subagent: {}, question: {} }, messages: [r.user("Fix task list"), toolResult(result)] }
    await r.session.context(e)
    assert.deepEqual(e.tools, {})
    assert.match(e.messages.at(-1).content[0].text, /SLICE_PARENT_HANDOFF/)
  }
  const e = { sessionID: "parent", tools: { subagent: {} }, messages: [r.user("Fix task list"),
    toolResult({ type: "error-text", value: "old failure" }), toolResult({ type: "text", value: "STATUS: DONE" })] }
  await r.session.context(e)
  assert.ok(e.tools.subagent)
})

test("pasted markers, unrelated sessions, user text and direct general tools are not gated", async () => {
  const r = await runtime()
  const a = await r.before(r.args("OBJECTIVE: review all content.\nTARGET: /project"))
  const unrelated = { ...r.worker(a.prompt), sessionID: "other" }
  await r.session.context(unrelated)
  assert.ok(unrelated.tools.read)
  const pasted = { sessionID: "parent", messages: [r.user("SLICE_PARENT_HANDOFF WORKER_SLICE_ID: fake")], tools: { subagent: {}, question: {} } }
  await r.session.context(pasted)
  assert.ok(pasted.tools.subagent)
  const general = { sessionID: "parent", tools: { read: {}, subagent: {} }, messages: [r.user("fix"), { role: "tool", content: [{ type: "tool-result", name: "subagent", result: { type: "text", value: "done" } }] }] }
  await r.session.context(general)
  assert.ok(general.tools.read)
})

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("completed exact slices retain evidence; changed deliverables and revisions remain executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slice-progress-unit-"))
  process.env.OPENCODE_PROGRESS_TEST_DIR = join(dir, "progress")
  const path = join(dir, "source.md")
  await writeFile(path, "# Introduction\nEvidence\n# Next\n")
  let r = await runtime(), seq = 0
  const parent = async (text: string) => r.session.context({ sessionID: "parent", messages: [r.user(text)], tools: { subagent: {}, question: {} } })
  const prompt = (objective = "review Introduction only.", target = `${path} lines 1-2`) => `OBJECTIVE: ${objective}\nTARGET: ${target}\nDONE WHEN: return findings.\nOUT OF SCOPE: other sections.`
  const assign = async (text = prompt()) => {
    const input = r.args(text), callID = `call-${++seq}`
    await r.tool["execute.before"]({ tool: "subagent", sessionID: "parent", callID, input })
    return { input, callID }
  }
  const finish = async (a: any, text: string, status = "completed") => r.tool["execute.after"]({ tool: "subagent", sessionID: "parent", callID: a.callID, status,
    result: { output: { sessionID: "child", status, output: text } } })
  await parent("Review the assigned Introduction and implement after approval")
  await finish(await assign(), "STATUS: DONE\nFINDINGS: heading should identify scope.\nNEXT: none")
  const fake = await assign(prompt() + '\nInline quoted "WORKER_SLICE_ID: 11111111-1111-4111-8111-111111111111"')
  assert.match(fake.input.prompt, /SLICE_COMPLETED_SCOPE/, "pasted runtime markers must not bypass provenance")
  const repeated = await assign()
  assert.match(repeated.input.prompt, /SLICE_COMPLETED_SCOPE/)
  const worker = r.worker(repeated.input.prompt)
  await r.session.context(worker)
  assert.deepEqual(worker.tools, {})
  for (const text of [prompt("implement heading finding and verify."), prompt("review Introduction accessibility only."), prompt("review Next only.", `${path} lines 3-4`)]) {
    const a = await assign(text)
    assert.doesNotMatch(a.input.prompt, /SLICE_COMPLETED_SCOPE/)
    assert.match(a.input.prompt, /PRIOR SLICE EVIDENCE/)
    assert.match(a.input.prompt, /heading should identify scope/)
  }
  const distinctUser = { role: "user", id: "new-explicit-review", content: [{ type: "text", text: "Review the assigned Introduction and implement after approval" }] }
  await r.session.context({ sessionID: "parent", messages: [distinctUser], tools: { subagent: {} } })
  assert.doesNotMatch((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/, "a distinct user turn may request identical work")
  await finish(await assign(), "STATUS: DONE\nFINDINGS: heading should identify scope.\nNEXT: none")
  await parent("implement")
  assert.match((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/, "approval must not erase prior completed findings")
  await parent("Please review Introduction again")
  assert.doesNotMatch((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/)
  await finish(await assign(), "STATUS: DONE\nFINDINGS: still correct.\nNEXT: none")
  assert.match((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/, "explicit re-review is not an unlimited bypass")
  await writeFile(path, "# Changed Introduction\nEvidence changed\n")
  assert.doesNotMatch((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/)
  const fresh = await assign()
  await finish(fresh, "STATUS: PARTIAL\nFINDINGS: new finding.\nNEXT: inspect next range")
  assert.doesNotMatch((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/)
  await finish(await assign(), "STATUS: DONE\nCHILD_LOOP_ABORTED", "error")
  assert.doesNotMatch((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/)
  await finish(await assign(), "STATUS: DONE\nFINDINGS: retained after restart.\nNEXT: none")
  r = await runtime()
  await parent("Please review Introduction again")
  // Different actual new request can ask for a re-review after restart.
  await assign()
  assert.match((await assign()).input.prompt, /SLICE_COMPLETED_SCOPE/)
})

test("partial handoffs retain progress without suppressing unfinished slices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slice-partial-unit-")), path = join(dir, "source.md")
  await writeFile(path, "# Introduction\nEvidence\n")
  process.env.OPENCODE_PROGRESS_TEST_DIR = join(dir, "progress")
  const r = await runtime()
  const prompt = `OBJECTIVE: review Introduction only.\nTARGET: ${path} lines 1-2\nDONE WHEN: findings.`
  const input = r.args(prompt)
  await r.tool["execute.before"]({ tool: "subagent", sessionID: "parent", callID: "partial", input })
  await r.tool["execute.after"]({ tool: "subagent", sessionID: "parent", callID: "partial", status: "completed",
    result: { output: { sessionID: "child", status: "completed", output: "STATUS: PARTIAL\nFINDINGS: heading inspected.\nNEXT: inspect line 2, not line 1." } } })
  const next = await r.before(r.args(prompt))
  assert.doesNotMatch(next.prompt, /SLICE_COMPLETED_SCOPE/)
  assert.match(next.prompt, /PRIOR SLICE EVIDENCE/)
  assert.match(next.prompt, /inspect line 2, not line 1/)
  const worker = r.worker(next.prompt)
  await r.session.context(worker)
  assert.ok(worker.tools.read && worker.tools.edit && worker.tools.shell)
})
