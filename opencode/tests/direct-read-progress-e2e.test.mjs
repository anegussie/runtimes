import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

const base = new URL('..', import.meta.url).pathname
for (const mode of ['walkthrough','compaction']) {
const root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-direct-read-')))
const dir = join(root, 'config/opencode'), project = join(root, 'project')
await mkdir(join(dir, 'plugins'), {recursive:true}); await mkdir(project)
for (const name of ['zz-parent-progress.ts','read-window-default.ts','lib',...(mode==='compaction'?['concise-compaction.ts']:[])])
  await cp(join(base,'plugins',name),join(dir,'plugins',name),{recursive:true})
const source=join(project,'source with spaces.txt')
await writeFile(source,Array.from({length:240},(_,i)=>`row ${i+1}: source evidence ${mode==='compaction'?'feedback '.repeat(40):''}\n`).join(''))
let calls=0, checkpoints=0, stopped=false, checked=false, final=false
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  if(!req.url?.endsWith('/chat/completions')){res.writeHead(404).end();return}
  const payload=JSON.parse(raw),text=JSON.stringify(payload.messages)
  let content='Fixture title',call
  if(text.includes('Write only a progress checkpoint')){
    checkpoints++;content='Evidence\nSource windows inspected.\nRemaining\nRun the structural check.\nNext action\nCheck the source structure.<CHECKPOINT_END>'
  }else if(text.includes('DIRECT_READ_FIXTURE')){
    calls++
    if(calls<=7)call={name:'read',input:{path:source,offset:1+80*((calls-1)%3)}}
    else if(calls===8){
      stopped=text.includes('DIRECT_READ_PROGRESS_STOP')
      call={name:'read',input:{path:source,offset:1,limit:20}}
    }else if(calls===9){
      call={name:'shell',input:{command:`python3 -c 'from pathlib import Path; print("STRUCTURE_OK", len(Path("source with spaces.txt").read_text().splitlines()))'`}}
    }else{
      checked=text.includes('STRUCTURE_OK 240')
      final=true;content='DONE: structural check found 240 source lines. Repeated walkthrough stopped.'
    }
  }
  const delta=call?{tool_calls:[{index:0,id:`direct-${calls}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content}
  res.writeHead(200,{'content-type':'text/event-stream'})
  res.end(`data: ${JSON.stringify({id:'direct-fixture',object:'chat.completion.chunk',created:1,model:payload.model,choices:[{index:0,delta,finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const config={model:'local-llama/fixture',small_model:'local-llama/fixture',default_agent:'general',enabled_providers:['local-llama'],permission:{'*':'allow',external_directory:{'*':'deny'}},compaction:{auto:mode==='compaction',buffer:512,keep:{tokens:512}},
 provider:{'local-llama':{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`},models:{fixture:{name:'fixture',limit:{context:mode==='compaction'?8192:22528,output:1024}}}}},
 agent:{general:{mode:'primary',model:'local-llama/fixture',prompt:'DIRECT_READ_FIXTURE: review the assigned file, run a structural check and report findings.'}}}
await writeFile(join(dir,'opencode.json'),JSON.stringify(config))
const child=spawn('/opt/homebrew/bin/opencode',['run','--standalone','--format','json','--agent','general','Review only the assigned source.'],{cwd:project,env:{...process.env,PWD:project,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG_DIR:dir,OPENCODE_CONFIG:join(dir,'opencode.json'),OPENCODE_DB:join(root,'test.db'),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_PERFORMANCE_DIAGNOSTIC:'1',OPENCODE_PROGRESS_TEST_DIR:join(root,'progress'),OPENCODE_TELEMETRY_DIR:join(root,'telemetry')},stdio:['ignore','pipe','pipe']})
let stdout='',stderr=''
child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
const timer=setTimeout(()=>child.kill('SIGTERM'),45000)
try{
 const code=await new Promise(resolve=>child.on('exit',resolve))
 await writeFile(join(root,'result.json'),JSON.stringify({mode,code,calls,checkpoints,stopped,checked,final,stdout,stderr},null,2))
 console.log(JSON.stringify({mode,root,code,calls,checkpoints,stopped,checked,final}))
 assert.equal(code,0,stderr.slice(-1800));assert.equal(stopped,true,'third walkthrough must be interrupted')
 assert.equal(checked,true,'structural verification must remain usable');assert.equal(final,true)
 const tools=stdout.split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.type==='tool_use').map(x=>x.part)
 assert.equal(tools.filter(x=>x.tool==='read'&&x.state?.status==='completed').length,7,'two walkthroughs plus one targeted reread')
 if(mode==='compaction')assert.ok(checkpoints>0,'native compaction must be exercised')
 assert.ok(stdout.includes('Repeated walkthrough stopped'))
}finally{
 clearTimeout(timer);if(child.exitCode==null)child.kill('SIGTERM')
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
}
