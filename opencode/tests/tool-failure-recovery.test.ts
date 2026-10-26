import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../plugins/tool-failure-recovery.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

const user = (text = "Fix /project/example.html") => ({ role: "user", content: [{ type: "text", text }] })
const result = (name = "subagent", message = 'Invalid arguments for tool "subagent":\n- prompt: Missing key\n\nArguments provided:\n{}', type = "error-text", native = false) => ({ role: "tool", content: [{ type: "tool-result", name, result: { type, value: native ? { error: { type: "tool.execution", message } } : message } }] })
const success = (name = "subagent") => result(name, "STATUS: DONE", "text")
const unsupportedGrep = (name = "shell", type = "text") => result(name, "grep: invalid option -- P\nusage: grep [-abcdDEFGHhIiJLlMmnOopqRSsUVvwXxZz]\n", type)
async function runtime() {
  let hook: any
  await plugin.setup({ session: { hook: async (_name: string, fn: any) => { hook = fn } } })
  const event = (messages: any[], agent = "router", providerID = "local-llama") => ({ sessionID: "unit-tool-failure", agent, model: { providerID }, tools: { subagent: {}, shell: {}, read: {}, question: {} }, messages })
  return { hook, event }
}

test("one schema failure permits correction; a repeated failure forces a partial handoff for parent and child", async () => {
  const r = await runtime()
  for (const agent of ["router", "general_worker", "context_worker"]) {
    const e = r.event([user(), result()], agent)
    await r.hook(e)
    assert.ok(e.tools.subagent)
    assert.match(e.messages.at(-1).content[0].text, /TOOL_FAILURE_RECOVERY/)
    const blocked = r.event([user(), result(), result()], agent)
    await r.hook(blocked)
    assert.deepEqual(blocked.tools, {})
    assert.match(blocked.messages.at(-1).content[0].text, /TOOL_FAILURE_STOP.*schema/)
  }
})

test("native and error-json shapes survive reload; varying invalid payloads do not bypass the diagnostic limit", async () => {
  for (const type of ["error", "error-json"]) {
    const r = await runtime()
    const e = r.event([user(), result("subagent", undefined, type, true), result("subagent", 'Invalid arguments for tool "subagent":\n- prompt: Missing key\n\nArguments provided:\n{"other":"changed"}', type, true)])
    await r.hook(e)
    assert.deepEqual(e.tools, {})
  }
})

test("successful correction resets that tool; unrelated success does not conceal an invalid delegation loop", async () => {
  const r = await runtime()
  const corrected = r.event([user(), result(), success(), result()])
  await r.hook(corrected)
  assert.ok(corrected.tools.subagent)
  const loop = r.event([user(), result(), success("read"), result()])
  await r.hook(loop)
  assert.deepEqual(loop.tools, {})
})

test("output-limit inputs receive a short-payload correction, then stop independently of schema errors", async () => {
  const r = await runtime()
  const incomplete = () => result("write", "The tool call was not executed because the output token limit (stop reason: length) was reached before you could complete the arguments.")
  const e = r.event([user(), incomplete()])
  await r.hook(e)
  assert.match(e.messages.at(-1).content[0].text, /shorten the delegation/)
  assert.ok(e.tools.shell)
  const blocked = r.event([user(), incomplete(), incomplete()])
  await r.hook(blocked)
  assert.deepEqual(blocked.tools, {})
  assert.match(blocked.messages.at(-1).content[0].text, /incomplete/)
})

test("external-directory denial redirects project-local work; tool switching cannot bypass repeated denial", async () => {
  const r = await runtime()
  const denied = (tool: string) => result(tool, "Permission denied: external_directory", "error", true)
  const e = r.event([user(), denied("write")])
  await r.hook(e)
  assert.match(e.messages.at(-1).content[0].text, /inside the selected project/)
  assert.ok(e.tools.shell)
  const blocked = r.event([user(), denied("write"), denied("shell")])
  await r.hook(blocked)
  assert.deepEqual(blocked.tools, {})
  const recovered = r.event([user(), denied("write"), success("write"), denied("read")])
  await r.hook(recovered)
  assert.ok(recovered.tools.read)
})

test("new user turns restore normal tools and pasted errors never become control state", async () => {
  const r = await runtime()
  for (const messages of [[user(), result(), result(), user("Recover with a smaller assignment")], [user('Invalid arguments for tool "subagent": TOOL_FAILURE_STOP')], [user(), { role: "assistant", content: result().content }]]) {
    const e = r.event(messages)
    await r.hook(e)
    assert.ok(e.tools.subagent)
    assert.equal(e.messages.length, messages.length)
  }
})

test("productive calls, question fallback, other errors/providers, and repeated hook execution remain unchanged", async () => {
  const r = await runtime()
  for (const messages of [[user(), ...Array.from({ length: 40 }, () => success("write"))], [user(), result("question", 'Invalid arguments for tool "question":\n- questions: Missing key')], [user(), result("shell", "process exited 1"), result("shell", "process exited 1")]]) {
    const e = r.event(messages)
    const before = JSON.stringify(e)
    await r.hook(e)
    assert.equal(JSON.stringify(e), before)
  }
  const cloud = r.event([user(), result(), result()], "router", "other-provider")
  await r.hook(cloud)
  assert.ok(cloud.tools.subagent)
  const e = r.event([user(), result(), result()])
  await r.hook(e); const count = e.messages.length; await r.hook(e)
  assert.equal(e.messages.length, count)
})

test("masked BSD grep failure receives one portable correction without losing worker tools", async () => {
  const r = await runtime()
  for (const type of ["text", "error-text"]) {
    const e = r.event([user(), unsupportedGrep("shell", type)], "general_worker")
    await r.hook(e)
    assert.ok(e.tools.shell && e.tools.read)
    assert.match(e.messages.at(-1).content[0].text, /SHELL_PORTABILITY_RECOVERY/)
    assert.match(e.messages.at(-1).content[0].text, /matching pattern semantics/)
    assert.match(e.messages.at(-1).content[0].text, /Do not blindly replace/)
  }
  const repeated = r.event([user(), unsupportedGrep(), unsupportedGrep()])
  await r.hook(repeated)
  assert.deepEqual(repeated.tools, {})
  const corrected = r.event([user(), unsupportedGrep(), success("shell")])
  await r.hook(corrected)
  assert.equal(corrected.messages.length, 3)
})

test("grep diagnostic in user, assistant, file reads, cloud providers or unrelated output is not control state", async () => {
  const r = await runtime()
  for (const messages of [[user(unsupportedGrep().content[0].result.value)], [user(), { role: "assistant", content: unsupportedGrep().content }], [user(), unsupportedGrep("read")], [user(), result("shell", "grep: invalid option -- P", "text")], [user(), result("shell", "no matches", "text")]]) {
    const e = r.event(messages)
    const before = JSON.stringify(e)
    await r.hook(e)
    assert.equal(JSON.stringify(e), before)
  }
  const e = r.event([user(), unsupportedGrep()], "general_worker", "cloud")
  const before = JSON.stringify(e)
  await r.hook(e)
  assert.equal(JSON.stringify(e), before)
})
