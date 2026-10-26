import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../plugins/zzzzz-bonsai-no-thinking.ts"

const model = { providerID: "local-llama", id: "bonsai-27b-splash" }
const request = (body: any, path = "/v1/chat/completions") => new Request(`http://localhost${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-keep": "yes" }, body: JSON.stringify(body),
})
async function legacy() {
  let hook: any
  await plugin.setup({ session: { hook: async (_: string, fn: any) => { hook = fn } } })
  return async (kind: string, body: any, selected = model) => {
    const event = { kind, model: selected, request: request(body) }
    await hook(event)
    return { body: await event.request.json(), request: event.request }
  }
}
test("primary, worker and every auxiliary kind force thinking off and bounded output", async () => {
  const call = await legacy()
  for (const kind of ["primary", "title", "compaction", "generate", "other"]) {
    const result = await call(kind, { messages: [{ role: "user", content: "unchanged" }], reasoning_effort: "low", max_tokens: 24006, chat_template_kwargs: { enable_thinking: true, keep: 7 } })
    assert.equal(result.body.reasoning_effort, "none")
    assert.equal(result.body.max_tokens, kind === "title" ? 128 : 4096)
    assert.deepEqual(result.body.chat_template_kwargs, { enable_thinking: false, keep: 7 })
    assert.deepEqual(result.body.messages, [{ role: "user", content: "unchanged" }])
    assert.equal(result.request.headers.get("x-keep"), "yes")
  }
})
test("smaller budgets, alternate token field, tools and Heretic profile are preserved", async () => {
  const call = await legacy()
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
  const { body } = await call("primary", { max_tokens: 200, max_completion_tokens: 96, reasoningEffort: "high", tools, tool_choice: "auto" }, { ...model, id: "bonsai-heretic-27b-splash" })
  assert.equal(body.max_tokens, 96)
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.reasoningEffort, undefined)
  assert.deepEqual(body.tools, tools)
  assert.equal(body.tool_choice, "auto")
  for (const value of [null, 0, -1, "100", 1.5]) assert.equal((await call("generate", { max_tokens: value })).body.max_tokens, 4096)
})
test("unrelated models are unchanged", async () => {
  const call = await legacy(), input = { reasoning_effort: "high", max_tokens: 10000 }
  assert.deepEqual((await call("primary", input, { ...model, id: "qwen-reasoner" })).body, input)
  assert.deepEqual((await call("primary", input, { ...model, providerID: "cloud" })).body, input)
})
test("Qwen primary and auxiliary requests disable thinking with profile-specific caps", async () => {
  const call = await legacy(), selected = { ...model, id: "qwen3.6-35b-a3b-iq3-xxs-splash" }
  for (const kind of ["primary", "title", "compaction", "generate", "other"]) {
    const result = await call(kind, { reasoning_effort: "low", max_tokens: 24006,
      chat_template_kwargs: { enable_thinking: true } }, selected)
    assert.equal(result.body.max_tokens, kind === "title" ? 64 : 2048)
    assert.equal(result.body.reasoning_effort, "none")
    assert.equal(result.body.chat_template_kwargs.enable_thinking, false)
  }
  const tools = [{ type: "function", function: { name: "read" } }]
  const { body } = await call("title", { max_completion_tokens: 32, tools, tool_choice: "auto" }, selected)
  assert.equal(body.max_tokens, 32)
  assert.equal(body.max_completion_tokens, undefined)
  assert.deepEqual(body.tools, tools)
  assert.equal(body.tool_choice, "auto")
})
test("v2 SDK final fetch covers auxiliary options and preserves custom transport", async () => {
  let hook: any, captured: any
  await plugin.setup({ aisdk: { sdk: async (fn: any) => { hook = fn } } })
  const event = { model, options: { fetch: async (req: Request) => { captured = req; return new Response("ok") } } }
  await hook(event)
  const response = await event.options.fetch(request({ reasoning_effort: "low" }))
  assert.equal(await response.text(), "ok")
  const body = await captured.json()
  assert.equal(body.reasoning_effort, "none")
  assert.equal(body.max_tokens, 4096)
  await event.options.fetch(request({ keep: true }, "/v1/embeddings"))
  assert.deepEqual(await captured.json(), { keep: true })
  const qwen = { model: { ...model, id: "qwen3.6-35b-a3b-iq3-xxs-splash" }, options: { fetch: event.options.fetch } }
  await hook(qwen)
  await qwen.options.fetch(request({ reasoning_effort: "low", max_tokens: 24006 }))
  const qwenBody = await captured.json()
  assert.equal(qwenBody.max_tokens, 2048)
  assert.equal(qwenBody.reasoning_effort, "none")
  assert.equal(qwenBody.chat_template_kwargs.enable_thinking, false)
})

test("IQ3 editing roles get 4096 only from trusted same-session same-model native context", async () => {
  const hooks: any = {}
  await plugin.setup({ session: { hook: async (name: string, fn: any) => { hooks[name] = fn } } })
  const selected = { ...model, id: "qwen3.6-35b-a3b-iq3-xxs-splash" }
  const send = async (sessionID: string, kind = "primary", body: any = {}, wireModel = selected) => {
    const event = { sessionID, kind, model: wireModel, request: request(body), agent: "general_worker" }
    await hooks["http.request"](event)
    return event.request.json()
  }
  assert.equal((await send("missing")).max_tokens, 2048, "wire agent field cannot grant a role")
  for (const agent of ["general_worker", "context_worker"]) {
    await hooks.context({ sessionID: agent, agent, model: selected })
    assert.equal((await send(agent)).max_tokens, 4096)
    assert.equal((await send(agent)).max_tokens, 2048, "request-only session reuse has no worker grant")
    await hooks.context({ sessionID: agent, agent, model: selected })
    assert.equal((await send(agent, "primary", { max_tokens: 512, max_completion_tokens: 128 })).max_tokens, 128)
    for (const kind of ["generate", "compaction", "other", "title"])
      assert.equal((await send(agent, kind)).max_tokens, kind === "title" ? 64 : 2048)
    assert.equal((await send(agent, "primary", {}, { ...selected, id: "qwen-reasoner" })).max_tokens, undefined)
    await hooks.context({ sessionID: agent, agent: "router", model: selected })
    assert.equal((await send(agent)).max_tokens, 2048, "changed agent revokes prior worker grant")
    await hooks.context({ sessionID: agent, agent, model: selected })
    await hooks.context({ sessionID: agent, agent, model: { ...selected, id: "other" } })
    assert.equal((await send(agent)).max_tokens, 2048, "changed model revokes prior worker grant")
  }
  for (const agent of ["router", "general", "long_analysis", "unknown", undefined]) {
    await hooks.context({ sessionID: "parent", agent, model: selected })
    assert.equal((await send("parent")).max_tokens, 2048)
  }
  for (let index = 0; index < 129; index++)
    await hooks.context({ sessionID: `worker-${index}`, agent: "general_worker", model: selected })
  assert.equal((await send("worker-0")).max_tokens, 2048, "bounded role cache evicts oldest session")
  assert.equal((await send("worker-128")).max_tokens, 4096)
})
