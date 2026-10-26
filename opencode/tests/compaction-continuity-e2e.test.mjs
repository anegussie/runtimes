import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const mode = 'checkpoint'
const recovery = false
const root = await mkdtemp(join(tmpdir(), 'opencode-slice-'))
const dir = join(root, 'config', 'opencode')
await mkdir(join(dir, 'plugins'), { recursive: true })
for (const name of ['worker-slice-policy.ts', 'lib', ...(recovery ? ['zzz-router-tool-recovery.ts'] : []), ...(mode === 'checkpoint' ? ['concise-compaction.ts'] : [])]) {
  try { await cp(join(base, 'plugins', name), join(dir, 'plugins', name), { recursive: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
await writeFile(join(root, 'tutorial.md'), '# Introduction\nFeedback is useful.\n' + (mode === 'checkpoint' ? Array.from({ length: 118 }, (_, i) => `Evidence ${i}: ${'feedback '.repeat(70)}\n`).join('') : '') + '# Next section\nUnassigned.\n')
const original = JSON.parse(await readFile(join(base, 'opencode.json'), 'utf8'))
const prompts = Object.fromEntries(await Promise.all(['router', 'context_worker', 'general_worker'].map(async name => [name, await readFile(original.agent[name].prompt.match(/^\{file:(.+)\}$/)[1].replace('__OPENCODE_CONFIG_DIR__', base), 'utf8')])))
let parentCalls = 0, workerCalls = 0, checkpointCalls = 0, sequence = 0
let recoveryChoice, handoffChoice, initialParallel
const failures = [], seen = []
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  const payload = JSON.parse(body)
  const text = payload.messages.map(x => typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).join('\n')
  const names = (payload.tools ?? []).map(x => x.function.name)
  let content, call, usage
  if (text.includes('Write only a progress checkpoint')) {
    checkpointCalls++
    content = 'Evidence: tutorial.md introduction states feedback is useful. Remaining: return the assigned slice findings; other sections remain unreviewed. <CHECKPOINT_END>'
  } else if (text.includes(prompts.general_worker) || text.includes(prompts.context_worker)) {
    seen.push(names); workerCalls++
    if (workerCalls === 1) {
      if (mode === 'inventory') {
        if (names.includes('read') || names.includes('shell')) failures.push('inventory worker still has content-reading tools')
        if (!text.includes('INVENTORY ONLY')) failures.push('broad review was not normalized to inventory')
        call = { name: 'glob', input: { path: root, pattern: '*.md' } }
      } else {
        if (!names.includes('read')) failures.push('worker compacted before its assigned inspection')
        call = { name: 'read', input: { path: join(root, 'tutorial.md'), offset: 1, limit: 120 } }
      }
    } else if (workerCalls === 2) {
      if (names.length && payload.tool_choice !== 'none') failures.push('worker can continue instead of handing off completed inventory/checkpoint')
      if (mode === 'checkpoint' && !text.includes('CONFIRMED_FIX_A')) failures.push('prior reported finding lost during compaction')
      if (mode === 'checkpoint' && !text.includes('SLICE_CHECKPOINT_HANDOFF')) failures.push('checkpoint handoff instruction missing')
      content = mode === 'inventory'
        ? 'STATUS: DONE. Inventory: tutorial.md. No content review performed. NEXT: Introduction section.'
        : 'STATUS: PARTIAL. FINDINGS: tutorial.md:1-2 explains feedback. CHANGED: none. CHECKS: assigned source inspected. NEXT: verify remaining evidence in a fresh slice.'
    } else if (workerCalls === 3) {
      if (!names.includes('read')) failures.push('second sequential worker cannot inspect its assigned slice')
      if (text.includes('OBJECTIVE: INVENTORY ONLY')) failures.push('next named slice was incorrectly normalized to inventory')
      call = { name: 'read', input: { path: join(root, 'tutorial.md'), offset: 1, limit: 2 } }
    } else {
      content = 'STATUS: DONE. Assigned remaining slice verified: introduction says feedback is useful. CHECKS: source inspected. NEXT: none.'
    }
  } else if (text.includes(prompts.router)) {
    const step = ++parentCalls
    if (recovery && step === 1) {
      initialParallel = payload.parallel_tool_calls
      call = { name: 'execute', input: { command: 'pwd' } }
    } else if (step === (recovery ? 2 : 1)) {
      if (recovery) {
        recoveryChoice = payload.tool_choice
        if (!text.includes('ROUTER_TOOL_RECOVERY')) failures.push('unavailable-tool recovery instruction missing')
        if (names.includes('execute') || names.includes('question') || !names.includes('subagent')) failures.push('recovery did not retain only native delegation')
        if (payload.parallel_tool_calls !== false) failures.push('tool-name grammar constraint absent')
      }
      call = { name: 'subagent', input: {
      agent: 'general_worker', description: 'Review directory content',
      prompt: mode === 'inventory'
        ? `OBJECTIVE: review all content in the current directory. First inventory the workspace, then review each file.\nTARGET: ${root}\nDONE WHEN: return a per-file review of all files and subdirectories.`
        : `OBJECTIVE: review the Introduction section only.\nTARGET: ${join(root, 'tutorial.md')} lines 1-120.\nDONE WHEN: findings and one focused check; other sections are out of scope.`
      } }
    }
    else if (step === (recovery ? 3 : 2)) {
      if (!names.includes('subagent') || payload.tool_choice === 'none') failures.push('parent cannot continue the authorized task list')
      if (!text.includes('SLICE_PARENT_CONTINUE')) failures.push('sequential continuation instruction missing')
      call = { name: 'subagent', input: { agent: 'context_worker', description: 'Verify remaining introduction slice',
        prompt: `OBJECTIVE: verify Introduction lines 1-2 only.\nTARGET: ${join(root, 'tutorial.md')} lines 1-2.\nKNOWN EVIDENCE: inventory and previous slice findings retained.\nDONE WHEN: verify feedback statement and return DONE.\nOUT OF SCOPE: discovery, other sections.` } }
    } else {
      handoffChoice = payload.tool_choice
      content = 'STATUS: DONE. Both authorized slices completed sequentially without confirmation.'
    }
  } else content = 'Slice fixture title'
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = call ? { content: workerCalls === 1 && parentCalls === 1 ? 'FINDINGS: tutorial.md:2 CONFIRMED_FIX_A needs an evidence check before editing.' : '', tool_calls: [{ index: 0, id: `slice-${++sequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: 'assistant', content }
  res.write(`data: ${JSON.stringify({ id: `fixture-${sequence}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
  if (usage) res.write(`data: ${JSON.stringify({ id: `fixture-${sequence}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = {
  model: 'local-llama/fixture', small_model: 'local-llama/fixture', default_agent: 'router',
  enabled_providers: ['local-llama'], experimental: { subagent_depth: 1 }, permission: { '*': 'allow' },
  compaction: { auto: mode === 'checkpoint', buffer: 512, keep: { tokens: 512 } },
  provider: { 'local-llama': { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { fixture: { name: 'fixture', limit: { context: mode === 'checkpoint' ? 8192 : 24576, output: 1024 } } } } },
  agent: Object.fromEntries(Object.entries(prompts).map(([name, prompt]) => [name, { ...original.agent[name], model: 'local-llama/fixture', prompt }]))
}
await writeFile(join(dir, 'opencode.json'), JSON.stringify(config))
const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--auto', '--format', 'json', '--agent', 'router', `Review all content in ${root}.`], {
  cwd: root, env: { ...process.env, PWD: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG: join(dir, 'opencode.json'), OPENCODE_CONFIG_DIR: dir, OPENCODE_DB: join(root, 'test.db'), OPENCODE_PERFORMANCE_DIAGNOSTIC: '1', OPENCODE_PROGRESS_TEST_DIR: join(root, 'progress'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
})
let stdout = '', stderr = ''
child.stdout.on('data', x => { stdout += x }); child.stderr.on('data', x => { stderr += x })
const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
try {
  const code = await new Promise(resolve => child.on('exit', resolve))
  clearTimeout(timer)
  await writeFile(join(root, 'result.json'), JSON.stringify({ code, mode, seen, failures, parentCalls, workerCalls, checkpointCalls, stdout, stderr }, null, 2))
  assert.equal(code, 0, stderr.slice(-1800))
  assert.equal(parentCalls, recovery ? 4 : 3)
  assert.equal(workerCalls, 4)
  assert.equal(checkpointCalls, mode === 'checkpoint' ? 1 : 0)
  assert.deepEqual(failures, [])
  if (recovery) assert.equal(initialParallel, false)
  assert.match(stdout, /Both authorized slices completed sequentially without confirmation/)
  console.log(JSON.stringify({ passed: true, mode, recovery, root, parentCalls, workerCalls, checkpointCalls, recoveryChoice, handoffChoice }))
} finally {
  clearTimeout(timer)
  if (child.exitCode == null) child.kill('SIGTERM')
  await new Promise(resolve => server.close(resolve))
}
