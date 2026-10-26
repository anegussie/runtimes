import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// OpenCode 2.1 drops legacy agent temperature/top_p during translation.
// Fill missing wire values, preserving explicit native/session overrides.
export default {
  id: "local-sampling",
  async setup(ctx: any) {
    const directory = process.env.OPENCODE_CONFIG_DIR
      ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
    const config = JSON.parse(await readFile(process.env.OPENCODE_CONFIG ?? join(directory, "opencode.json"), "utf8"))
    const agents = new Map<string, string>()
    await ctx.session.hook("context", async (event: any) => {
      if (event.agent) agents.set(event.sessionID, event.agent)
      if (agents.size > 128) agents.delete(agents.keys().next().value!)
    })
    await ctx.session.hook("http.request", async (event: any) => {
      if (event.kind !== "primary" || event.model?.providerID !== "local-llama"
        || !new URL(event.request.url).pathname.endsWith("/chat/completions")) return
      const profile = config.agent?.[agents.get(event.sessionID) ?? event.agent]
      if (!profile) return
      const body = await event.request.clone().json()
      let changed = false
      for (const [name, maximum] of [["temperature", 2], ["top_p", 1]] as const) {
        const value = profile[name]
        if (body[name] == null && typeof value === "number" && Number.isFinite(value)
          && value >= 0 && value <= maximum) { body[name] = value; changed = true }
      }
      if (!changed) return
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.request = new Request(event.request, { headers, body: JSON.stringify(body) })
    })
  },
}
