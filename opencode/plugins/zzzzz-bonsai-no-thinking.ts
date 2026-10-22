// Final wire policy also covers OpenCode's title/compaction/generate calls.
const bonsai = (model: any) => model?.providerID === "local-llama" &&
  ["bonsai-27b-splash", "bonsai-heretic-27b-splash"].includes(model.id)

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
  headers.delete("content-length")
  return new Request(request, { headers, body: JSON.stringify(body) })
}

export default {
  id: "bonsai-no-thinking",
  async setup(ctx: any) {
    if (ctx.session?.hook) {
      await ctx.session.hook("http.request", async (event: any) => {
        if (!bonsai(event.model)) return
        event.request = await constrain(event.request, event.kind === "title" ? 128 : 4096)
      })
    } else {
      // Current v2 SDK: wrap the final provider fetch, after request options
      // and built-in auxiliary reasoning defaults have been serialized.
      await ctx.aisdk.sdk(async (event: any) => {
        if (!bonsai(event.model)) return
        const fetcher = event.options.fetch ?? globalThis.fetch
        event.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
          fetcher(await constrain(new Request(input, init)))
      })
    }
  },
}
