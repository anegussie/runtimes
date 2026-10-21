import test from "node:test"
import assert from "node:assert/strict"
import { TextLoopDetector, guardTextStream } from "../plugins/lib/text-loop.ts"
import plugin from "../plugins/repeated-child-call-guard.ts"
import { loadLedger } from "../plugins/lib/progress-ledger.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"
const loop = "I'll read the script.\nLet me read it.\nI need to read the script content.\n".repeat(30)
const chunk = (delta: any) => `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta }] })}\n\n`
const handoff = "STATUS: PARTIAL\nCHILD_LOOP_ABORTED: repeated text without tool calls"

test("action promises stop early, including sentence-only and fragmented streaming", () => {
  for (const text of [loop, loop.replaceAll("\n", " ")]) {
    const detector = new TextLoopDetector()
    let stopped = 0
    for (let i = 0; i < text.length; i += 7) if (detector.feed(text.slice(i, i + 7))) { stopped = i; break }
    assert.ok(stopped > 0 && stopped < 1000, `detection at ${stopped}`)
  }
})
test("ordinary progress, fenced examples, quoted source and lists pass", () => {
  for (const text of ["I'll read the script.\nThen I will run the test.\nSTATUS: DONE. 118 cells and zero errors.\n", "```text\n" + loop + "```\n", loop.split("\n").map(line => "> " + line).join("\n"), loop.split("\n").map(line => "- " + line).join("\n"), "A long explanation without action promises.\n".repeat(80)]) {
    const detector = new TextLoopDetector()
    for (const char of text) assert.equal(detector.feed(char), false)
  }
})
test("SSE frames spanning arbitrary UTF-8 boundaries remain exact without a loop", async () => {
  const raw = ": heartbeat\r\n\r\n" + chunk({ content: "Measured 118 cells — zéro errors.\n" }) + "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(raw)
  let offset = 0
  const response = new Response(new ReadableStream({ pull(c) { if (offset < bytes.length) c.enqueue(bytes.slice(offset, ++offset)); else c.close() } }))
  assert.equal(await guardTextStream(response, async () => { throw Error("unexpected stop") }).text(), raw)
})
test("loop cancels upstream, emits PARTIAL once, and never executes mentioned tools", async () => {
  let index = 0, cancelled = false, stops = 0
  const fragments = loop.split(/(?<=\n)/)
  const response = new Response(new ReadableStream({ pull(c) { if (index < fragments.length) c.enqueue(new TextEncoder().encode(chunk({ content: fragments[index++] }))); else c.close() }, cancel() { cancelled = true } }))
  const text = await guardTextStream(response, async () => { stops++; return handoff }).text()
  assert.equal(cancelled, true)
  assert.equal(stops, 1)
  assert.ok(index < fragments.length)
  assert.match(text, /STATUS: PARTIAL/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.ok(text.endsWith("data: [DONE]\n\n"))
})
test("tool argument deltas, reasoning deltas, and content after a real tool call are preserved", async () => {
  for (const raw of [chunk({ tool_calls: [{ index: 0, function: { name: "write", arguments: loop } }] }), chunk({ reasoning_content: loop }), chunk({ tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }) + chunk({ content: loop })]) {
    assert.equal(await guardTextStream(new Response(raw), async () => { throw Error("unexpected stop") }).text(), raw)
  }
})
test("response hook scopes interception to local child primary SSE and persists its stop reason", async () => {
  const hooks: any = {}
  await plugin.setup({ tool: { hook: async () => {} }, session: { hook: async (name: string, fn: any) => { hooks[name] = fn }, get: async ({ sessionID }: any) => ({ parentID: sessionID === "unit-text-child" ? "parent" : undefined }) } })
  const event = () => ({ sessionID: "unit-text-child", kind: "primary", model: { providerID: "local-llama" }, request: new Request("http://localhost/v1/chat/completions"), response: new Response(chunk({ content: loop }), { headers: { "content-type": "text/event-stream" } }) })
  for (const change of [{ sessionID: "unit-parent" }, { kind: "compaction" }, { model: { providerID: "other" } }, { response: new Response("no SSE") }]) {
    const e = { ...event(), ...change }; const before = e.response
    await hooks["http.response"](e); assert.equal(e.response, before)
  }
  const e = event(); await hooks["http.response"](e)
  assert.match(await e.response.text(), /CHILD_LOOP_ABORTED/)
  assert.match((await loadLedger(e.sessionID)).loopStop!, /no new edit or verification/)
})
test("downstream cancellation reaches the provider reader", async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }))
  await guardTextStream(response, async () => handoff).body!.cancel()
  assert.equal(cancelled, true)
})
