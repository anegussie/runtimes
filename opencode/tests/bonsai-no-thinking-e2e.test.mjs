import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-no-thinking-native-')))
const dir = join(root, 'config/opencode'), project = join(root, 'project')
await mkdir(join(dir, 'plugins'), { recursive: true }); await mkdir(project)
await cp(join(base, 'plugins/zzzzz-bonsai-no-thinking.ts'), join(dir, 'plugins/zzzzz-bonsai-no-thinking.ts'))
const requests = []
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  const body = JSON.parse(raw); requests.push(body)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ id: 'thinking-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'WIRE_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const model = 'local-llama/bonsai-27b-splash'
const config = {
  model, default_agent: 'test_agent',
  providers: { 'local-llama': { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { 'bonsai-27b-splash': { name: 'Bonsai fixture', limit: { context: 24576, output: 4096 } } } } },
  agents: { test_agent: { model, mode: 'primary', system: 'Reply exactly WIRE_OK. Use no tools.', request: { body: { reasoning_effort: 'low', max_tokens: 24006 } } } },
  compaction: { auto: false },
}
await writeFile(join(dir, 'opencode.json'), JSON.stringify(config))
const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--format', 'json', '--agent', 'test_agent', 'Reply exactly WIRE_OK.'], {
  cwd: project, env: { ...process.env, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: join(dir, 'opencode.json'), OPENCODE_DB: join(root, 'test.db'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '', stderr = ''
child.stdout.on('data', x => { stdout += x }); child.stderr.on('data', x => { stderr += x })
const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
try {
  const code = await new Promise(resolve => child.on('exit', resolve))
  await writeFile(join(root, 'result.json'), JSON.stringify({ code, requests, stdout, stderr }, null, 2))
  console.log(JSON.stringify({ root, code, requests: requests.map(r => ({ reasoning_effort: r.reasoning_effort, max_tokens: r.max_tokens, thinking: r.chat_template_kwargs?.enable_thinking, title: /title/i.test(JSON.stringify(r.messages)) })) }))
  assert.equal(code, 0, stderr.slice(-2000))
  assert.ok(stdout.includes('WIRE_OK'), stdout.slice(-1200))
  assert.ok(requests.length >= 2, 'title and primary requests must both be observed')
  assert.ok(requests.some(r => /title/i.test(JSON.stringify(r.messages))), 'title request was not exercised')
  for (const r of requests) {
    assert.equal(r.reasoning_effort, 'none')
    assert.equal(r.chat_template_kwargs.enable_thinking, false)
    assert.ok(r.max_tokens > 0 && r.max_tokens <= 4096)
  }
} finally {
  clearTimeout(timer)
  if (child.exitCode == null) child.kill('SIGTERM')
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
