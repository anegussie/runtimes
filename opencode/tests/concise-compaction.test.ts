import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../plugins/concise-compaction.ts"
process.env.OPENCODE_PERFORMANCE_DIAGNOSTIC = "1"

const assignment = `You are a subagent spawned by another session.\nOBJECTIVE: rebuild /project/periodic-table.html from /project/tmp/opencode/full_script.js (118 elements + 118 posMap entries + render/createCell logic).\n${"Preserve existing working markup and dark navy styles. ".repeat(23)}\nDONE WHEN: render_dom_check.js shows 118 cells and zero errors.\nOUT OF SCOPE: no ec field.\nWORKER_SLICE_ID: example\nReturn line ranges and exact test output.`
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
async function compact(failure = false) {
  let handler: any, prompt = ""
  await plugin.setup({ session: { hook: async (_name: string, fn: any) => { handler = fn } },
    generate: { text: async (input: any) => { prompt = input.prompt; if (failure) throw Error("fixture unavailable"); return { text: "Evidence\n118 source records confirmed.\nRemaining\nAssemble HTML and run render_dom_check.js.\nNext action\nRETURN PARTIAL with unfinished reconstruction.<CHECKPOINT_END>" } } } })
  const event: any = { sessionID: `unit-compaction-${failure}`, model: { providerID: "local-llama" }, messages: [user(assignment), user("Correction: do not add any new data fields; keep all 118 entries.")] }
  await handler(event)
  return { event, prompt }
}
test("complete assignment, exclusions and later corrections survive compaction without crowding out progress", async () => {
  const { event, prompt } = await compact()
  assert.ok(assignment.length > 1100)
  assert.ok(event.result.summary.includes(assignment))
  assert.ok(event.result.summary.includes("Correction: do not add any new data fields; keep all 118 entries."))
  assert.match(event.result.summary, /Assemble HTML and run render_dom_check.js/)
  assert.match(event.result.summary, /targeted reread is allowed/)
  assert.match(event.result.summary, /checkpoint handoff is required, RETURN STATUS: PARTIAL/)
  assert.equal(event.result.metadata.bindingClipped, false)
  assert.match(prompt, /one concrete permitted tool action or RETURN/)
})
test("failed checkpoint generation preserves authoritative instructions and a concrete partial/handoff rule", async () => {
  const { event } = await compact(true)
  assert.ok(event.result.summary.includes(assignment))
  assert.equal(event.result.metadata.mode, "extractive")
  assert.match(event.result.summary, /otherwise return PARTIAL/)
  assert.match(event.result.summary, /checks actually completed/)
})
