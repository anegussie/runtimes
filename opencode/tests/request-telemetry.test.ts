import test from "node:test"
import assert from "node:assert/strict"
import { RequestTelemetry } from "../plugins/lib/request-telemetry.ts"

const make = (body: any = { stream: true }, signal?: AbortSignal) => ({ kind: "title", sessionID: "unit-trace",
  model: { providerID: "local-llama", id: "bonsai-27b-splash" }, request: new Request("http://localhost/v1/chat/completions", {
    method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) })
test("fragmented SSE is byte-preserved, bounded metadata captures reasoning/usage/tool correlation", async () => {
  const events: any[] = [], tracker = new RequestTelemetry(async e => { events.push(e) })
  const e: any = make({ stream: true, messages: [{ content: "PRIVATE_PROMPT" }], max_tokens: 100 })
  await tracker.before(e, { agent: "router", parentID: "parent" })
  assert.equal((await e.request.clone().json()).stream_options.include_usage, true)
  const frames = [{ id: "response-7", choices: [{ delta: { reasoning_content: "PRIVATE_REASON" } }] },
    { choices: [{ delta: { content: "PRIVATE_OUTPUT", tool_calls: [{ index: 0, id: "tool-7", function: { arguments: "PRIVATE_ARGUMENT" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } }]
  const raw = ": keepalive\n\n" + frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(raw); let at = 0
  e.response = new Response(new ReadableStream({ pull(c) { if (at === bytes.length) { c.close(); return }; c.enqueue(bytes.slice(at, at + 7)); at = Math.min(bytes.length, at + 7) } }), { headers: { "content-type": "text/event-stream" } })
  await tracker.response(e)
  assert.equal(await e.response.text(), raw)
  const end = events.find(x => x.event === "llm_request_end")
  assert.equal(end.outcome, "completed"); assert.equal(end.keepalives, 1)
  assert.equal(end.generatedToolCalls, 1); assert.equal(end.usage.completion_tokens_details.reasoning_tokens, 2)
  assert.equal(tracker.origins.get("tool-7"), e.request.headers.get("x-opencode-request-id"))
  assert.equal(tracker.active.size, 0)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/)
})
test("request abort, consumer cancellation and premature EOF stay distinct", async () => {
  for (const mode of ["abort", "cancel", "eof"]) {
    const events: any[] = [], tracker = new RequestTelemetry(async e => { events.push(e) }), ac = new AbortController()
    const e: any = make({}, ac.signal); await tracker.before(e)
    let cancelled = false
    if (mode === "abort") { ac.abort(); await new Promise(r => setTimeout(r, 0)) }
    else {
      e.response = new Response(new ReadableStream({ start(c) { if (mode === "eof") c.close() }, cancel() { cancelled = true } }), { headers: { "content-type": "text/event-stream" } })
      await tracker.response(e)
      if (mode === "cancel") { await e.response.body.cancel(); assert.equal(cancelled, true) }
      else await e.response.text()
    }
    assert.equal(events.filter(x => x.event === "llm_request_end").length, 1)
    assert.equal(events.at(-1).outcome, mode === "eof" ? "eof_without_done" : "cancelled")
  }
})
test("non-stream JSON, HTTP errors and oversized frames do not expose payloads or change responses", async () => {
  const events: any[] = [], tracker = new RequestTelemetry(async e => { events.push(e) })
  const e: any = make({ stream: false }); await tracker.before(e)
  const raw = JSON.stringify({ choices: [], usage: { prompt_tokens: 9 }, timings: { prompt_ms: 12.34 } })
  e.response = new Response(raw, { status: 400, headers: { "content-type": "application/json" } })
  await tracker.response(e); assert.equal(await e.response.text(), raw)
  assert.equal(events.at(-1).outcome, "http_error"); assert.equal(events.at(-1).timings.prompt_ms, 12.34)
  const big: any = make(); await tracker.before(big)
  const payload = "x".repeat(300000)
  big.response = new Response(payload, { headers: { "content-type": "text/event-stream" } })
  await tracker.response(big); assert.equal(await big.response.text(), payload)
  assert.ok(events.at(-1).oversizedFrames > 0)
})
