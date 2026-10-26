import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const original = JSON.parse(await readFile(join(base, 'opencode.json'), 'utf8'))
const parent = original.default_agent
const modes = ['healthy']
for (const mode of modes) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-parent-model-')))
  const dir = join(root, 'config/opencode'), project = join(root, 'project')
  await mkdir(join(dir, 'plugins'), { recursive: true }); await mkdir(project)
  for (const name of ['local-sampling.ts', 'zzzz-subagent-parent-model.ts', 'worker-slice-policy.ts', 'zzz-router-tool-recovery.ts', 'lib'])
    await cp(join(base, 'plugins', name), join(dir, 'plugins', name), { recursive: true })
  await writeFile(join(project, 'source.txt'), 'native worker read verified\n')
  let parentCalls = 0, workerCalls = 0, schemaClean = false, workerModel, verified = false
  const failures = [], sampling = []
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    const payload = JSON.parse(raw), text = JSON.stringify(payload.messages)
    let call, content = 'Fixture title'
    if (text.includes('ROUTE_WORKER') || text.includes('ROUTE_PARENT')) sampling.push({ role: text.includes('ROUTE_WORKER') ? 'worker' : 'parent', temperature: payload.temperature, top_p: payload.top_p })
    if (text.includes('ROUTE_WORKER')) {
      workerCalls++; workerModel = payload.model
      if (workerCalls === 1) call = { name: 'read', input: { path: join(project, 'source.txt') } }
      else {
        verified = text.includes('native worker read verified')
        content = 'STATUS: DONE. Read source.txt and verified its exact contents: native worker read verified.'
      }
    } else if (text.includes('ROUTE_PARENT')) {
      if (++parentCalls === 1) {
        const available = payload.tools.map(tool => tool.function.name)
        if (available.some(name => ['read', 'shell', 'execute', 'edit', 'write', 'grep'].includes(name))) failures.push('default parent exposes execution tools')
        const schema = payload.tools.find(tool => tool.function.name === 'subagent').function.parameters
        schemaClean = !schema.properties.model && !schema.properties.sessionID
        call = { name: 'subagent', input: { agent: 'context_worker', description: 'Read selected source', prompt: `OBJECTIVE: read ${join(project, 'source.txt')} only and return its exact text. DONE WHEN: source inspected. OUT OF SCOPE: editing or other files.` } }
        // Deliberately violate the wire schema to replay hallucinated fields.
        // Native execution must still enforce the correct parent route.
        if (mode !== 'healthy') call.input.model = 'provider/local-llama/bonsai-27b-splash'
        if (mode === 'stale-and-model') call.input.sessionID = 'ses_01J9JvXJYdQXKqRgYyFpQdWv'
      } else {
        if (!text.includes('STATUS: DONE')) failures.push('parent did not receive successful native worker handoff')
        content = 'STATUS: DONE. Worker inherited the parent model and verified the selected source.'
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = call ? { tool_calls: [{ index: 0, id: `route-${parentCalls}-${workerCalls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: 'assistant', content }
    res.end(`data: ${JSON.stringify({ id: 'route-fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = {
    model: 'local-llama/fixture-parent', small_model: 'local-llama/fixture-parent', default_agent: original.default_agent,
    enabled_providers: ['local-llama'], experimental: { subagent_depth: 1 }, compaction: { auto: false },
    permission: { '*': 'allow', external_directory: { '*': 'deny' } },
    provider: { 'local-llama': { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: Object.fromEntries(['fixture-parent', 'fixture-child'].map(id => [id, { name: id, limit: { context: 22528, output: 4096 } }])) } },
    agent: Object.fromEntries([parent, 'context_worker'].map(name => [name, { ...original.agent[name], mode: 'all', temperature: 0.7, top_p: 0.8, model: `local-llama/${name === parent ? 'fixture-parent' : 'fixture-child'}`, prompt: name === parent ? 'ROUTE_PARENT: delegate the task once then report the actual handoff.' : 'ROUTE_WORKER: read the selected source and return its exact text.' }]))
  }
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(config))
  const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--format', 'json', 'Read only the assigned source through one foreground worker.'], {
    cwd: project, env: { ...process.env, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: join(dir, 'opencode.json'), OPENCODE_DB: join(root, 'test.db'), OPENCODE_PERFORMANCE_DIAGNOSTIC: '1', OPENCODE_PROGRESS_TEST_DIR: join(root, 'progress'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
  try {
    const code = await new Promise(resolve => child.on('exit', resolve))
    const result = { mode, root, code, parentCalls, workerCalls, schemaClean, workerModel, verified, failures, stdout, stderr }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ mode, root, code, parentCalls, workerCalls, schemaClean, workerModel, verified, failures }))
    assert.equal(code, 0, stderr.slice(-1800))
    assert.equal(parentCalls, 2)
    assert.equal(workerCalls, 2)
    assert.equal(schemaClean, true)
    assert.equal(workerModel, 'fixture-parent')
    assert.equal(verified, true)
    console.log(JSON.stringify({ sampling }))
    assert.ok(sampling.length >= 4)
    for (const sample of sampling) { assert.equal(sample.temperature, 0.7); assert.equal(sample.top_p, 0.8) }
    assert.deepEqual(failures, [])
  } finally {
    clearTimeout(timer)
    if (child.exitCode == null) child.kill('SIGTERM')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
