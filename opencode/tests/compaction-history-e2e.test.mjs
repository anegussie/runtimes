import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-history-recovery-')))
const dir = join(root, 'config/opencode'), project = join(root, 'project')
await mkdir(join(dir, 'plugins'), {recursive:true}); await mkdir(project)
for (const name of ['concise-compaction.ts', 'lib'])
  await cp(join(base, 'plugins', name), join(dir, 'plugins', name), {recursive:true})
const marker = 'HISTORY_ONLY_FINDING'
// Emulate a session compacted by the older implementation: the report remains
// in real message storage, but is absent from the compaction input transcript.
await writeFile(join(dir, 'plugins/000-old-checkpoint.ts'), `export default {id:'old-checkpoint-fixture',async setup(ctx){await ctx.session.hook('compaction',async e=>{e.messages=(e.messages??[]).filter(m=>!JSON.stringify(m.content).includes('${marker}'))})}}`)
const source = join(project, 'source.txt')
await writeFile(source, Array.from({length:118},(_,i)=>`Evidence ${i}: ${'feedback '.repeat(70)}\n`).join(''))
let phase = 'initial', calls = 0, checkpoints = 0
const seen = []
const server = http.createServer(async(req,res)=>{
  let raw=''; for await(const chunk of req) raw+=chunk
  if(!req.url?.endsWith('/chat/completions')){res.writeHead(404).end();return}
  const payload=JSON.parse(raw), text=JSON.stringify(payload.messages)
  let content='Fixture title', call
  if(text.includes('Write only a progress checkpoint')){
    checkpoints++; seen.push({phase,checkpointHasFinding:text.includes(marker)})
    content='Evidence\nEarlier source inspected.\nRemaining\nCheck the reported issue.\nNext action\nRETURN.<CHECKPOINT_END>'
  } else if(text.includes('RECOVERY_FIXTURE')){
    calls++
    if(phase==='initial') content='Recommendations\n1. source.txt:2 HISTORY_ONLY_FINDING needs verification before editing.'
    else if(calls===1) call={name:'read',input:{path:source,offset:1,limit:120}}
    else content=text.includes(marker)?'RECOVERED_OK':'NO_REPORT'
  }
  res.writeHead(200,{'content-type':'text/event-stream'})
  const delta=call?{tool_calls:[{index:0,id:`read-${phase}-${calls}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content}
  res.end(`data: ${JSON.stringify({id:'history-fixture',object:'chat.completion.chunk',created:1,model:payload.model,choices:[{index:0,delta,finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const config={model:'local-llama/fixture',small_model:'local-llama/fixture',default_agent:'general',enabled_providers:['local-llama'],permission:{'*':'allow'},compaction:{auto:true,buffer:512,keep:{tokens:512}},
  provider:{'local-llama':{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`},models:{fixture:{name:'fixture',limit:{context:8192,output:1024}}}}},
  agent:{general:{mode:'primary',model:'local-llama/fixture',prompt:'RECOVERY_FIXTURE: inspect assigned source and verify the requested finding.'}}}
await writeFile(join(dir,'opencode.json'),JSON.stringify(config))
const env={...process.env,PWD:project,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG:join(dir,'opencode.json'),OPENCODE_CONFIG_DIR:dir,OPENCODE_DB:join(root,'test.db'),OPENCODE_PERFORMANCE_DIAGNOSTIC:'1',OPENCODE_PROGRESS_TEST_DIR:join(root,'progress'),OPENCODE_DISABLE_MODELS_FETCH:'true'}
const results=[]
async function run(message,sessionID){
  calls=0
  const child=spawn('/opt/homebrew/bin/opencode',['run','--standalone','--format','json','--agent','general',...(sessionID?['--session',sessionID]:[]),message],{cwd:project,env,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
  const timer=setTimeout(()=>child.kill('SIGTERM'),45000)
  try{
    const code=await new Promise(resolve=>child.on('exit',resolve))
    results.push({phase,code,calls,stdout,stderr})
    assert.equal(code,0,stderr.slice(-1600))
    return {stdout,sessionID:stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x)).find(x=>x.sessionID)?.sessionID}
  }finally{clearTimeout(timer);if(child.exitCode==null)child.kill('SIGTERM')}
}
try{
  const initial=await run(`Review ${source}`)
  assert.ok(initial.sessionID)
  assert.match(initial.stdout,/HISTORY_ONLY_FINDING/)
  phase='recover'
  const recovered=await run('fix all',initial.sessionID)
  assert.ok(checkpoints>0,'native compaction must run')
  assert.ok(recovered.stdout.includes('RECOVERED_OK'),'resumed session must recover the stored finding')
  assert.ok(seen.some(x=>x.phase==='recover'&&x.checkpointHasFinding),'stored finding must reach the checkpoint')
  phase='unrelated'
  const unrelated=await run('Review unrelated.txt',initial.sessionID)
  assert.ok(unrelated.stdout.includes('NO_REPORT'),'new explicit task must not recover the older task report')
  assert.ok(seen.some(x=>x.phase==='unrelated'&&!x.checkpointHasFinding),'new task must bound the history lookup')
  phase='foreign'
  const foreign=await run('fix all')
  assert.notEqual(foreign.sessionID,initial.sessionID)
  assert.ok(foreign.stdout.includes('NO_REPORT'),'fresh session must have no prior report')
  assert.ok(seen.some(x=>x.phase==='foreign'&&!x.checkpointHasFinding),'another session must not import the report')
  console.log(JSON.stringify({passed:true,root,checkpoints,seen}))
}finally{
  await writeFile(join(root,'result.json'),JSON.stringify({results,checkpoints,seen},null,2))
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
