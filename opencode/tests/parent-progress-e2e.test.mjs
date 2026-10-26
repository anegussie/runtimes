import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const original = JSON.parse(await readFile(join(base, 'opencode.json'), 'utf8'))
const modes = process.env.PARENT_PROGRESS_CASE ? [process.env.PARENT_PROGRESS_CASE] : ['plain', 'quoted-sed', 'quoted-prose', 'quoted-spaces', 'whole-file', 'whole-file-repair', 'whole-file-compaction']
for (const mode of modes) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-parent-model-')))
  const dir = join(root, 'config/opencode'), project = join(root, 'project')
  await mkdir(join(dir, 'plugins'), { recursive: true }); await mkdir(project)
  const source = join(project, mode === 'quoted-spaces' ? 'source with spaces.txt' : 'source.txt')
  for (const name of ['zzzz-subagent-parent-model.ts', 'worker-slice-policy.ts', 'zzz-router-tool-recovery.ts', 'lib'])
    await cp(join(base, 'plugins', name), join(dir, 'plugins', name), { recursive: true })
  await cp(join(base, 'plugins/zz-parent-progress.ts'), join(dir, 'plugins/zz-parent-progress.ts'))
  if (mode === 'whole-file-compaction') await cp(join(base, 'plugins/concise-compaction.ts'), join(dir, 'plugins/concise-compaction.ts'))
  await writeFile(source, 'native worker read verified\n')
  let parentCalls = 0, workerCalls = 0, checkpoints = 0, schemaClean = false, workerModel, verified = false
  const failures = []
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    const payload = JSON.parse(raw), text = JSON.stringify(payload.messages)
    let call, content = 'Fixture title'
    if (text.includes('Write only a progress checkpoint')) {
      checkpoints++; content = 'Evidence\nTwo reader slices inspected source.txt.\nRemaining\nPerform the authorized concrete fix, not another source copy.\nNext action\nDelegate a small edit and verify.<CHECKPOINT_END>'
    } else if (text.includes('ROUTE_WORKER')) {
      workerCalls++; workerModel = payload.model
      if (mode === 'whole-file-repair' && workerCalls >= 5) {
        if (workerCalls === 5 || workerCalls === 7) call = { name: 'read', input: { path: source } }
        else if (workerCalls === 6) call = { name: 'write', input: { path: source, content: 'native worker edited and verified\n' } }
        else { verified = text.includes('native worker edited and verified'); content = 'STATUS: DONE. Changed source.txt and read back native worker edited and verified.' }
      } else if (workerCalls % 2 === 1) call = { name: 'read', input: { path: source } }
      else {
        verified = text.includes('native worker read verified')
        content = 'STATUS: DONE. Read source.txt and verified its exact contents: native worker read verified.'
      }
    } else if (text.includes('ROUTE_PARENT')) {
      if (++parentCalls <= 3) {
        const schema = payload.tools.find(tool => tool.function.name === 'subagent').function.parameters
        schemaClean = !schema.properties.model && !schema.properties.sessionID
        const path = source
        const assignment = mode.startsWith('whole-file') ? `OBJECTIVE: Read the entire ${path} file and return its complete verbatim content organized by section.\nTARGET: ${path}\nDONE WHEN: full source returned. OUT OF SCOPE: editing.` : mode === 'plain' ? `OBJECTIVE: Read ${path} lines 1-2 and return its exact text.` : [
          'OBJECTIVE: Read the exact lines containing inline styles in `' + path + '`.',
          mode === 'quoted-prose' || mode === 'quoted-spaces' ? 'Report all lines from 1 to 2 verbatim.' : "Run: `sed -n '1,2p' " + path + '`',
          'Report ALL lines verbatim with line numbers. This is READ-ONLY.',
          'DONE WHEN: All lines reported with exact content. OUT OF SCOPE: editing.'
        ].join('\n')
        call = { name: 'subagent', input: { agent: 'context_worker', description: 'Read selected source verbatim', prompt: assignment } }
      } else if (mode === 'whole-file-repair' && parentCalls === 4) {
        if (!text.includes('PARENT_PROGRESS_STOP')) failures.push('corrective edit did not retain the progress diagnostic')
        if (!(payload.tools ?? []).some(tool => tool.function.name === 'subagent')) failures.push('corrective edit delegation was removed')
        call = { name: 'subagent', input: { agent: 'context_worker', description: 'Implement one fix and verify', prompt: `OBJECTIVE: Read and implement the concrete fix in ${source}, changing its text to native worker edited and verified, then verify by reading it back. TARGET: ${source}. DONE WHEN: changed text read back. OUT OF SCOPE: other files.` } }
      } else {
        if (!text.includes('PARENT_PROGRESS_STOP')) failures.push('parent did not receive successful native worker handoff')
        content = mode === 'whole-file-repair' ? 'STATUS: DONE. Repeated source copying stopped; a worker changed and verified source.txt.' : 'STATUS: PARTIAL. Repeated source inspection stopped; no edits completed.'
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = call ? { tool_calls: [{ index: 0, id: `route-${parentCalls}-${workerCalls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: 'assistant', content }
    const usage = mode === 'whole-file-compaction' && parentCalls === 2 && !text.includes('ROUTE_WORKER') && !text.includes('Write only a progress checkpoint')
      ? `data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [], usage: { prompt_tokens: 22000, completion_tokens: 100, total_tokens: 22100 } })}\n\n` : ''
    res.end(`data: ${JSON.stringify({ id: 'route-fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n${usage}data: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = {
    model: 'local-llama/fixture-parent', small_model: 'local-llama/fixture-parent', default_agent: 'router',
    enabled_providers: ['local-llama'], experimental: { subagent_depth: 1 }, compaction: { auto: mode === 'whole-file-compaction', buffer: 4096, keep: { tokens: 512 } },
    permission: { '*': 'allow', external_directory: { '*': 'deny' } },
    provider: { 'local-llama': { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: Object.fromEntries(['fixture-parent', 'fixture-child'].map(id => [id, { name: id, limit: { context: 22528, output: 4096 } }])) } },
    agent: Object.fromEntries(['router', 'context_worker'].map(name => [name, { ...original.agent[name], mode: 'all', model: `local-llama/${name === 'router' ? 'fixture-parent' : 'fixture-child'}`, prompt: name === 'router' ? 'ROUTE_PARENT: delegate the task once then report the actual handoff.' : 'ROUTE_WORKER: read the selected source and return its exact text.' }]))
  }
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(config))
  const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--format', 'json', '--agent', 'router', 'Read only the assigned source through one foreground worker.'], {
    cwd: project, env: { ...process.env, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: join(dir, 'opencode.json'), OPENCODE_DB: join(root, 'test.db'), OPENCODE_PERFORMANCE_DIAGNOSTIC: '1', OPENCODE_PROGRESS_TEST_DIR: join(root, 'progress'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
  try {
    const code = await new Promise(resolve => child.on('exit', resolve))
    const result = { mode, root, code, parentCalls, workerCalls, checkpoints, schemaClean, workerModel, verified, failures, stdout, stderr }
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ mode, root, code, parentCalls, workerCalls, checkpoints, schemaClean, workerModel, verified, failures }))
    if (mode === 'whole-file-compaction') assert.ok(checkpoints > 0, 'native parent compaction must run')
    assert.equal(code, 0, stderr.slice(-1800))
    assert.equal(parentCalls, mode === 'whole-file-repair' ? 5 : 4)
    assert.equal(workerCalls, mode === 'whole-file-repair' ? 8 : 4)
    assert.equal(schemaClean, true)
    assert.equal(workerModel, 'fixture-parent')
    assert.equal(verified, true)
    assert.deepEqual(failures, [])
    if (mode === 'whole-file-repair') assert.equal(await readFile(source, 'utf8'), 'native worker edited and verified\n')
    else assert.match(stdout, /Repeated source inspection stopped/)
  } finally {
    clearTimeout(timer)
    if (child.exitCode == null) child.kill('SIGTERM')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
