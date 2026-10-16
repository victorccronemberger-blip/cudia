import { expect } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { CodeModeTool } from "@/tool/code-mode"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const serverName = "cudia-browser"
const sessionID = SessionID.make("ses_local_browser")
const browserConfig = {
  type: "local" as const,
  command:
    process.platform === "win32" && process.arch === "x64"
      ? ["cudia:browser", "--headless", "--isolated", "--browser", "chromium", "--no-webmcp"]
      : ["npx", "--yes", "@playwright/mcp@0.0.83", "--headless", "--isolated", "--browser", "chrome", "--no-webmcp"],
  enabled: false,
  timeout: 120_000,
}
const browserLayer = LayerNode.compile(
  LayerNode.group([MCP.node, Agent.node, Session.node, Plugin.node, Truncate.node]),
  [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ mcp: { [serverName]: browserConfig } }) })],
    [
      Agent.node,
      Layer.mock(Agent.Service, {
        get: () =>
          Effect.succeed({
            name: "build",
            mode: "primary",
            options: {},
            permission: Permission.fromConfig({ "*": "allow" }),
          }),
      }),
    ],
    [
      Session.node,
      Layer.mock(Session.Service, {
        get: () => Effect.succeed({ id: sessionID, permission: [] } as unknown as Session.Info),
      }),
    ],
    [
      Plugin.node,
      Layer.succeed(
        Plugin.Service,
        Plugin.Service.of({
          init: () => Effect.void,
          list: () => Effect.succeed([]),
          trigger: (_name, _input, output) => Effect.succeed(output),
        }),
      ),
    ],
  ],
)
const browser = testEffect(browserLayer)
// Explicit opt-in: Windows x64 prepares a managed browser; other hosts use Node/npx and Chrome.
const browserCase = process.env.CUDIA_BROWSER_TEST === "1" ? browser.instance : browser.instance.skip

browserCase(
  "starts a disabled browser on demand, renders JavaScript and clicks through CodeMode",
  () =>
    Effect.gen(function* () {
      const page = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
              new Response(
                '<!doctype html><html><body><h1 id="state">Static page</h1><button onclick="document.querySelector(\'#state\').textContent=\'Clicked with JavaScript\'">Change</button><script>document.querySelector("#state").textContent="JavaScript ready"</script></body></html>',
                { headers: { "Content-Type": "text/html" } },
              ),
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const mcp = yield* MCP.Service
      const instance = yield* TestInstance
      expect((yield* mcp.status())[serverName]?.status).toBe("disabled")
      expect(Object.keys(yield* mcp.tools())).toEqual([])
      const permissions: string[] = []
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_local_browser"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (input) =>
          Effect.sync(() => {
            permissions.push(input.permission)
          }),
      }
      const definition = yield* CodeModeTool.pipe(Effect.flatMap(Tool.init))
      const run = (code: string) => definition.execute({ code }, ctx)
      yield* run(`return await tools.$mcp.connect({server:${JSON.stringify(serverName)}})`)
      expect((yield* mcp.status())[serverName]?.status).toBe("connected")
      const discover = Effect.fn(function* (name: string) {
        const result = yield* run(`return await tools.$codemode.search({query:${JSON.stringify(name)}})`)
        const value = JSON.parse(result.output) as { items: Array<{ path: string }> }
        const item = value.items.find((item) => item.path.endsWith("." + name))
        if (!item) return yield* Effect.die(new Error(`Missing discovered browser tool: ${name}`))
        return item.path
      })
      const navigate = yield* discover("browser_navigate")
      const loaded = yield* run(`return await ${navigate}({url:${JSON.stringify(page.url.href)}})`)
      const snapshot = Effect.fn(function* (output: string) {
        const reference = output.match(/\[Snapshot\]\(([^)]+)\)/)?.[1]
        if (!reference) return output
        const file = path.resolve(instance.directory, reference)
        if (!file.startsWith(instance.directory + path.sep))
          return yield* Effect.die(new Error("Snapshot outside test workspace"))
        return yield* Effect.promise(() => Bun.file(file).text())
      })
      const rendered = yield* snapshot(loaded.output)
      expect(rendered).toContain("JavaScript ready")
      const target = rendered.match(/button "Change" \[ref=([^\]]+)\]/)?.[1]
      if (!target) return yield* Effect.die(new Error("Rendered button reference missing"))
      const click = yield* discover("browser_click")
      const clickDefinition = Object.values(yield* mcp.tools()).find((tool) => tool.def.name === "browser_click")
      const properties = clickDefinition?.def.inputSchema.properties ?? {}
      const args = "target" in properties ? { target } : { ref: target, element: "Change button" }
      const clicked = yield* run(`return await ${click}(${JSON.stringify(args)})`)
      expect(yield* snapshot(clicked.output)).toContain("Clicked with JavaScript")
      expect(permissions).toContain("mcp.connect")
      expect(permissions.some((permission) => permission.endsWith("browser_navigate"))).toBe(true)
      expect(permissions.some((permission) => permission.endsWith("browser_click"))).toBe(true)
      yield* run(`return await tools.$mcp.disconnect({server:${JSON.stringify(serverName)}})`)
      expect((yield* mcp.status())[serverName]?.status).toBe("disabled")
    }),
  1_500_000,
)

const local = testEffect(LayerNode.compile(MCP.node))
const processCase = process.env.CUDIA_BROWSER_TEST === "1" ? local.instance : local.instance.skip
processCase(
  "interrupting real MCP process startup closes the spawned process",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const instance = yield* TestInstance
      const started = path.join(instance.directory, "started.pid")
      expect((yield* mcp.status()).hanging?.status).toBe("disabled")
      const fiber = yield* mcp.connect("hanging").pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.promise(async () => ((await Bun.file(started).exists()) ? true : undefined)),
        "MCP child did not start",
      )
      const pid = Number(yield* Effect.promise(() => Bun.file(started).text()))
      expect(Number.isInteger(pid) && pid > 0).toBe(true)
      yield* Fiber.interrupt(fiber)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "Interrupted MCP child did not exit",
        "10 seconds",
      )
    }),
  {
    config: {
      mcp: {
        hanging: {
          type: "local",
          command: [
            process.execPath,
            "--eval",
            'require("node:fs").writeFileSync("started.pid", String(process.pid));setInterval(()=>{},1000)',
          ],
          enabled: false,
          timeout: 120_000,
        },
      },
    },
  },
  20_000,
)
