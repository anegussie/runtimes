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
})
