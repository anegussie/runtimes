import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, cp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"

// Exercise native OpenCode with deterministic model responses and isolated
// state. This never sends an inference request to the user's Splash server.
const overlap = process.env.LOOP_PATTERN === "overlap"
const pluginRoot = process.env.LOOP_PLUGIN_DIR || resolve("plugins")
const root = await mkdtemp(join(tmpdir(), "opencode-native-loop-"))
const configDir = join(root, "config", "opencode")
await mkdir(configDir, { recursive: true })
await mkdir(join(configDir, "plugins"), { recursive: true })
for (const name of ["repeated-child-call-guard.ts", "read-window-default.ts", "lib"]) await cp(resolve(pluginRoot, name), join(configDir, "plugins", name), { recursive: true })
const source = join(root, "tutorial.md")
await writeFile(source, overlap ? "# Example 1\nAn integrating factor is missing.\n" + Array.from({ length: 28 }, (_, i) => `Stable source line ${i + 3}.`).join("\n") + "\n" : "# Example 1\nAn integrating factor is missing.\n")
let childCalls = 0
let parentCalls = 0
let parentContext = ""
let warningSeen = false
let toolsSeen = []
const server = http.createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end(); return
  }
  const payload = JSON.parse(body)
  const names = (payload.tools ?? []).map(tool => tool.function?.name)
  toolsSeen.push(names)
  if (!names.length) {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ id: "title", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Loop handoff test" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); return
  }
  const worker = JSON.stringify(payload.messages).includes("You are the context_worker.")
  let content
  let call
  if (worker) {
    warningSeen ||= JSON.stringify(payload.messages).includes("REVIEW_EVIDENCE_STALLED")
    childCalls++
    if (overlap && childCalls <= 16) {
      call = childCalls === 1 ? { name: "read", input: { path: source, offset: 1, limit: 20 } }
        : childCalls % 2 === 0 ? { name: "grep", input: { path: source, pattern: ["factor", "Example", "missing", "factor|Example"][Math.floor(childCalls / 2) % 4], literal: false } }
        : { name: "read", input: { path: source, offset: 2 + Math.floor(childCalls / 2) % 7, limit: 9 } }
    } else if (!overlap && childCalls <= 4) call = { name: "read", input: { path: source, limit: 22 } }
    else content = "STATUS: PARTIAL. Unexpectedly continued beyond the repeated-read guard."
  } else if (++parentCalls === 1) {
    call = { name: names.includes("subagent") ? "subagent" : "task", input: names.includes("subagent")
      ? { agent: "context_worker", description: "Reproduce cyclic reread", prompt: overlap ? `OBJECTIVE: Review Example 1 and find the missing integrating-factor reasoning.\nTARGET: ${source} lines 1-20\nDONE WHEN: Return evidence and any missing verification.\nOUT OF SCOPE: edits or writes.` : `Read only ${source}. Return the known missing integrating-factor finding.` }
      : { subagent_type: "context_worker", description: "Reproduce cyclic reread", prompt: overlap ? `OBJECTIVE: Review Example 1 and find the missing integrating-factor reasoning.\nTARGET: ${source} lines 1-20\nDONE WHEN: Return evidence and any missing verification.\nOUT OF SCOPE: edits or writes.` : `Read only ${source}. Return the known missing integrating-factor finding.` } }
  } else {
    parentContext = JSON.stringify(payload.messages)
    content = "STATUS: PARTIAL. Repeated-read loop stopped. No edits or checks completed."
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  const delta = call ? { tool_calls: [{ index: 0, id: `call-${worker ? "child" : "parent"}-${childCalls}-${parentCalls}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: "assistant", content }
  res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const original = JSON.parse(await readFile(new URL("../opencode.json", import.meta.url), "utf8"))
const config = {
  model: "loop-fixture/fixture", small_model: "loop-fixture/fixture", default_agent: "router",
  experimental: { subagent_depth: 1 },
  compaction: { auto: false },
  provider: { "loop-fixture": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { fixture: { name: "fixture", limit: { context: 24576, output: 1024 } } } } },
  enabled_providers: ["loop-fixture"],
  permission: { "*": "allow" },
  agent: Object.fromEntries(["router", "context_worker"].map(name => [name, { ...original.agent[name], model: "loop-fixture/fixture", prompt: `You are the ${name}. Follow the requested test task.`, permission: { "*": "allow" } }])),
}
await writeFile(join(configDir, "opencode.json"), JSON.stringify(config))
const child = spawn("opencode", ["run", "--model", "loop-fixture/fixture", "--standalone", "--auto", "--agent", "router", "--format", "json", "Reproduce one bounded read loop and report its actual cause."], {
  cwd: root,
  env: { ...process.env, PWD: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG: join(configDir, "opencode.json"), OPENCODE_PERFORMANCE_DIAGNOSTIC: "1", OPENCODE_PROGRESS_TEST_DIR: join(root, "progress"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
  stdio: ["ignore", "pipe", "pipe"],
})
let stdout = "", stderr = ""
child.stdout.on("data", chunk => { stdout += chunk })
child.stderr.on("data", chunk => { stderr += chunk })
const timer = setTimeout(() => child.kill("SIGTERM"), 30000)
const code = await new Promise(resolve => child.on("exit", resolve))
clearTimeout(timer)
await new Promise(resolve => server.close(resolve))
await writeFile(join(root, "run.json"), JSON.stringify({ code, childCalls, parentCalls, toolsSeen, stdout, stderr, parentContext, warningSeen }, null, 2))
console.log(`Native fixture artifacts: ${root}`)
assert.equal(code, 0, stderr.slice(-2500) || stdout.slice(-2500))
if (overlap) assert.ok(childCalls <= 12, `review stagnation continued for ${childCalls} calls instead of stopping unchanged evidence`)
else assert.equal(childCalls, 4, `unexpected worker calls; tools=${JSON.stringify(toolsSeen)}`)
if (overlap) assert.ok(warningSeen, "worker did not receive a recovery warning before cancellation")
assert.equal(parentCalls, 2)
assert.ok(parentContext.includes("CHILD_LOOP_ABORTED") && parentContext.includes(overlap ? "review stagnation" : "repeated-read loop stopped"), "Native parent did not receive the loop reason")
assert.match(parentContext, /STATUS: PARTIAL/)
assert.doesNotMatch(stdout, /"name":"question"/)
console.log(overlap ? "Native OpenCode: overlapping review research stopped with factual PARTIAL handoff." : "Native OpenCode: fourth repeated read interrupted child; parent received explicit partial loop handoff.")
