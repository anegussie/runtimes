import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../plugins/zz-parent-progress.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

async function runtime(filename = "source.txt") {
  const root = await mkdtemp(join(tmpdir(), "parent-progress-unit-")), file = join(root, filename)
  await writeFile(file, "one\ntwo\nthree\nfour\n")
  const tool: any = {}, session: any = {}
  await plugin.setup({ tool: { hook: async (name: string, fn: any) => { tool[name] = fn } }, session: { hook: async (name: string, fn: any) => { session[name] = fn } } })
  const context = async (parent = "parent", request = "Fix this file", provider = "local-llama") => {
    const event = { sessionID: parent, model: { providerID: provider }, messages: [{ role: "user", content: request }], tools: { subagent: {}, question: {} } }
    await session.context(event); return event
  }
  let id = 0
  const assign = async (prompt: string, parent = "parent", result = "STATUS: DONE") => {
    const event = { tool: "subagent", sessionID: parent, callID: String(++id), input: { prompt } }
    await tool["execute.before"](event)
    await tool["execute.after"]({ ...event, status: "completed", result })
  }
  const read = (range = "1-2", objective = "Read", parent = "parent", result = "STATUS: DONE") => assign(`OBJECTIVE: ${objective} ${file} lines ${range} only.\nDONE WHEN: return source.`, parent, result)
  await context()
  return { file, context, read, assign, session }
}

test("quoted paths, sed commands and prose ranges share the same source history", async () => {
  for (const filename of ["source.txt", "source with spaces.txt"]) {
    const r = await runtime(filename)
    await r.assign(`OBJECTIVE: Read the exact lines in \`${r.file}\`.\nRun: sed -n '1,2p' "${r.file}"\nThis is READ-ONLY. Report verbatim.`)
    await r.assign(`OBJECTIVE: Read "${r.file}" to understand the issues.\nReport lines from 1 to 2 verbatim. This is READ-ONLY.`)
    await assert.rejects(r.assign(`OBJECTIVE: Read '${r.file}' lines 1 through 2 verbatim.`), /PARENT_PROGRESS_STOP/)
  }
})

test("ambiguous files and invalid ranges do not gate another task", async () => {
  const r = await runtime()
  for (let n=0; n<4; n++) {
    await r.assign(`OBJECTIVE: Read \`${r.file}\` and /other/source.txt lines 1-2 verbatim.`)
    await r.assign(`OBJECTIVE: Read \`${r.file}\` lines from 4 to 1 verbatim.`)
  }
  await r.read()
})

test("third overlapping source-only assignment stops, including renamed children and ranges", async () => {
  const r = await runtime()
  await r.read("1-3"); await r.read("1-4", "Retrieve")
  await assert.rejects(r.read("2-3", "Copy"), /PARENT_PROGRESS_STOP/)
  const stopped = await r.context()
  assert.ok(stopped.tools.subagent, "one corrective edit delegation remains available")
  assert.match(JSON.stringify(stopped.messages), /PARENT_PROGRESS_STOP/)
  await r.context("parent", "Continue with an essential targeted reread")
  await r.read("2-3")
})

test("new ranges, changed source, implementation and independent inspections remain available", async () => {
  const r = await runtime()
  await r.read(); await r.read(); await r.read("3-4")
  await r.read("1-2", "Read and fix")
  await r.read("1-2", "Inspect accessibility in")
  await writeFile(r.file, "changed source revision\n")
  await r.read()
})

test("partial handoffs, unrelated parents and remote providers do not accumulate a read stop", async () => {
  const r = await runtime()
  for (let i=0; i<4; i++) await r.read("1-2", "Read", "parent", "STATUS: PARTIAL missing source")
  await r.read(); await r.read()
  await r.context("other"); await r.read("1-2", "Read", "other")
  await r.context("remote", "Review", "remote-provider")
  for (let i=0; i<4; i++) await r.read("1-2", "Read", "remote")
})


test("whole-file copies stop across compaction but allow a corrective edit and new source", async () => {
  const r = await runtime()
  const whole = () => r.assign(`OBJECTIVE: Read the entire ${r.file} file and return its complete verbatim content organized by section.`)
  await whole(); await whole()
  await r.session.compaction({ sessionID: "parent" })
  const checkpoint = "## Binding user instructions (verbatim; authoritative)\n1. Fix this file"
  await r.context("parent", checkpoint)
  await assert.rejects(whole(), /PARENT_PROGRESS_STOP/)
  assert.ok((await r.context("parent", checkpoint)).tools.subagent)
  await r.assign(`OBJECTIVE: Read and implement one concrete fix in ${r.file}, then verify it.`)
  await r.read("3-4", "Review accessibility of")
  await assert.rejects(whole(), /PARENT_PROGRESS_STOP/)
  assert.deepEqual((await r.context("parent", checkpoint)).tools, {})
  await writeFile(r.file, "new revision\n")
  await r.context("parent", checkpoint)
  await whole()
})

test("whole-file checkpoints are attempts, not coverage of smaller remaining slices", async () => {
  const r = await runtime()
  const prompt = `OBJECTIVE: Read the full ${r.file} and return verbatim content.`
  await r.assign(prompt, "parent", "STATUS: PARTIAL checkpoint")
  await r.assign(prompt, "parent", "STATUS: PARTIAL checkpoint")
  await r.read("1-2")
  await assert.rejects(r.assign(prompt), /PARENT_PROGRESS_STOP/)
  for (let i=0;i<3;i++) await r.assign(`OBJECTIVE: Read the complete introduction section in ${r.file}.`)
})
