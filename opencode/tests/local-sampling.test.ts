import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../plugins/local-sampling.ts"

async function runtime() {
  const path = join(await mkdtemp(join(tmpdir(), "sampling-unit-")), "opencode.json")
  await writeFile(path, JSON.stringify({ agent: { general: { temperature: 0.7, top_p: 0.8 }, context_worker: { temperature: 0, top_p: 0.9 } } }))
  const previous = process.env.OPENCODE_CONFIG
  process.env.OPENCODE_CONFIG = path
  const hooks: any = {}
  try { await plugin.setup({ session: { hook: async (name: string, fn: any) => { hooks[name] = fn } } }) }
  finally { if (previous == null) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = previous }
  return async (agent: string, body: any, providerID = "local-llama", kind = "primary") => {
    await hooks.context({ sessionID: agent, agent })
    const event = { sessionID: agent, kind, model: { providerID }, request: new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify(body) }) }
    await hooks["http.request"](event)
    return event.request.json()
  }
}

test("configured defaults reach primary and worker requests without changing limits or tools", async () => {
  const request = await runtime(), payload = { max_tokens: 2048, tools: [{ function: { name: "read" } }] }
  assert.deepEqual(await request("general", payload), { ...payload, temperature: 0.7, top_p: 0.8 })
  assert.deepEqual(await request("context_worker", payload), { ...payload, temperature: 0, top_p: 0.9 })
})

test("explicit native sampling, remote providers and auxiliary requests retain their settings", async () => {
  const request = await runtime(), payload = { temperature: 0.2, top_p: 0.6 }
  assert.deepEqual(await request("general", payload), payload)
  assert.deepEqual(await request("general", {}, "remote"), {})
  assert.deepEqual(await request("general", {}, "local-llama", "title"), {})
  assert.deepEqual(await request("unconfigured", {}), {})
})
