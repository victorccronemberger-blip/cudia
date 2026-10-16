import { expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { MCPClient } from "../src/mcp/client"
import { ConfigMCP } from "../src/config/mcp"
import { load } from "../src/tool/json-input"

const browserCase = process.env.CUDIA_BROWSER_TEST === "1" ? it : it.skip
const browserCommand =
  process.platform === "win32" && process.arch === "x64"
    ? ["cudia:browser", "--headless", "--isolated", "--browser", "chromium", "--no-webmcp"]
    : ["npx", "--yes", "@playwright/mcp@0.0.83", "--headless", "--isolated", "--browser", "chrome", "--no-webmcp"]

browserCase(
  "uses the Core MCP adapter to render JavaScript and click a snapshot-observed browser reference",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cudia-mcp-browser-"))
    let server: ReturnType<typeof Bun.serve> | undefined
    let failed = false
    let testFailure: unknown
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(
            '<!doctype html><html><body><h1 id="state">Static page</h1><button onclick="document.querySelector(\'#state\').textContent=\'Clicked with JavaScript\'">Change</button><script>document.querySelector("#state").textContent="JavaScript ready"</script></body></html>',
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          ),
      })
      const pageURL = server.url.href
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* MCPClient.open({
              server: new ConfigMCP.Local({ type: "local", command: browserCommand }),
              directory,
              timeout: { startup: 120_000, request: 30_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            const tools = yield* browser.list()
            const navigate = tools.find((tool) => tool.name === "browser_navigate")
            const snapshot = tools.find((tool) => tool.name === "browser_snapshot")
            const click = tools.find((tool) => tool.name === "browser_click")
            if (!navigate || !snapshot || !click) throw new Error("Pinned Playwright MCP browser tools are unavailable")

            const loaded = yield* browser.call("browser_navigate", { url: pageURL })
            if (loaded.isError) throw new Error("Browser navigation failed")
            const initial = yield* browser.call("browser_snapshot", {})
            if (initial.isError) throw new Error("Browser snapshot failed")
            const rendered = text(initial)
            expect(rendered).toContain("JavaScript ready")
            const reference = rendered.match(/button "Change" \[ref=([^\]]+)\]/)?.[1]
            if (!reference) throw new Error("Snapshot did not provide an observed button reference")

            const properties = click.inputSchema.properties
            const arguments_ =
              properties && "target" in properties
                ? { target: reference }
                : { ref: reference, element: "Change button" }
            const clicked = yield* browser.call("browser_click", arguments_)
            if (clicked.isError) throw new Error("Browser click failed")
            const updated = yield* browser.call("browser_snapshot", {})
            if (updated.isError) throw new Error("Updated browser snapshot failed")
            return text(updated)
          }),
        ),
      )
      expect(result).toContain("Clicked with JavaScript")
    } catch (error) {
      failed = true
      testFailure = error
    } finally {
      server?.stop(true)
      try {
        const absolute = resolve(directory)
        const temporaryRoot = resolve(tmpdir())
        const prefix = temporaryRoot.endsWith(sep) ? temporaryRoot : `${temporaryRoot}${sep}`
        if (
          !isAbsolute(absolute) ||
          absolute.toLowerCase() === temporaryRoot.toLowerCase() ||
          !absolute.toLowerCase().startsWith(prefix.toLowerCase())
        )
          throw new Error("Refusing to remove a browser MCP directory outside the temporary root")
        await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) {
        if (!failed) throw error
      }
    }
    if (failed) throw testFailure
  },
  1_500_000,
)

function text(result: MCPClient.Result) {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
}
