import { record } from "./lib/telemetry.ts"

type Model = { providerID: string; id: string; variant?: string }
const canonical = (model: Model) => `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`
const delegation = (name: string) => name === "subagent" || name === "task"
const missing = (error: any) => /(?:session|resource).*not found|notfound/i.test(`${error?.name ?? error?._tag ?? ""} ${error?.message ?? error}`)

// Local workers follow the invoking parent's resolved model. A model-generated
// override is never authoritative, and an invented session ID is not a resume.
export default {
  id: "subagent-parent-model",
  async setup(ctx: any) {
    const parents = new Map<string, Model>()
    await ctx.session.hook("context", async (event: any) => {
      if (!event.model?.providerID || !event.model.id) {
        parents.delete(event.sessionID); return
      }
      parents.set(event.sessionID, { ...event.model })
      if (parents.size > 128) parents.delete(parents.keys().next().value!)
    })
    // Run after router recovery serializes its tool list. Hide optional routing
    // controls in the wire schema, while keeping native validation/permissions.
    await ctx.session.hook("http.request", async (event: any) => {
      if (event.kind !== "primary" || event.model?.providerID !== "local-llama"
        || !new URL(event.request.url).pathname.endsWith("/chat/completions")) return
      const body = await event.request.clone().json()
      let changed = false
      for (const tool of body.tools ?? []) {
        if (!delegation(tool.function?.name)) continue
        const schema = tool.function.parameters
        if (!schema?.properties) continue
        delete schema.properties.model
        delete schema.properties.sessionID
        if (schema.required) schema.required = schema.required.filter((key: string) => !["model", "sessionID"].includes(key))
        tool.function.description = `${tool.function.description ?? ""}\nUse the current parent's model. For a fresh worker supply only the assignment, agent and description; omit model and sessionID.`
        changed = true
      }
      if (!changed) return
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.request = new Request(event.request, { headers, body: JSON.stringify(body) })
    })
    await ctx.tool.hook("execute.before", async (event: any) => {
      if (!delegation(event.tool) || !event.input || typeof event.input !== "object") return
      let model = parents.get(event.sessionID)
      if (!model) model = (await ctx.session.get({ sessionID: event.sessionID }))?.model
      if (model?.providerID !== "local-llama" || !model.id) return
      const input = event.input
      const target = canonical(model)
      const overridden = input.model != null && input.model !== target
      input.model = target
      let discardedSession = false
      if (typeof input.sessionID === "string") {
        let child
        try { child = await ctx.session.get({ sessionID: input.sessionID }) }
        catch (error) { if (!missing(error)) throw error }
        if (!child || child.parentID !== event.sessionID) {
          delete input.sessionID
          discardedSession = true
        }
      }
      if (overridden || discardedSession) await record({ event: "subagent_route_corrected", sessionID: event.sessionID,
        model: target, modelOverrideRemoved: overridden, staleSessionRemoved: discardedSession })
    })
  },
}
