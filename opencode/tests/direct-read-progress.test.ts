import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { directReadProgress } from "../plugins/lib/direct-read-progress.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),"direct-progress-unit-")), path = join(dir,"source with spaces.txt")
  await writeFile(path,"source evidence\n".repeat(400))
  const hooks = directReadProgress()
  let serial = 0
  const context = async (text = "Review source", options: any = {}) => {
    const event: any = {sessionID:"unit-direct",agent:"general",model:{providerID:"local-llama"},
      messages:[{role:"user",content:text}],tools:{read:{},shell:{},edit:{}},...options}
    await hooks.context(event);return event
  }
  const read = async (offset=1,limit=80,options: any={}) => {
    const {after={},...overrides}=options
    const event:any = {sessionID:"unit-direct",tool:"read",callID:String(++serial),input:{path,offset,limit},...overrides}
    await hooks.before(event)
    await hooks.after({...event,status:"completed",result:{metadata:{returnedStart:offset,returnedEnd:offset+limit-1}},...after})
  }
  await context()
  return {path,dir,hooks,context,read}
}

test("third walkthrough stops per revision while new ranges and structural tools remain available",async()=>{
  const r=await fixture()
  for(let pass=0;pass<2;pass++)for(const offset of [1,81,161])await r.read(offset)
  await assert.rejects(r.read(),/DIRECT_READ_PROGRESS_STOP/)
  const event=await r.context()
  assert.match(JSON.stringify(event.messages),/project-local structural check/)
  assert.deepEqual(Object.keys(event.tools),["read","shell","edit"])
  await r.hooks.context(event)
  assert.equal(event.messages.filter((m:any)=>m.role==="system").length,1)
  await r.read(241)
  await r.hooks.before({sessionID:"unit-direct",tool:"shell",input:{command:"python3 check.py"}})
})

test("shifted overlapping windows cannot disguise a third pass",async()=>{
  const r=await fixture()
  await r.read(1,100);await r.read(1,100)
  await assert.rejects(r.read(11,80),/DIRECT_READ_PROGRESS_STOP/)
  await r.read(101,80)
})

test("compaction preserves history and permits one successful targeted reread per checkpoint",async()=>{
  const r=await fixture()
  await r.read();await r.read()
  await r.hooks.compaction({sessionID:"unit-direct"})
  await r.context("<conversation-checkpoint>\nHistorical context.\n<summary>\n## Binding user instructions (verbatim; authoritative)\nReview source\n## Historical progress\nSource read, text omitted.\n</summary>\n</conversation-checkpoint>")
  await assert.rejects(r.read(),/DIRECT_READ_PROGRESS_STOP/)
  await r.read(1,20,{after:{status:"failed"}})
  await r.read(1,20)
  await assert.rejects(r.read(1,20),/DIRECT_READ_PROGRESS_STOP/)
  await r.hooks.compaction({sessionID:"unit-direct"})
  await r.context("## Binding user instructions (verbatim; authoritative)\nReview source\n## Historical progress\nSecond checkpoint.")
  await r.read(1,20)
  await assert.rejects(r.read(1,20),/DIRECT_READ_PROGRESS_STOP/)
})

test("new requests, changed source, unrelated sessions and remote providers are isolated",async()=>{
  const r=await fixture()
  await r.read();await r.read()
  await r.context("Review accessibility independently")
  await r.read();await r.read()
  await writeFile(r.path,"new source revision\n")
  await r.read();await r.read()
  await r.context("Review source",{sessionID:"other"})
  await r.read(1,80,{sessionID:"other"})
  await r.context("Review source",{model:{providerID:"remote"}})
  for(let n=0;n<4;n++)await r.read()
  await r.context("Worker review",{agent:"general_worker"})
  for(let n=0;n<4;n++)await r.read()
})

test("new user input immediately after compaction releases the old scope",async()=>{
  const r=await fixture()
  await r.read();await r.read()
  await r.hooks.compaction({sessionID:"unit-direct"})
  await r.context("Now review a different concern")
  await r.read()
})

test("failed and byte-limited results never invent read coverage",async()=>{
  const r=await fixture()
  for(let n=0;n<4;n++)await r.read(1,80,{after:{status:"failed"}})
  const result={metadata:{returnedStart:1,returnedEnd:10,partialLine:true}}
  await r.read(1,80,{after:{result}});await r.read(1,80,{after:{result}})
  // Identical partial output can loop, but lines 10-80 remain unseen.
  await assert.rejects(r.read(1,80),/DIRECT_READ_PROGRESS_STOP/)
  await r.read(10,80)
})

test("canonical aliases and actual numbered return windows share history",async()=>{
  const r=await fixture(),alias=join(r.dir,"alias.txt")
  await symlink(r.path,alias)
  const result={content:[{type:"text",text:"Read file source, lines 1-2\n1: one\n2: two"}]}
  await r.read(1,80,{after:{result}})
  await r.read(1,80,{input:{path:alias,offset:1,limit:80},after:{result}})
  await assert.rejects(r.read(1,80),/DIRECT_READ_PROGRESS_STOP/)
  await r.read(3,80)
})

test("duplicate hook delivery does not consume another targeted allowance",async()=>{
  const r=await fixture()
  await r.read();await r.read()
  const event={sessionID:"unit-direct",tool:"read",callID:"duplicate",input:{path:r.path,offset:1,limit:20}}
  await r.hooks.before(event);await r.hooks.before(event)
  const terminal={...event,status:"completed",result:{metadata:{returnedStart:1,returnedEnd:20}}}
  await r.hooks.after(terminal);await r.hooks.after(terminal)
  await assert.rejects(r.read(1,20),/DIRECT_READ_PROGRESS_STOP/)
})
