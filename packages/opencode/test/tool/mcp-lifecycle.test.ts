import { describe, expect, test } from "bun:test"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { CodeModeTool } from "@/tool/code-mode"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { awaitWithTimeout } from "../lib/effect"

type MutableState = {
  status: Record<string, MCP.Status>
  statusCalls: number
  connectedTools: Record<string, MCP.McpTool>
  connects: string[]
  disconnects: string[]
  hooks: { name: string; tool: string }[]
  mutateConnectName?: string
}

function mcpTool(name: string): MCP.McpTool {
  return {
    def: { name, description: name, inputSchema: { type: "object", properties: {} } } as MCPToolDef,
    client: {
      callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    } as unknown as MCP.McpTool["client"],
  }
}

function harness(input: {
  state: MutableState
  agentPermission?: PermissionV1.Ruleset
  sessionPermission?: PermissionV1.Ruleset
}) {
  return Layer.mergeAll(
    Layer.mock(Plugin.Service, {
      trigger: ((name: string, context: { tool?: string }, output: { args?: Record<string, unknown> }) =>
        Effect.sync(() => {
          const tool = context.tool ?? ""
          input.state.hooks.push({ name, tool })
          if (name === "tool.execute.before" && tool === "$mcp.connect" && input.state.mutateConnectName)
            return { ...output, args: { server: input.state.mutateConnectName } }
          return output
        })) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", permission: input.agentPermission ?? [] } as any),
    }),
    Layer.mock(Session.Service, {
      get: () => Effect.succeed({ permission: input.sessionPermission ?? [] } as any),
    }),
    Layer.mock(MCP.Service, {
      status: () =>
        Effect.sync(() => {
          input.state.statusCalls += 1
          return { ...input.state.status }
        }),
      clients: () =>
        Effect.sync(() =>
          Object.fromEntries(
            Object.entries(input.state.status)
              .filter(([, status]) => status.status === "connected")
              .map(([name]) => [name, {} as any]),
          ),
        ),
      tools: () => Effect.sync(() => input.state.connectedTools),
      instructions: () => Effect.succeed([]),
      connect: (name: string) =>
        Effect.sync(() => {
          input.state.connects.push(name)
          input.state.status[name] = { status: "connected" }
          input.state.connectedTools[`${name}_ping`] = mcpTool("ping")
        }),
      disconnect: (name: string) =>
        Effect.sync(() => {
          input.state.disconnects.push(name)
          input.state.status[name] = { status: "disabled" }
          delete input.state.connectedTools[`${name}_ping`]
        }),
    }),
  )
}

function makeState(status: Record<string, MCP.Status> = { browser: { status: "disabled" } }): MutableState {
  return { status, statusCalls: 0, connectedTools: {}, connects: [], disconnects: [], hooks: [] }
}

async function build(input: {
  state?: MutableState
  agentPermission?: PermissionV1.Ruleset
  sessionPermission?: PermissionV1.Ruleset
}) {
  const state = input.state ?? makeState()
  const tool = await Effect.runPromise(
    CodeModeTool.pipe(Effect.flatMap(Tool.init), Effect.provide(harness({ ...input, state }))),
  )
  return { tool, state }
}

function context(overrides: Partial<Tool.Context> = {}): Tool.Context {
  return {
    sessionID: SessionID.make("ses_mcp_lifecycle"),
    messageID: MessageID.make("msg_mcp_lifecycle"),
    agent: "build",
    abort: new AbortController().signal,
    callID: "call_mcp_lifecycle",
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    ...overrides,
  }
}

async function execute(tool: Tool.Def, code: string, ctx = context()) {
  return Effect.runPromise(tool.execute({ code }, ctx))
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the CodeMode script to fail")
}

describe("CodeMode MCP lifecycle", () => {
  test("lists only configured server names and status", async () => {
    const state = makeState({
      browser: { status: "disabled" },
      private: { status: "failed", error: "secret token and endpoint" },
    })
    const { tool } = await build({ state })
    const result = await execute(tool, "return await tools.$mcp.servers({})")

    expect(JSON.parse(result.output)).toEqual([
      { name: "browser", status: "disabled" },
      { name: "private", status: "failed" },
    ])
    expect(result.output).not.toContain("secret token")
    expect(state.connects).toEqual([])
  })

  test("lists configured servers despite a stored legacy deny rule", async () => {
    const { tool, state } = await build({
      sessionPermission: [{ permission: "mcp.servers", pattern: "*", action: "deny" }],
    })
    const result = await execute(tool, "return await tools.$mcp.servers({})")

    expect(JSON.parse(result.output)).toEqual([{ name: "browser", status: "disabled" }])
    expect(state.statusCalls).toBe(2)
    expect(state.hooks.filter((hook) => hook.tool === "$mcp.servers").map((hook) => hook.name)).toEqual([
      "tool.execute.before",
      "tool.execute.after",
    ])
    expect(state.connects).toEqual([])
  })

  test("connects once and discovers newly connected tools on the next execute call", async () => {
    const { tool, state } = await build({})
    const asks: string[] = []
    const ctx = context({
      ask: (input) => {
        asks.push(`${input.permission}:${input.patterns.join(",")}`)
        return Effect.void
      },
    })

    const connected = await execute(tool, "return await tools.$mcp.connect({ server: 'browser' })", ctx)
    expect(JSON.parse(connected.output)).toMatchObject({
      name: "browser",
      status: "connected",
      message: expect.stringContaining("next execute call"),
    })
    expect(state.connects).toEqual(["browser"])
    expect(asks).toEqual(["mcp.connect:browser"])

    const ping = await execute(tool, "return await tools.browser.ping({})", ctx)
    expect(ping.output).toBe("pong")

    const again = await execute(tool, "return await tools.$mcp.connect({ server: 'browser' })", ctx)
    expect(JSON.parse(again.output).message).toBe("Already connected.")
    expect(state.connects).toEqual(["browser"])
    expect(state.hooks.filter((hook) => hook.tool === "$mcp.connect").map((hook) => hook.name)).toEqual([
      "tool.execute.before",
      "tool.execute.after",
      "tool.execute.before",
      "tool.execute.after",
    ])
  })

  test("rejects unknown and hook-mutated server names before connecting", async () => {
    const state = makeState()
    const { tool } = await build({ state })
    const ctx = context()
    const unknown = await failure(execute(tool, "return await tools.$mcp.connect({ server: 'not-configured' })", ctx))
    expect(unknown.message).toContain("Unknown configured MCP server")

    state.mutateConnectName = "injected-server"
    const mutated = await failure(execute(tool, "return await tools.$mcp.connect({ server: 'browser' })", ctx))
    expect(mutated.message).toContain("Unknown configured MCP server: injected-server")
    expect(state.connects).toEqual([])
  })

  test("connects despite a stored session deny overriding an agent allow", async () => {
    const { tool, state } = await build({
      agentPermission: [{ permission: "mcp.connect", pattern: "browser", action: "allow" }],
      sessionPermission: [{ permission: "mcp.connect", pattern: "browser", action: "deny" }],
    })
    let asked = false
    const result = await execute(
      tool,
      "return await tools.$mcp.connect({ server: 'browser' })",
      context({ ask: () => Effect.sync(() => (asked = true)) }),
    )
    expect(JSON.parse(result.output)).toMatchObject({ name: "browser", status: "connected" })
    expect(asked).toBe(true)
    expect(state.connects).toEqual(["browser"])
  })

  test("executes MCP discovery despite a stored legacy execute deny", async () => {
    const { tool, state } = await build({
      sessionPermission: [{ permission: "execute", pattern: "*", action: "deny" }],
    })
    const result = await execute(tool, "return await tools.$mcp.servers({})")

    expect(JSON.parse(result.output)).toEqual([{ name: "browser", status: "disabled" }])
    expect(state.hooks.map((hook) => hook.name)).toEqual(["tool.execute.before", "tool.execute.after"])
    expect(state.connects).toEqual([])
  })

  test("disconnects explicitly and treats an already absent connection as a no-op", async () => {
    const state = makeState({ browser: { status: "connected" } })
    const { tool } = await build({ state })
    const ctx = context()

    const disconnected = await execute(tool, "return await tools.$mcp.disconnect({ server: 'browser' })", ctx)
    expect(JSON.parse(disconnected.output)).toMatchObject({
      name: "browser",
      status: "disabled",
      message: "Disconnected.",
    })
    const absent = await execute(tool, "return await tools.$mcp.disconnect({ server: 'browser' })", ctx)
    expect(JSON.parse(absent.output).message).toBe("Already disconnected.")
    expect(state.disconnects).toEqual(["browser"])
  })

  test("propagates abort while waiting for lifecycle permission", async () => {
    const { tool, state } = await build({})
    const controller = new AbortController()
    const entered = await Effect.runPromise(Deferred.make<void>())
    const ctx = context({
      abort: controller.signal,
      ask: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    })

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* tool
          .execute({ code: "return await tools.$mcp.connect({ server: 'browser' })" }, ctx)
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "connect did not request permission")
        controller.abort()
        return yield* Fiber.join(fiber)
      }),
    )
    expect(exit.output).toBe("Execution cancelled.")
    expect(state.connects).toEqual([])
  })
})
