// Session wire policy covers ordinary and built-in auxiliary calls. Native
// ctx.generate.text bypasses it; concise-compaction uses a bounded variant.
const policy = (model: any) => {
  if (model?.providerID !== "local-llama") return
  if (["bonsai-27b-splash", "bonsai-heretic-27b-splash"].includes(model.id))
    return { output: 4096, title: 128 }
  if (model.id === "qwen3.6-35b-a3b-iq3-xxs-splash")
    return { output: 2048, title: 64 }
}

async function constrain(request: Request, ceiling = 4096): Promise<Request> {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return request
  const body = await request.clone().json()
  const limits = [ceiling, body.max_tokens, body.max_completion_tokens]
    .filter(value => Number.isSafeInteger(value) && value > 0)
  body.max_tokens = Math.min(...limits)
  delete body.max_completion_tokens
  delete body.reasoningEffort
  body.reasoning_effort = "none"
  body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: false }
  const headers = new Headers(request.headers)
  headers.set("x-opencode-effective-reasoning-effort", "none")
  headers.set("x-opencode-effective-thinking", "false")
  headers.set("x-opencode-effective-max-tokens", String(body.max_tokens))
  headers.delete("content-length")
  return new Request(request, { headers, body: JSON.stringify(body) })
}

export default {
  id: "bonsai-no-thinking",
  async setup(ctx: any) {
    if (ctx.session?.hook) {
      // Trust native session roles, never prompt text or generated arguments.
      const workers = new Map<string, { providerID: string; id: string }>()
      await ctx.session.hook("context", async (event: any) => {
        workers.delete(event.sessionID)
        if (!["general_worker", "context_worker"].includes(event.agent)
          || event.model?.providerID !== "local-llama"
          || event.model.id !== "qwen3.6-35b-a3b-iq3-xxs-splash") return
        workers.set(event.sessionID, { providerID: event.model.providerID, id: event.model.id })
        if (workers.size > 128) workers.delete(workers.keys().next().value!)
      })
      await ctx.session.hook("http.request", async (event: any) => {
        const limits = policy(event.model)
        if (!limits) return
        const worker = workers.get(event.sessionID)
        // One primary request per observed context. A request-only replay or
        // recycled session ID cannot reuse a previous worker allowance.
        if (event.kind === "primary") workers.delete(event.sessionID)
        const ceiling = event.kind === "primary" && worker
          && worker.providerID === event.model.providerID && worker.id === event.model.id
          ? 4096 : limits.output
        event.request = await constrain(event.request, event.kind === "title" ? limits.title : ceiling)
      })
    } else {
      // Current v2 SDK: wrap the final provider fetch, after request options
      // and built-in auxiliary reasoning defaults have been serialized.
      await ctx.aisdk.sdk(async (event: any) => {
        const limits = policy(event.model)
        if (!limits) return
        const fetcher = event.options.fetch ?? globalThis.fetch
        event.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
          fetcher(await constrain(new Request(input, init), limits.output))
      })
    }
  },
}
