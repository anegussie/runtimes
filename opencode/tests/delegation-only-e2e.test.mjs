import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,cp,readFile,writeFile,realpath} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import http from 'node:http'

const sourceConfig=process.env.CONFIG_DIR??join(dirname(new URL(import.meta.url).pathname),'..')
const original=JSON.parse(await readFile(join(sourceConfig,'opencode.json'),'utf8'))
const profiles=(process.env.PROFILES??'router,general,long_analysis').split(',')
let anyFailure=false
for(const profile of profiles){
 const root=await realpath(await mkdtemp(join(tmpdir(),'opencode-delegation-only-')))
 const isolated=join(root,'config/opencode'),project=join(root,'project')
 await mkdir(isolated,{recursive:true});await mkdir(project)
 await cp(join(sourceConfig,'plugins'),join(isolated,'plugins'),{recursive:true})
 const source=join(project,'fixture.txt'),secret='PRIVATE_SOURCE_EVIDENCE_64918'
 await writeFile(source,`Fixture evidence: the verified count is 7.\n${secret}\n`)
 const agents={}
 for(const name of new Set([profile,'context_worker','general_worker'])){
  const agent=original.agent[name]
  const match=agent.prompt?.match(/^\{file:(.+)\}$/)
  const prompt=match?await readFile(match[1].replaceAll('__OPENCODE_CONFIG_DIR__',sourceConfig).replaceAll('__RUNTIME_ROOT__',dirname(sourceConfig)),'utf8'):agent.prompt
  agents[name]={...agent,model:'local-llama/fixture',prompt:`${name===profile?'PRIMARY':'WORKER'}_DELEGATION_FIXTURE_${name}\n${prompt}`}
 }
 let parentCalls=0,workerCalls=0,seq=0
 const requests=[],failures=[]
 const rejectedTool=(text)=>/unknown tool|not available|not found|not permitted|not allowed|unavailable|invalid tool|permission|does not exist|unsupported|No tool named/i.test(text)
 const server=http.createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk
   if(!req.url?.endsWith('/chat/completions')){res.writeHead(404).end();return}
   const payload=JSON.parse(raw),text=JSON.stringify(payload.messages),names=(payload.tools??[]).map(x=>x.function.name)
   const worker=text.includes('WORKER_DELEGATION_FIXTURE_general_worker')
   const primary=!worker&&text.includes(`PRIMARY_DELEGATION_FIXTURE_${profile}`)
   let content='Fixture title',call
   if(worker){
    workerCalls++;requests.push({kind:'worker',payload})
    if(workerCalls===1)call={name:'read',input:{path:source,offset:1,limit:2}}
    else{
     if(!text.includes(secret))failures.push('worker did not read the real source evidence')
     content='STATUS: DONE\nFINDINGS: fixture.txt:1 verified count 7.\nCHANGED: none\nCHECKS: read the assigned two lines.\nNEXT: none.'
    }
   }else if(primary){
    parentCalls++;requests.push({kind:'parent',payload})
    if(text.includes(secret))failures.push('secret source text reached the parent')
    for(const forbidden of ['read','shell','bash','execute','grep','glob','list','edit','write','skill','websearch','webfetch'])if(names.includes(forbidden))failures.push(`parent advertised forbidden tool ${forbidden}`)
    for(const required of parentCalls===1?['subagent','question']:['subagent'])if(!names.includes(required))failures.push(`parent missing ${required}`)
    if(payload.parallel_tool_calls!==false)failures.push('parent parallel_tool_calls is not disabled')
    if(parentCalls===1)call={name:'read',input:{path:source,offset:1,limit:2}}
    else if(parentCalls===2){
     const last=[...payload.messages].reverse().find(x=>x.role==='tool')?.content??''
     if(!rejectedTool(String(last)))failures.push(`parent source read not explicitly rejected: ${String(last).slice(0,300)}`)
     call={name:'subagent',input:{agent:'general_worker',description:'Verify the assigned fixture',prompt:`Read only ${source} lines 1-2. Verify the count. Return a concise factual handoff. Never quote the private source marker or reproduce source contents.`}}
    }else{
     if(!text.includes('STATUS: DONE')||!text.includes('verified count 7'))failures.push('concise verified worker handoff missing')
     content='DELEGATION_ONLY_OK. Worker verified count 7; no parent source read.'
    }
   }
   const delta=call?{tool_calls:[{index:0,id:`delegation-${++seq}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content}
   res.writeHead(200,{'content-type':'text/event-stream'})
   res.end(`data: ${JSON.stringify({id:'delegation-fixture',object:'chat.completion.chunk',created:1,model:payload.model,choices:[{index:0,delta,finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
  }catch(error){failures.push(String(error));res.writeHead(500).end(String(error))}
 })
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const config={...original,model:'local-llama/fixture',small_model:'local-llama/fixture',default_agent:profile,enabled_providers:['local-llama'],compaction:{...original.compaction,auto:false},experimental:{...original.experimental,subagent_depth:1},agent:agents,
 provider:{'local-llama':{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`},models:{fixture:{name:'fixture',limit:{context:24576,output:1024}}}}}}
 await writeFile(join(isolated,'opencode.json'),JSON.stringify(config))
 const child=spawn('/opt/homebrew/bin/opencode',['run','--standalone','--format','json','--agent',profile,'Complete the delegation fixture by assigning all investigation to general_worker. Return the concise verified handoff.'],{cwd:project,env:{...process.env,PWD:project,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG_DIR:isolated,OPENCODE_CONFIG:join(isolated,'opencode.json'),OPENCODE_DB:join(root,'test.db'),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_PROGRESS_TEST_DIR:join(root,'progress')},stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
 const timer=setTimeout(()=>child.kill('SIGTERM'),45000)
 try{
  const code=await new Promise(resolve=>child.on('exit',resolve))
  if(code!==0)failures.push(`child exit ${code}: ${stderr.slice(-800)}`)
  if(parentCalls!==3)failures.push(`expected 3 parent calls, got ${parentCalls}`)
  if(workerCalls!==2)failures.push(`expected 2 worker calls, got ${workerCalls}`)
  if(!stdout.includes('DELEGATION_ONLY_OK'))failures.push('parent completion missing')
  const events=stdout.split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}})
  const parentSession=events.find(e=>e.sessionID)?.sessionID
  const completedParentRead=events.some(e=>e.type==='tool_use'&&e.sessionID===parentSession&&e.part?.tool==='read'&&e.part?.state?.status==='completed')
  if(completedParentRead)failures.push('parent source read completed')
  await writeFile(join(root,'result.json'),JSON.stringify({profile,sourceConfig,code,parentCalls,workerCalls,failures:[...new Set(failures)],requests,stdout,stderr},null,2))
  console.log(JSON.stringify({passed:failures.length===0,profile,root,code,parentCalls,workerCalls,failures:[...new Set(failures)],parentTools:requests.find(x=>x.kind==='parent')?.payload.tools?.map(x=>x.function.name)}))
  if(failures.length)anyFailure=true
 }finally{clearTimeout(timer);if(child.exitCode==null)child.kill('SIGTERM');server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
assert.equal(anyFailure,false,'delegation-only native regression failed; see recorded artifacts')
