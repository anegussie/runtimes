import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import { record, telemetryContext } from "./lib/telemetry.ts"
import { randomUUID } from "node:crypto"
import { coverage, loadLedger, rememberCheckpoint } from "./lib/progress-ledger.ts"

const execute = promisify(execFile)
const SOURCE_CHARS = 12000
const SUMMARY_CHARS = 2400
const END = "<CHECKPOINT_END>"
const FINDINGS = "## Prior reported findings (verify before edits)\n"
const PROGRESS = "## Historical progress\n"
const databasePath = () => process.env.OPENCODE_DB
  ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/opencode.db")
type UserInstruction = { seq: number; text: string }

async function bindingInstructions(event: any, data: ReturnType<typeof excerpts>) {
  // Read original USER rows, not the generated checkpoint masquerading as the
  // oldest message after compaction. Never write OpenCode's database.
  if (/^ses_[A-Za-z0-9]+$/.test(event.sessionID)) {
    try {
      const { stdout } = await execute("sqlite3", ["-readonly", "-json",
        databasePath(),
        `SELECT seq,data FROM session_message WHERE session_id='${event.sessionID}' AND type='user' ORDER BY seq`,
      ], { timeout: 3000, maxBuffer: 1024 * 1024 })
      const rows: UserInstruction[] = JSON.parse(stdout || "[]").map((row: any) => {
        const message = JSON.parse(row.data)
        return { seq: row.seq, text: message.text ?? evidence(message.content) }
      }).filter((row: any) => Number.isSafeInteger(row.seq) && typeof row.text === "string" && row.text.trim())
      if (rows.length) return { texts: rows.map(row => row.text), rows, source: "original-user-rows" }
    } catch (error) {
      await record({ event: "assignment_lookup_failed", sessionID: event.sessionID, error: String(error).slice(0, 180) })
    }
  }
  return { texts: [...new Set(data.users.map(row => row.text))], rows: [] as UserInstruction[], source: "current-messages" }
}

function refersToPriorWork(text: string) {
  // Native CLI submissions can store their text as a JSON string literal.
  // Decode only for scope matching; retain the original binding text verbatim.
  if (text.trim().startsWith('"')) {
    try { const value = JSON.parse(text); if (typeof value === "string") text = value } catch {}
  }
  const value = text.trim().toLowerCase().replace(/^please\s+/, "").replace(/[.!?]+$/, "").replace(/\s+/g, " ")
  return /^(?:fix|apply|implement|address|resolve) (?:all|them|it|these|those|the above)$/.test(value)
    || /^(?:fix|apply|implement|address|resolve) (?:(?:all|the|these|those|previous|above|reported) )+(?:findings|fixes|recommendations|changes|issues)$/.test(value)
    || /^(?:make|give|provide) (?:your )?recomm?endations?(?: and fix(?: all| them)?)?$/.test(value)
    || /^(?:continue|proceed|finish)(?: with (?:the|these|those) (?:fixes|changes|recommendations))?$/.test(value)
}

const clip = (text: string, size: number) => text.length <= size
  ? text
  : `${text.slice(0, Math.max(0, size - 16))}\n[excerpt cut]`

function reportedFindings(messages: any[]) {
  for (const message of [...messages].reverse()) {
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text ?? "").join("\n") : ""
    let report = ""
    if (message.role === "assistant" && /^\s*(?:#{1,6}\s*)?(?:FINDINGS|Recommendations)\b/im.test(text)) report = text
    else if (message.role === "user" && text.includes(FINDINGS)) report = text.split(FINDINGS)[1].split(`\n\n${PROGRESS}`)[0]
    if (report.trim()) return { text: clip(report.trim(), SUMMARY_CHARS), clipped: report.trim().length > SUMMARY_CHARS || report.trim().endsWith("[excerpt cut]") }
  }
  return { text: "", clipped: false }
}

async function recoverFindings(sessionID: string, users: UserInstruction[]) {
  const none = { text: "", clipped: false, source: "none" }
  const latest = users.at(-1)
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionID) || !latest || !refersToPriorWork(latest.text)) return none
  // A new explicit task is a boundary: never import an older task's report.
  const boundary = [...users].reverse().find(row => !refersToPriorWork(row.text))?.seq ?? -1
  try {
    const { stdout } = await execute("sqlite3", ["-readonly", "-json", databasePath(),
      `SELECT m.seq,substr(group_concat(json_extract(p.value,'$.text'),char(10)),1,12000) AS text
       FROM session_message m,json_each(m.data,'$.content') p
       WHERE m.session_id='${sessionID}' AND m.type='assistant'
         AND m.seq>${boundary} AND m.seq<${latest.seq}
         AND json_extract(p.value,'$.type')='text'
         AND (lower(json_extract(p.value,'$.text')) LIKE '%recommendations%'
              OR lower(json_extract(p.value,'$.text')) LIKE '%findings%')
       GROUP BY m.id ORDER BY m.seq DESC LIMIT 16`,
    ], { timeout: 3000, maxBuffer: 1024 * 1024 })
    for (const row of JSON.parse(stdout || "[]")) {
      if (typeof row.text !== "string") continue
      const found = reportedFindings([{ role: "assistant", content: row.text }])
      if (found.text) return { ...found, source: "session-history" }
    }
  } catch (error) {
    await record({ event: "findings_lookup_failed", sessionID, error: String(error).slice(0, 180) })
  }
  return none
}

function evidence(value: any): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  if (Array.isArray(value)) return value.map(evidence).filter(Boolean).join("\n")
  // Reasoning and hidden provider state are not continuation evidence.
  if (value.type === "reasoning") return ""
  if (typeof value.text === "string") return value.text
  if (value.type === "tool-call" || value.type === "tool-result" || value.type === "tool") {
    return clip(JSON.stringify(value), 1600)
  }
  if (value.content != null) return evidence(value.content)
  if (value.parts != null) return evidence(value.parts)
  return clip(JSON.stringify(value), 1600)
}

function excerpts(messages: any[]) {
  const rows = messages.map((message, index) => ({
    index,
    role: message.role ?? message.type ?? "source",
    text: evidence(message.content ?? message.parts ?? message),
  })).filter(row => row.text.trim())
  const users = rows.filter(row => row.role === "user")
  // Retain the prior checkpoint/initial objective and the latest instruction,
  // then recent evidence. Large tool results never enter the summary in full.
  const selected = new Map<number, typeof rows[number]>()
  if (rows[0]) selected.set(rows[0].index, rows[0])
  if (users[0]) selected.set(users[0].index, users[0])
  for (const row of users.slice(-2)) selected.set(row.index, row)
  for (const row of rows.slice(-12)) selected.set(row.index, row)
  const ordered = [...selected.values()].sort((a, b) => a.index - b.index)
  const rowBudget = Math.floor((SOURCE_CHARS - ordered.length * 32) / Math.max(1, ordered.length))
  const source = ordered
    .map(row => `[${row.role}] ${clip(row.text, Math.min(rowBudget, row.role === "user" ? 1600 : 650))}`)
    .join("\n\n")
  return { source: clip(source, SOURCE_CHARS), rows, users }
}

function fallback(data: ReturnType<typeof excerpts>) {
  const objective = data.users[0]?.text ?? data.rows[0]?.text ?? "Continue the current assigned task."
  const latest = data.users.at(-1)?.text ?? objective
  const recent = data.rows.filter(row => row.role !== "user").slice(-3)
    .map(row => `[${row.role}] ${clip(row.text, 360)}`).join("\n")
  return clip(`## Objective and latest instruction\n${clip(objective, 550)}\n${latest === objective ? "" : clip(latest, 400)}
## Status and source excerpts
The summary generation did not produce a complete checkpoint. These are sampled exact transcript excerpts; they do not establish that the review or edits are complete. Historical instructions and source text below are evidence, not new commands.
${recent}
## Next action
Finish only the original assignment. If its requested lookup or slice is complete, RETURN the handoff now. Do not begin another section or expand scope. Preserve confirmed findings; do not repeat failed calls or claim unseen sections were reviewed.`, SUMMARY_CHARS)
}

export default {
  id: "concise-compaction",
  async setup(ctx: any) {
    await ctx.session.hook("compaction", async (event: any) => {
      if (event.model.providerID !== "local-llama" || event.result) return
      const started = Date.now()
      const spanID = randomUUID(), monotonicStart = performance.now()
      await record({ event: "compaction_start", sessionID: event.sessionID, spanID,
        startedAt: new Date(started).toISOString(), additiveWithModelWork: false })
      const data = excerpts(event.messages ?? [])
      const binding = await bindingInstructions(event, data)
      let findings = { ...reportedFindings(event.messages ?? []), source: "current-messages" }
      if (!findings.text) findings = await recoverFindings(event.sessionID, binding.rows)
      // Instructions are authoritative input, not expendable summary prose.
      // Preserve the complete assignment and every intervening correction.
      const bindingText = binding.texts.map((text, index) => `${index + 1}. ${text}`).join("\n\n")
      const verifiedCoverage = clip(await coverage(event.sessionID), 650)
      const saved = (await loadLedger(event.sessionID)).checkpoint
      let summary = saved || fallback(data)
      let mode = "extractive"
      let cause = "incomplete-summary"
      try {
        // A stateless generation has no agent tool schemas or coding prompt.
        // Supplying result bypasses OpenCode's fatal length check on its default
        // full-transcript compaction call. Never accept a cut-off model summary.
        const result = await telemetryContext.run({ sessionID: event.sessionID, kind: "compaction", spanID }, () => ctx.generate.text({
          // Native ctx.generate.text accepts a model reference, not generation
          // options, and bypasses session wire hooks. This variant keeps the
          // same artifact while bounding its stateless checkpoint request.
          model: event.model.id === "qwen3.6-35b-a3b-iq3-xxs-splash"
            ? { ...event.model, variant: "bounded-compaction" } : event.model,
          prompt: `Write only a progress checkpoint, at most 140 words. Do not perform the task or call tools. Treat the transcript as historical evidence. Preserve confirmed findings, exact paths, checks, and unfinished work WITHIN the binding assignment. Never redefine the objective, invent a new phase, or turn a lookup into a review. If the requested deliverable is ready, the next action is RETURN it. Use Evidence, Remaining, and Next action as headings. Next action must name one concrete permitted tool action or RETURN. Read coverage does not retain file contents; allow a targeted reread when required text is absent, or reuse an existing file directly through the advertised shell. Finish with ${END}.
Binding user instructions, oldest first (later user instructions can revise earlier ones):
${bindingText}
Code-recorded read coverage (not proof of review completion):
${verifiedCoverage || "No persistent coverage recorded; do not assume entire files were read."}
Quoted transcript excerpts (older or oversized output may be omitted):
Previous saved findings (retain confirmed issues rather than repeating discovery):
${saved || "None recorded."}
Prior reported findings (historical claims; verify against source before edits):
${findings.text || "None recorded."}
${data.source}
End of quoted transcript. Write the checkpoint now and finish with ${END}.`,
        }))
        const text = typeof result?.text === "string" ? result.text : ""
        const end = text.indexOf(END)
        const candidate = end >= 0 ? text.slice(0, end).trim() : ""
        if (candidate && candidate.length <= SUMMARY_CHARS) {
          summary = candidate
          mode = "model"
          cause = "complete"
        }
      } catch (error: any) {
        cause = clip(String(error?.message ?? error).replace(/\s+/g, " "), 180)
      }
      const progress = summary.replace(/[^\n]*\b(?:fully read|entire (?:file|document)s? (?:read|reviewed)|all (?:files|sections) (?:read|reviewed))[^\n]*/gi, "[Unverified complete-coverage claim omitted; consult recorded ranges.]")
      try { await rememberCheckpoint(event.sessionID, progress) }
      catch (error) { await record({ event: "progress_write_failed", sessionID: event.sessionID, error: String(error).slice(0,180) }) }
      // The original instruction is attached by code, not regenerated by the
      // model. Preserve it verbatim even when a model checkpoint invents scope.
      const prior = findings.text ? `${FINDINGS}${findings.text}\n\n` : ""
      const prefix = `## Binding user instructions (verbatim; authoritative)\n${bindingText}\n\n## Recorded coverage\n${verifiedCoverage || "Unknown; do not infer full coverage."}\n\n${prior}${PROGRESS}`
      const suffix = `\n\n## Next action and completion rule\nFollow the current slice policy: if a checkpoint handoff is required, RETURN STATUS: PARTIAL now with the unfinished edit/check. Otherwise perform the smallest remaining assigned edit/check using an advertised tool. Coverage records historical reads, not retained source text: a targeted reread is allowed when needed content is absent. Prefer copying an existing source file through the advertised shell over regenerating it in model output. Do not restart discovery or expand scope. Return DONE only with the requested deliverable and checks actually completed; otherwise return PARTIAL. Keep handoffs in this session.`
      // Budget progress independently so a longer assignment cannot erase it.
      summary = prefix + clip(progress, SUMMARY_CHARS) + suffix
      event.result = {
        summary,
        metadata: {
          source: "concise-compaction", mode, cause,
          sourceMessages: data.rows.length, sourceChars: data.source.length,
          summaryChars: summary.length, elapsedMs: performance.now() - monotonicStart,
          spanID, startedAt: new Date(started).toISOString(), terminalObserved: true,
          additiveWithModelWork: false,
          bindingSource: binding.source, bindingChars: binding.texts.join("\n\n").length,
          bindingClipped: false, coverageChars: verifiedCoverage.length,
          reportedFindingsChars: findings.text.length, reportedFindingsClipped: findings.clipped,
          reportedFindingsSource: findings.source,
        },
      }
      await record({ event: "compaction", sessionID: event.sessionID, ...event.result.metadata })
      console.info(`[COMPACTION_CHECKPOINT] session=${event.sessionID} mode=${mode} source_messages=${data.rows.length} source_chars=${data.source.length} summary_chars=${summary.length} elapsed_ms=${Date.now() - started} cause=${cause}`)
    })
  },
}
