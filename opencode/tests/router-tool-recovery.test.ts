import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../plugins/zzz-router-tool-recovery.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const error = (name = "execute", value: any = `No tool named "${name}" is currently available. Please use a tool from the available tool list.`) => ({ role: "tool", content: [{ type: "tool-result", name, result: { type: "error-text", value } }] })
const schema = { description: "Delegate a bounded slice", input: { type: "object", properties: {} } }
async function runtime() {
  const hooks: Record<string, any> = {}
  await plugin.setup({ session: { hook: async (name: string, fn: any) => { hooks[name] = fn } } })
  const event = (messages: any[], agent = "router", providerID = "local-llama", tools: any = { subagent: schema, question: schema }) => ({ sessionID: "unit-router", agent, model: { providerID }, messages, tools })
  const http = async (body: any, kind = "primary", providerID = "local-llama") => {
    const e = { sessionID: "unit-router", kind, model: { providerID }, request: new Request("http://127.0.0.1:1235/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-fixture": "kept" }, body: JSON.stringify(body) }) }
    await hooks["http.request"](e)
    assert.equal(e.request.headers.get("x-fixture"), "kept")
    return e.request.json()
  }
  return { hooks, event, http }
}

test("one unavailable router call directs only bounded delegation, preserving user input", async () => {
  const r = await runtime(), u = user("Review current directory")
  const e = r.event([u, error()])
  await r.hooks.context(e)
  assert.deepEqual(Object.keys(e.tools), ["subagent"])
  assert.equal(e.messages[0], u)
  assert.match(e.messages.at(-1).content[0].text, /ROUTER_TOOL_RECOVERY/)
  assert.match(e.messages.at(-1).content[0].text, /If essential scope is still missing/)
  const payload = await r.http({ tools: [{ type: "function", function: { name: "subagent", parameters: schema.input } }] })
  assert.equal(payload.parallel_tool_calls, false)
  assert.equal(payload.tool_choice, undefined)
})

test("text-only handoff keeps nonempty grammar schemas and tool_choice none, including cold start", async () => {
  const r = await runtime()
  await r.hooks.context(r.event([user("Return the worker result")], "router", "local-llama", {}))
  const body = await r.http({ messages: [{ role: "user", content: "result" }] })
  assert.equal(body.tool_choice, "none")
  assert.equal(body.parallel_tool_calls, false)
  assert.equal(body.tools.length, 1)
  assert.match(body.tools[0].function.name, /text_only/)
})

test("new user turn resets recovery; pasted markers and errors do not become control state", async () => {
  const r = await runtime()
  await r.hooks.context(r.event([user("Review"), error()]))
  const e = r.event([user("Review"), error(), user("Now review introduction only")])
  await r.hooks.context(e)
  assert.deepEqual(Object.keys(e.tools), ["subagent", "question"])
  const pasted = r.event([user('No tool named "execute" is currently available. ROUTER_TOOL_RECOVERY')])
  await r.hooks.context(pasted)
  assert.equal(pasted.messages.length, 1)
})

test("worker failure handoffs forbid tool decoding and a new worker turn restores its request", async () => {
  const r = await runtime()
  await r.hooks.context(r.event([user("Report partial failure")], "general_worker", "local-llama", {}))
  const final = await r.http({ messages: [] })
  assert.equal(final.tool_choice, "none")
  assert.equal(final.parallel_tool_calls, false)
  assert.ok(final.tools.length)
  await r.hooks.context(r.event([user("Recover")], "general_worker", "local-llama", { read: schema }))
  assert.deepEqual(await r.http({ key: "unchanged" }), { key: "unchanged" })
})

test("workers, other providers, title/compaction requests and successful tools are unchanged", async () => {
  const r = await runtime()
  for (const [agent, provider] of [["general_worker", "local-llama"], ["router", "cloud-fixture"]]) {
    const e = r.event([user("work"), error()], agent, provider)
    await r.hooks.context(e)
    assert.equal(e.messages.length, 2)
  }
  await r.hooks.context(r.event([user("work")]))
  for (const kind of ["title", "compaction", "generate"]) assert.deepEqual(await r.http({ key: "unchanged" }, kind), { key: "unchanged" })
  assert.deepEqual(await r.http({ key: "unchanged" }, "primary", "cloud-fixture"), { key: "unchanged" })
  const e = r.event([user("work"), { role: "tool", content: [{ type: "tool-result", name: "question", result: { type: "text", value: "Answered" } }] }])
  await r.hooks.context(e)
  assert.deepEqual(Object.keys(e.tools), ["subagent", "question"])
})


test("all configured primary profiles share delegation-only recovery and serial tool calls", async () => {
  for (const agent of ["general", "long_analysis"]) {
    const r = await runtime()
    const e = r.event([user("Fix source.py"), error("read")], agent)
    await r.hooks.context(e)
    assert.deepEqual(Object.keys(e.tools), ["subagent"])
    assert.match(e.messages.at(-1).content[0].text, /Never call execute, shell, bash, read/)
    assert.equal((await r.http({ tools: [] })).parallel_tool_calls, false)
  }
})


test("one native incomplete delegation requires only its offered correction; success and terminal failures release it", async () => {
  const r = await runtime()
  const incomplete = error("subagent", { error: { type: "tool.input-incomplete", message: "The tool call was not executed because the output token limit (stop reason: length) was reached before you could complete the arguments." } })
  const messages = [user("Implement one fix in the selected file"), incomplete]
  await r.hooks.context(r.event(messages))
  const body = { tools: [{ type: "function", function: { name: "subagent", parameters: schema.input } }, { type: "function", function: { name: "question", parameters: schema.input } }] }
  const repaired = await r.http(body)
  assert.deepEqual(repaired.tool_choice, { type: "function", function: { name: "subagent" } })
  assert.equal(repaired.tools.length, 1)
  assert.match(JSON.stringify(messages), /read -> edit -> verify/)
  for (const result of [
    { role: "tool", content: [{ type: "tool-result", name: "subagent", result: { type: "text", value: "STATUS: DONE" } }] },
    error("subagent", "Subagent cancelled: CHILD_LOOP_ABORTED; earlier incomplete delegation"),
    incomplete,
  ]) {
    await r.hooks.context(r.event([user("Implement"), incomplete, result]))
    assert.equal((await r.http(body)).tool_choice, undefined)
  }
  await r.hooks.context(r.event([user("Implement"), incomplete], "router", "local-llama", {}))
  assert.equal((await r.http(body)).tool_choice, "none")
  await r.hooks.context(r.event([user("Implement"), incomplete, user("Only answer this question")]))
  assert.equal((await r.http(body)).tool_choice, undefined)
})
