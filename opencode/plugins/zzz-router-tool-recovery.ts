import { record } from "./lib/telemetry.ts"

type Dispatch = { final: boolean; recovery: boolean; repair?: string; definitions: any[] }
const errorMessage = (result: any) => {
  if (!["error", "error-text", "error-json"].includes(result?.type)) return ""
  const value = result.value
  return typeof value === "string" ? value : value?.error?.message ?? value?.message ?? ""
}
const parentAgents = new Set(["router", "general", "long_analysis"])
function incompleteDelegation(messages: any[]): boolean {
  const boundary = messages.findLastIndex(message => message.role === "user")
  let count = 0
  for (const message of messages.slice(boundary + 1)) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || !["subagent", "task"].includes(part.name ?? part.tool)) continue
      if (/^The tool call was not executed because the output token limit\b/.test(errorMessage(part.result))) count++
      else count = 0
    }
  }
  return count === 1
}
const unavailable = (messages: any[]) => {
  let boundary = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { boundary = i; break }
  if (boundary < 0) return false
  return messages.slice(boundary + 1).some(message => message.role === "tool" &&
    Array.isArray(message.content) && message.content.some((part: any) => part.type === "tool-result" &&
      /^No tool named "[^"]+" is currently available\./.test(errorMessage(part.result))))
}

// Runs after the question/slice hooks. It does not add execution tools to the
// router, rewrite user input, switch agents, run commands or keep a busy lock.
export default {
  id: "router-tool-recovery",
  async setup(ctx: any) {
    const dispatch = new Map<string, Dispatch>()
    await ctx.session.hook("context", async (event: any) => {
      if (event.model?.providerID !== "local-llama") return
      const names = Object.keys(event.tools ?? {})
      const final = names.length === 0
      // Workers also need a grammar-enforced text-only failure handoff.
      // Their ordinary requests and tool sets remain unchanged.
      if (!parentAgents.has(event.agent) && !final) { dispatch.delete(event.sessionID); return }
      const recovery = parentAgents.has(event.agent) && !final && unavailable(event.messages ?? [])
      if (recovery) {
        const tool = event.tools.subagent ?? event.tools.task
        event.tools = tool ? { [event.tools.subagent ? "subagent" : "task"]: tool } : {}
        const text = "ROUTER_TOOL_RECOVERY: An unavailable tool call failed. You are the router, not a shell executor. Never call execute, shell, bash, read or an invented tool here. execute({command: ...}) is not a shell API. If the user selected a project/directory/file, call the advertised subagent tool with agent, description and prompt for ONE bounded foreground slice at a time. Broad review starts with INVENTORY ONLY in that chosen target. If essential scope is still missing, ask one plain-text final question and stop. Do not replay any failed command or change the user's objective. After a successful child handoff, continue unfinished work within the original request sequentially without confirmation; stop on cancellation, backend/resource failure, or loop abort."
        if (!(event.messages ?? []).some((message: any) => message.role === "system" &&
          Array.isArray(message.content) && message.content.some((part: any) => part.type === "text" && part.text === text)))
          event.messages.push({ role: "system", content: [{ type: "text", text }] })
        await record({ event: "router_tool_recovery", sessionID: event.sessionID, action: "bounded_delegation_or_plain_clarification" })
      }
      const repair = parentAgents.has(event.agent) && !final && incompleteDelegation(event.messages ?? [])
        ? (event.tools.subagent ? "subagent" : event.tools.task ? "task" : undefined) : undefined
      if (repair) {
        event.tools = { [repair]: event.tools[repair] }
        event.messages.push({ role: "system", content: [{ type: "text", text: "ROUTER_DELEGATION_REPAIR: The previous delegation never executed because its arguments were truncated. Issue one compact corrected delegation now, using the selected target and original authorized objective. Include only objective, exact target, relevant findings, and done/check criteria; no recap, scripts, file contents or data tables. For an authorized implementation assign one concrete improvement as read -> edit -> verify in the same worker. Return changed paths and actual checks, not verbatim source. A second incomplete call ends with PARTIAL; do not retry terminal worker, permission, resource or loop failures." }] })
      }
      const previous = dispatch.get(event.sessionID)
      const definitions = Object.entries(event.tools ?? {}).map(([name, tool]: any) => ({ type: "function", function: {
        name, description: tool.description ?? "", parameters: tool.input ?? { type: "object", properties: {} },
      } }))
      dispatch.set(event.sessionID, { final: Object.keys(event.tools ?? {}).length === 0, recovery, repair,
        definitions: definitions.length ? definitions : previous?.definitions ?? [] })
      // Bound bookkeeping only; this is not an admission or tool-call limit.
      if (dispatch.size > 128) dispatch.delete(dispatch.keys().next().value!)
    })
    await ctx.session.hook("http.request", async (event: any) => {
      if (event.kind !== "primary" || event.model?.providerID !== "local-llama") return
      const state = dispatch.get(event.sessionID)
      if (!state || !new URL(event.request.url).pathname.endsWith("/chat/completions")) return
      const body = await event.request.clone().json()
      if (state.final) {
        // Splash's no-tools path has no output grammar. A nonempty schema
        // plus tool_choice=none activates its grammar that forbids tool tags.
        // These definitions are serialization only, never executable tools.
        body.tools = state.definitions.length ? state.definitions : [{ type: "function", function: {
          name: "__opencode_router_text_only", description: "Text-only protocol placeholder; never callable.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        } }]
        body.tool_choice = "none"
      } else if (state.repair && body.tools?.some((tool: any) => tool.function?.name === state.repair)) {
        // Only one actual incomplete delegation gets a required correction.
        // Ordinary replies/questions and terminal handoffs remain optional.
        body.tools = body.tools.filter((tool: any) => tool.function?.name === state.repair)
        body.tool_choice = { type: "function", function: { name: state.repair } }
      }
      // With an advertised tool list, Splash constrains generated function
      // names when parallel calls are disabled. Optional text remains allowed.
      body.parallel_tool_calls = false
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.request = new Request(event.request, { headers, body: JSON.stringify(body) })
    })
  },
}
