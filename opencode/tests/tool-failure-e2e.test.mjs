import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const original = JSON.parse(await readFile(join(base, 'opencode.json'), 'utf8'))
const modes = process.env.RELIABILITY_CASE ? [process.env.RELIABILITY_CASE]
  : ['repeat-router', 'repeat-worker', 'corrected', 'permission', 'long-input']
for (const mode of modes) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-tool-failure-')))
  const dir = join(root, 'config', 'opencode')
  await mkdir(join(dir, 'plugins'), { recursive: true })
  for (const name of ['tool-failure-recovery.ts', 'zzz-router-tool-recovery.ts', 'worker-slice-policy.ts', 'lib']) {
    try { await cp(join(base, 'plugins', name), join(dir, 'plugins', name), { recursive: true }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const project = join(root, 'project')
  await mkdir(project)
  const artifact = join(project, 'helper.txt')
  const content = mode === 'long-input' ? 'complete tool payload\n'.repeat(700) : 'verified local helper\n'
  let parentCalls = 0, workerCalls = 0, serial = 0, finalConstrained = false, correctionSeen = false
  let permissionSeen = false, parentStopped = false, outputLimit
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    const p = JSON.parse(raw), text = JSON.stringify(p.messages)
    let call, message = 'Fixture title', finish
    if (text.includes('RELIABILITY_WORKER') || text.includes('RELIABILITY_PARENT')) {
      const worker = text.includes('RELIABILITY_WORKER')
      const step = worker ? ++workerCalls : ++parentCalls
      const tool = worker ? 'shell' : 'subagent'
      const delegate = () => ({ name: 'subagent', input: { agent: 'general_worker', description: 'One local helper check', prompt: `OBJECTIVE: create and verify helper.txt only. TARGET: ${project}. DONE WHEN: helper exists with requested content. OUT OF SCOPE: all other files.` } })
      if (mode === 'repeat-router' || mode === 'repeat-worker') {
        if (mode === 'repeat-worker' && !worker) {
          if (step === 1) call = delegate()
          else { parentStopped = p.tool_choice === 'none'; message = 'STATUS: PARTIAL TOOL_FAILURE_STOP: worker failed; no relaunch.' }
        } else if (step <= 2) call = { name: tool, input: {} }
        else {
          finalConstrained = p.tool_choice === 'none' && text.includes('TOOL_FAILURE_STOP')
          message = 'STATUS: PARTIAL TOOL_FAILURE_STOP: repeated invalid arguments; no work completed.'
        }
      } else if (mode === 'corrected') {
        if (!worker && step === 1) call = { name: 'subagent', input: {} }
        else if (!worker && step === 2) { correctionSeen = text.includes('TOOL_FAILURE_RECOVERY'); call = delegate() }
        else if (worker && step === 1) call = { name: 'write', input: { path: artifact, content } }
        else message = 'STATUS: DONE. Corrected delegation and local helper verified.'
      } else if (mode === 'permission') {
        if (step === 1) call = { name: 'write', input: { path: join(root, 'denied-helper.txt'), content } }
        else if (step === 2) { permissionSeen = text.includes('TOOL_FAILURE_RECOVERY') && text.includes('project'); call = { name: 'write', input: { path: artifact, content } } }
        else message = 'STATUS: DONE. Project-local helper created after external-directory rejection.'
      } else if (mode === 'long-input') {
        outputLimit = p.max_tokens ?? p.max_completion_tokens
        if (step === 1 || outputLimit < 4096) {
          call = { name: 'write', input: { path: artifact, content } }
          if (outputLimit < 4096) { call.raw = JSON.stringify(call.input).slice(0, 1800); finish = 'length' }
        } else message = 'STATUS: DONE. Long tool payload written completely.'
      }
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `reliability-${++serial}`, type: 'function', function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.input) } }] } : { role: 'assistant', content: message }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: `fixture-${serial}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish ?? (call ? 'tool_calls' : 'stop') }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const primary = ['permission', 'long-input'].includes(mode) ? 'general_worker' : 'router'
  const config = {
    model: 'local-llama/fixture', small_model: 'local-llama/fixture', default_agent: primary,
    enabled_providers: ['local-llama'], experimental: { subagent_depth: 1 }, compaction: { auto: false },
    permission: { '*': 'allow', external_directory: { '*': 'deny' } },
    provider: { 'local-llama': { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { fixture: { name: 'fixture', limit: original.provider['local-llama'].models['bonsai-27b-splash'].limit } } } },
    agent: Object.fromEntries(['router', 'general_worker'].map(name => [name, { ...original.agent[name], mode: 'all', model: 'local-llama/fixture', prompt: name === 'router' ? 'RELIABILITY_PARENT: follow the assigned task.' : 'RELIABILITY_WORKER: follow the assigned task.' }]))
  }
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(config))
  const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--format', 'json', '--agent', primary, 'Create and verify only the assigned project helper.'], {
    cwd: project, env: { ...process.env, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: join(dir, 'opencode.json'), OPENCODE_DB: join(root, 'test.db'), OPENCODE_PERFORMANCE_DIAGNOSTIC: '1', OPENCODE_PROGRESS_TEST_DIR: join(root, 'progress'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', x => { stdout += x }); child.stderr.on('data', x => { stderr += x })
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
  try {
    const code = await new Promise(resolve => child.on('exit', resolve))
    clearTimeout(timer)
    await writeFile(join(root, 'result.json'), JSON.stringify({ mode, code, parentCalls, workerCalls, finalConstrained, correctionSeen, permissionSeen, parentStopped, outputLimit, stdout, stderr }, null, 2))
    console.log(JSON.stringify({ mode, root, code, parentCalls, workerCalls, finalConstrained, correctionSeen, permissionSeen, parentStopped, outputLimit }))
    assert.equal(code, 0, stderr.slice(-1500))
    if (mode.startsWith('repeat-')) {
      assert.equal(finalConstrained, true, 'repeated invalid calls did not enter a constrained partial handoff')
      assert.equal(mode === 'repeat-router' ? parentCalls : workerCalls, 3)
      if (mode === 'repeat-worker') { assert.equal(parentCalls, 2); assert.equal(parentStopped, true) }
    } else {
      assert.equal(await readFile(artifact, 'utf8'), content)
      if (mode === 'corrected') assert.equal(correctionSeen, true)
      if (mode === 'permission') { assert.equal(permissionSeen, true); await assert.rejects(readFile(join(root, 'denied-helper.txt'))) }
      if (mode === 'long-input') assert.equal(outputLimit, 4096)
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode == null) child.kill('SIGTERM')
    await new Promise(resolve => server.close(resolve))
  }
}
