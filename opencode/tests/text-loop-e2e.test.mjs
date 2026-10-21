import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

// Real OpenCode, deterministic streaming provider, isolated state and files.
const base = new URL('..', import.meta.url).pathname
const original = JSON.parse(await readFile(join(base, 'opencode.json'), 'utf8'))
for (const mode of ['repeated-text', 'productive']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-text-loop-native-')))
  const configDir = join(root, 'config/opencode'), project = join(root, 'project')
  await mkdir(join(configDir, 'plugins'), { recursive: true }); await mkdir(project)
  for (const name of ['repeated-child-call-guard.ts', 'worker-slice-policy.ts', 'zzz-router-tool-recovery.ts', 'lib'])
    await cp(join(base, 'plugins', name), join(configDir, 'plugins', name), { recursive: true })
  const artifact = join(project, 'verified.txt')
  let parentCalls = 0, workerCalls = 0, sent = 0, cancelled = false, parentStopped = false, parentContext = ''
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const piece of req) raw += piece
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    const payload = JSON.parse(raw), text = JSON.stringify(payload.messages)
    const worker = text.includes('TEXT_LOOP_WORKER'), parent = text.includes('TEXT_LOOP_PARENT')
    let call, content = 'Fixture title'
    if (worker) {
      workerCalls++
      if (mode === 'repeated-text') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const phrases = ["I'll read the script.\n", 'Let me read it.\n', 'I need to read the script content.\n']
        const timer = setInterval(() => {
          res.write(frame({ content: phrases[sent++ % phrases.length] }))
          if (sent >= 90) { clearInterval(timer); res.end(frame({}, 'stop') + 'data: [DONE]\n\n') }
        }, 10)
        res.on('close', () => { clearInterval(timer); cancelled = sent < 90 })
        return
      }
      if (workerCalls === 1) call = { name: 'shell', input: { command: `printf verified > '${artifact}'` } }
      else if (workerCalls === 2) call = { name: 'read', input: { path: artifact } }
      else content = 'STATUS: DONE. Created verified.txt and read back its exact contents: verified.'
    } else if (parent) {
      if (++parentCalls === 1) call = { name: 'subagent', input: { agent: 'general_worker', description: 'One focused verification', prompt: `OBJECTIVE: create ${artifact} containing verified and read it back. DONE WHEN: exact contents verified. OUT OF SCOPE: other files.` } }
      else {
        parentContext = text
        parentStopped = payload.tool_choice === 'none' && text.includes('SLICE_PARENT_HANDOFF')
        content = mode === 'repeated-text' ? 'STATUS: PARTIAL. CHILD_LOOP_ABORTED: repeated prose stopped; no work verified. No relaunch.' : 'STATUS: DONE. Worker created and verified the requested file.'
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frame(call ? { tool_calls: [{ index: 0, id: `call-${parentCalls}-${workerCalls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: 'assistant', content }, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
  })
  function frame(delta, finish_reason = null) { return `data: ${JSON.stringify({ id: 'text-loop-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n` }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = {
    model: 'local-llama/fixture', small_model: 'local-llama/fixture', default_agent: 'router',
    enabled_providers: ['local-llama'], experimental: { subagent_depth: 1 }, compaction: { auto: false },
    permission: { '*': 'allow', external_directory: { '*': 'deny' } },
    provider: { 'local-llama': { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { fixture: { name: 'fixture', limit: { context: 22528, output: 4096 } } } } },
    agent: Object.fromEntries(['router', 'general_worker'].map(name => [name, { ...original.agent[name], mode: 'all', model: 'local-llama/fixture', prompt: name === 'router' ? 'TEXT_LOOP_PARENT: delegate the assigned task once and report the actual result.' : 'TEXT_LOOP_WORKER: complete the assigned task and checks.' }]))
  }
  await writeFile(join(configDir, 'opencode.json'), JSON.stringify(config))
  const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--format', 'json', '--agent', 'router', 'Create and verify only the assigned local file.'], {
    cwd: project, env: { ...process.env, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG: join(configDir, 'opencode.json'), OPENCODE_DB: join(root, 'test.db'), OPENCODE_PERFORMANCE_DIAGNOSTIC: '1', OPENCODE_PROGRESS_TEST_DIR: join(root, 'progress'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', x => { stdout += x }); child.stderr.on('data', x => { stderr += x })
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
  try {
    const code = await new Promise(resolve => child.on('exit', resolve))
    const result = { mode, code, parentCalls, workerCalls, sent, cancelled, parentStopped, parentContext, stdout, stderr }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ mode, root, code, parentCalls, workerCalls, sent, cancelled, parentStopped }))
    assert.equal(code, 0, stderr.slice(-1800))
    assert.equal(parentCalls, 2)
    if (mode === 'repeated-text') {
      assert.equal(workerCalls, 1)
      assert.equal(cancelled, true, 'provider generation did not stop early')
      assert.equal(parentStopped, true, 'parent did not enter a constrained failure handoff')
      assert.match(parentContext, /CHILD_LOOP_ABORTED/)
      assert.match(parentContext, /STATUS: PARTIAL/)
      await assert.rejects(readFile(artifact))
    } else {
      assert.equal(workerCalls, 3)
      assert.equal(await readFile(artifact, 'utf8'), 'verified')
      assert.equal(parentStopped, false)
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode == null) child.kill('SIGTERM')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
