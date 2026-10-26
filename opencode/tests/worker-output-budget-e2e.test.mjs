import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const original = JSON.parse(await readFile(join(base, 'opencode.json'), 'utf8'))
const alias = 'qwen3.6-35b-a3b-iq3-xxs-splash'
const summaries = []
const modes = process.env.OUTPUT_BUDGET_CASE ? [process.env.OUTPUT_BUDGET_CASE]
  : ['delegated-repair', 'context-worker', 'general-parent', 'analysis-parent', 'unknown-role', 'explicit-lower', 'reserve', 'reserve-20867', 'reserve-cached-safe']
for (const mode of modes) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-output-budget-')))
  const dir = join(root, 'config/opencode'), project = join(root, 'project')
  await mkdir(join(dir, 'plugins'), { recursive: true }); await mkdir(project)
  for (const name of ['zzzzz-bonsai-no-thinking.ts', 'zzzz-subagent-parent-model.ts', 'tool-failure-recovery.ts', 'zzz-router-tool-recovery.ts', 'concise-compaction.ts', 'lib'])
    await cp(join(base, 'plugins', name), join(dir, 'plugins', name), { recursive: true })
  const artifact = join(project, 'result.txt'), source = join(project, 'large.txt')
  await writeFile(source, 'verified bounded source\n')
  const seen = [], errors = []
  let parentCalls = 0, workerCalls = 0, checkpoints = 0, recovered = false, verified = false
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    const p = JSON.parse(raw), text = JSON.stringify(p.messages)
    const worker = text.includes('BUDGET_WORKER'), parent = text.includes('BUDGET_PARENT')
    const checkpoint = text.includes('Write only a progress checkpoint')
    let content = 'Fixture title', call, finish, usage
    const kind = checkpoint ? 'checkpoint' : worker ? 'worker' : parent ? 'parent' : 'auxiliary'
    seen.push({ kind, maxTokens: p.max_tokens, model: p.model, thinking: p.chat_template_kwargs?.enable_thinking, reasoning: p.reasoning_effort, messageChars: text.length })
    if (checkpoint) { checkpoints++; content = 'Evidence\nRead the assigned file.\nRemaining\nReturn the verified result.\nNext action\nRETURN.<CHECKPOINT_END>' }
    else if (parent) {
      parentCalls++
      if (mode === 'delegated-repair' && parentCalls === 1)
        call = { name: 'subagent', input: { agent: 'general_worker', description: 'One bounded file repair', prompt: `OBJECTIVE: fix and verify result.txt only. TARGET: ${artifact}. KNOWN EVIDENCE: result.txt does not exist. DONE WHEN: contains verified correction. OUT OF SCOPE: all other files.` } }
      else content = 'STATUS: DONE. Parent received the verified worker result.'
    } else if (worker) {
      workerCalls++
      if (mode === 'delegated-repair') {
        if (workerCalls === 1) call = { name: 'write', raw: '{"path":"incomplete', input: {} }, finish = 'length'
        else if (workerCalls === 2) {
          recovered = text.includes('TOOL_FAILURE_RECOVERY')
          call = { name: 'write', input: { path: artifact, content: 'verified correction\n' } }
        } else if (workerCalls === 3) call = { name: 'read', input: { path: artifact, offset: 1, limit: 2 } }
        else { verified = text.includes('verified correction'); content = 'STATUS: DONE. result.txt repaired; read verified correction.' }
      } else if (mode.startsWith('reserve') && workerCalls === 1) {
        call = { name: 'read', input: { path: source, offset: 1, limit: 2 } }
        // This is valid native measured usage including a cached prefix.
        const prompt = mode === 'reserve-20867' ? 20867 : mode === 'reserve-cached-safe' ? 18000 : 19000
        usage = { prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10, prompt_tokens_details: { cached_tokens: 14000 } }
      } else content = 'STATUS: DONE. BUDGET_OK.'
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `budget-${parentCalls}-${workerCalls}`, type: 'function', function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.input) } }] } : { role: 'assistant', content }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'budget-fixture', object: 'chat.completion.chunk', created: 1, model: p.model, choices: [{ index: 0, delta, finish_reason: finish ?? (call ? 'tool_calls' : 'stop') }], ...(usage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const selected = ({ 'delegated-repair': 'router', 'context-worker': 'context_worker', 'general-parent': 'general', 'analysis-parent': 'long_analysis', 'unknown-role': 'unknown', 'explicit-lower': 'general_worker', reserve: 'general_worker', 'reserve-20867': 'general_worker', 'reserve-cached-safe': 'general_worker' })[mode]
  const profiles = {}
  for (const name of ['router', 'general', 'long_analysis', 'context_worker', 'general_worker', 'unknown']) {
    const isWorker = name.endsWith('_worker')
    profiles[name] = { ...(original.agent[name] ?? {}), mode: 'all', model: `local-llama/${alias}`, prompt: isWorker ? 'BUDGET_WORKER: perform only the assigned bounded file change and verification.' : 'BUDGET_PARENT: delegate once if necessary, then return the actual handoff.' }
  }
  if (mode === 'explicit-lower') profiles.general_worker.request = { body: { max_tokens: 512 } }
  const config = {
    model: `local-llama/${alias}`, small_model: `local-llama/${alias}`, default_agent: selected,
    enabled_providers: ['local-llama'], experimental: { subagent_depth: 1 }, permission: { '*': 'allow', external_directory: { '*': 'deny' } },
    compaction: { ...original.compaction, auto: mode.startsWith('reserve') },
    provider: { 'local-llama': { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: { [alias]: original.provider['local-llama'].models[alias] } } }, agent: profiles,
  }
  if (mode === 'explicit-lower') {
    // Native context options are the supported generation override. The final
    // wire policy must preserve a caller's deliberately smaller output limit.
    await writeFile(join(dir, 'plugins/000-explicit-budget-fixture.ts'), `export default {id:'explicit-budget-fixture',async setup(ctx){await ctx.session.hook('context',async e=>{e.options.maxTokens=512})}}`)
  }
  await writeFile(join(dir, 'opencode.json'), JSON.stringify(config))
  const child = spawn('/opt/homebrew/bin/opencode', ['run', '--standalone', '--format', 'json', '--agent', selected, 'Complete and verify the assigned bounded task.'], {
    cwd: project, env: { ...process.env, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: join(dir, 'opencode.json'), OPENCODE_DB: join(root, 'test.db'), OPENCODE_PERFORMANCE_DIAGNOSTIC: '1', OPENCODE_TELEMETRY_DIR: join(root, 'telemetry'), OPENCODE_PROGRESS_TEST_DIR: join(root, 'progress'), OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
  try {
    const code = await new Promise(resolve => child.on('exit', resolve))
    await writeFile(join(root, 'result.json'), JSON.stringify({ mode, code, parentCalls, workerCalls, checkpoints, recovered, verified, seen, stdout, stderr }, null, 2))
    summaries.push({ mode, root, code, parentCalls, workerCalls, checkpoints, recovered, verified, seen })
    await writeFile(join(base, '..', 'native-results-' + (base.includes('global-candidate') ? 'global' : 'runtime') + '.json'), JSON.stringify(summaries, null, 2))
    console.log(JSON.stringify({ mode, root, code, parentCalls, workerCalls, checkpoints, recovered, verified, seen }))
    assert.equal(code, 0, stderr.slice(-1600))
    for (const request of seen) {
      const expected = request.kind === 'worker' ? mode === 'explicit-lower' ? 512 : 4096 : request.kind === 'auxiliary' ? 64 : 2048
      if (mode.startsWith('reserve') && request.kind === 'worker') assert.ok(request.maxTokens > 0 && request.maxTokens <= 4096)
      else assert.equal(request.maxTokens, expected, `${mode}: ${request.kind} token ceiling`)
      assert.equal(request.thinking, false); assert.equal(request.reasoning, 'none'); assert.equal(request.model, alias)
    }
    if (mode === 'delegated-repair') {
      assert.equal(parentCalls, 2); assert.equal(workerCalls, 4); assert.equal(recovered, true); assert.equal(verified, true)
      assert.equal(await readFile(artifact, 'utf8'), 'verified correction\n')
    }
    if (mode.startsWith('reserve')) {
      if (mode === 'reserve-cached-safe') assert.equal(checkpoints, 0, 'cached tokens must not be counted twice into the 18432 compaction threshold')
      else assert.ok(checkpoints > 0, 'measured prompt tokens above 18432 must compact before continuing')
      assert.equal(config.compaction.buffer, 4096)
      assert.equal(config.provider['local-llama'].models[alias].limit.context, 22528)
      assert.ok(22528 - config.compaction.buffer + 4096 <= 24576)
    }
  } finally {
    clearTimeout(timer); if (child.exitCode == null) child.kill('SIGTERM')
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}
