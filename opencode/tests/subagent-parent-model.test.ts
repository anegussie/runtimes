import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../plugins/zzzz-subagent-parent-model.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

const model = { providerID: "local-llama", id: "bonsai-27b-splash" }
async function runtime() {
  const hooks: Record<string, any> = {}, reads: string[] = []
  await plugin.setup({ session: {
    hook: async (name: string, fn: any) => { hooks[name] = fn },
    get: async ({ sessionID }: any) => {
      reads.push(sessionID)
      if (sessionID === "parent") return { model }
      if (sessionID === "valid-child") return { parentID: "parent" }
      if (sessionID === "foreign-child") return { parentID: "someone-else" }
      if (sessionID === "lookup-failed") throw Error("session API unavailable")
      throw Error(`Session not found: ${sessionID}`)
    },
  }, tool: { hook: async (name: string, fn: any) => { hooks[name] = fn } } })
  const call = async (input: any, tool = "subagent") => {
    await hooks["execute.before"]({ sessionID: "parent", tool, input })
    return input
  }
  return { hooks, reads, call }
}
test("exact failed model and stale session inputs are corrected before local dispatch", async () => {
  const r = await runtime()
  const input = await r.call({ agent: "context_worker", description: "Fix layout", prompt: "Fix selected file only", model: "provider/local-llama/bonsai-27b-splash", sessionID: "ses_01J9JvXJYdQXKqRgYyFpQdWv" })
  assert.equal(input.model, "local-llama/bonsai-27b-splash")
  assert.equal(input.sessionID, undefined)
  assert.equal(input.prompt, "Fix selected file only")
  assert.equal(input.agent, "context_worker")
})
test("resolved parent route and variant win over agent/default or generated overrides", async () => {
  const r = await runtime()
  await r.hooks.context({ sessionID: "parent", model: { ...model, id: "selected-parent", variant: "fast" } })
  assert.equal((await r.call({ agent: "general_worker", model: "other/model" })).model, "local-llama/selected-parent#fast")
  assert.deepEqual(r.reads, [])
  await r.hooks.context({ sessionID: "parent", model: { ...model, variant: "default" } })
  assert.equal((await r.call({ agent: "general_worker" }, "task")).model, "local-llama/bonsai-27b-splash")
})
test("valid child resumes are preserved; foreign IDs become fresh workers; lookup outages are surfaced", async () => {
  const r = await runtime()
  assert.equal((await r.call({ sessionID: "valid-child" })).sessionID, "valid-child")
  assert.equal((await r.call({ sessionID: "foreign-child" })).sessionID, undefined)
  await assert.rejects(r.call({ sessionID: "lookup-failed" }), /session API unavailable/)
})
test("wire schema omits model/session controls while preserving tools, payload and request headers", async () => {
  const r = await runtime()
  const input = { tools: [{ type: "function", function: { name: "subagent", parameters: { type: "object", properties: { agent: {}, model: {}, sessionID: {} }, required: ["agent"] } } }, { type: "function", function: { name: "read", parameters: { properties: { model: {} } } } }], messages: [{ role: "user", content: "Fix layout" }] }
  const event = { sessionID: "parent", kind: "primary", model, request: new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-keep": "yes" }, body: JSON.stringify(input) }) }
  await r.hooks["http.request"](event)
  const payload = await event.request.json()
  assert.deepEqual(Object.keys(payload.tools[0].function.parameters.properties), ["agent"])
  assert.deepEqual(payload.tools[1], input.tools[1])
  assert.deepEqual(payload.messages, input.messages)
  assert.equal(event.request.headers.get("x-keep"), "yes")
})
test("cloud sessions, non-delegation tools, and auxiliary requests remain unchanged", async () => {
  const r = await runtime()
  const input = { model: "user/value" }
  await r.call(input, "shell"); assert.deepEqual(input, { model: "user/value" })
  await r.hooks.context({ sessionID: "parent", model: { providerID: "cloud", id: "selected" } })
  assert.deepEqual(await r.call({ model: "cloud/selected" }), { model: "cloud/selected" })
  for (const change of [{ model: { providerID: "cloud" } }, { kind: "compaction" }]) {
    const e = { kind: "primary", model, request: new Request("http://localhost/v1/chat/completions"), ...change }
    const original = e.request; await r.hooks["http.request"](e); assert.equal(e.request, original)
  }
})
