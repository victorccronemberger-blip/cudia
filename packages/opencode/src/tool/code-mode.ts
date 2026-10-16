import * as Tool from "./tool"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = "Run a confined orchestration script with access to connected MCP tools."

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  toolCalls: CallEntry[]
  error?: boolean
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type CatalogEntry = {
  path: string
  key: string
  server: string
  local: string
  tool: MCP.McpTool
}

type ServerSummary = { name: string; status: string }
type Lifecycle = {
  servers: () => Effect.Effect<readonly ServerSummary[], unknown>
  run: (action: "connect" | "disconnect", input: unknown) => Effect.Effect<unknown, unknown>
}

function groupByServer(mcpTools: Record<string, MCP.McpTool>, servers: readonly string[]): Map<string, CatalogEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server =
      byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    const entry: CatalogEntry = {
      path: `${server}.${local}`,
      key,
      server,
      local,
      tool: mcpTools[key]!,
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

export function describeCatalog(
  mcpTools: Record<string, MCP.McpTool>,
  servers: readonly string[],
  instructions: readonly MCP.ServerInstructions[] = [],
  lifecycleServers: readonly ServerSummary[] = [],
): string {
  return (
    CodeMode.make({
      discovery: { catalogBudget: 0 },
      tools: toolTree(
        [...groupByServer(mcpTools, servers).values()].flat(),
        () => () => Effect.fail(toolError("Tool preview is not executable.")),
        instructions,
        lifecycleServers.length > 0
          ? {
              servers: () => Effect.fail(toolError("Tool preview is not executable.")),
              run: (_action, _input) => Effect.fail(toolError("Tool preview is not executable.")),
            }
          : undefined,
      ),
    }).instructions() +
    "\nUse $codemode.search to discover connected tools. Use $mcp.servers to inspect configured server status, and connect or disconnect only by exact configured name. Newly connected tools appear in the next execute call. Read $mcp.instructions for cached server guidance when available."
  )
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

function projectMcpResult(result: CallToolResult, collect: (attachment: Attachment) => void): unknown {
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (attachment: Attachment) => {
    files += 1
    if (attachment.mime.startsWith("image/")) images += 1
    collect(attachment)
  }
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        push({ type: "file", mime: block.mimeType, url: dataUrl(block.mimeType, block.data) })
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        push({ type: "file", mime, url: dataUrl(mime, block.resource.blob), filename: lastSegment(block.resource.uri) })
        break
      }
      case "resource_link":
        // A link is a reference, not fetchable media; hand it to the program instead of the attachment channel.
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }

  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) {
    const noun = files === images ? "image" : "file"
    return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
  }
  return null
}

type Run = (input: unknown) => Effect.Effect<unknown, unknown>

function toolTree(
  catalog: readonly CatalogEntry[],
  run: (entry: CatalogEntry) => Run,
  instructions: readonly MCP.ServerInstructions[] = [],
  lifecycle?: Lifecycle,
) {
  const tree: Record<string, Record<string, SandboxTool.Definition>> = Object.create(null)
  for (const entry of catalog) {
    const namespace: Record<string, SandboxTool.Definition> = (tree[entry.server] ??= Object.create(null))
    namespace[entry.local] = SandboxTool.make({
      description: entry.tool.def.description ?? "",
      input: entry.tool.def.inputSchema as SandboxTool.JsonSchema,
      output: entry.tool.def.outputSchema as SandboxTool.JsonSchema | undefined,
      run: run(entry),
    })
  }
  if (instructions.length > 0 || lifecycle) {
    const namespace: Record<string, SandboxTool.Definition> = (tree.$mcp ??= Object.create(null))
    if (lifecycle) {
      namespace.servers = SandboxTool.make({
        description: "List configured MCP servers and their lifecycle status. This only shows name and status.",
        input: Schema.Struct({}),
        output: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
        run: () => lifecycle.servers(),
      })
      namespace.connect = SandboxTool.make({
        description: "Connect one exact configured MCP server. Its tools are available in the next execute call.",
        input: Schema.Struct({ server: Schema.String.annotate({ description: "Exact configured MCP server name" }) }),
        run: (input) => lifecycle.run("connect", input),
      })
      namespace.disconnect = SandboxTool.make({
        description: "Disconnect one exact configured MCP server.",
        input: Schema.Struct({ server: Schema.String.annotate({ description: "Exact configured MCP server name" }) }),
        run: (input) => lifecycle.run("disconnect", input),
      })
    }
    if (instructions.length > 0) {
      namespace.instructions = SandboxTool.make({
        description: "Read cached guidance for one connected MCP server without calling that server.",
        input: Schema.Struct({ server: Schema.String.annotate({ description: "Exact connected MCP server name" }) }),
        output: Schema.String,
        run: (input) => {
          const item = instructions.find((item) => item.name === input.server)
          return item
            ? Effect.succeed(item.instructions)
            : Effect.fail(toolError(`No available MCP instructions for server ${input.server}`))
        },
      })
    }
  }
  return tree
}

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* (input: {
  plugin: Plugin.Interface
  entry: CatalogEntry
  args: Record<string, unknown>
  callID: string
  ctx: Tool.Context
}) {
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  const result: CallToolResult = yield* Effect.gen(function* () {
    yield* input.ctx.ask({ permission: input.entry.key, metadata: {}, patterns: ["*"], always: ["*"] })
    // Deliberately mirrors McpCatalog.convertTool's transport call so the MCP service stays free of tool-loop concerns.
    return yield* Effect.promise(async () => {
      const raw = await input.entry.tool.client.callTool(
        { name: input.entry.tool.def.name, arguments: input.args },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal: input.ctx.abort,
          timeout: input.entry.tool.timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (raw.isError)
        throw new Error(
          raw.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      return raw
    })
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: [], error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        if (Permission.disabled([CODE_MODE_TOOL], ruleset).has(CODE_MODE_TOOL)) {
          return yield* Effect.fail(toolError("Code Mode execution is denied by the effective permission rules."))
        }
        const mcpTools = Permission.visibleTools(yield* mcp.tools(), ruleset)
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize)
        const catalog = [...groupByServer(mcpTools, servers).values()].flat()

        let childCalls = 0
        const nextCallID = (name: string) => `${ctx.callID ?? name}/${childCalls}`

        const calls: CallEntry[] = []
        const attachments: Attachment[] = []
        const publish = () =>
          ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })

        const callTool = (entry: CatalogEntry) => (input: unknown) =>
          Effect.gen(function* () {
            childCalls += 1
            const result = yield* invokeChildTool({
              plugin,
              entry,
              args: (input ?? {}) as Record<string, unknown>,
              callID: `${ctx.callID ?? entry.key}/${childCalls}`,
              ctx,
            })
            return projectMcpResult(result, (attachment: Attachment) => void attachments.push(attachment))
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              const error = Cause.squash(cause)
              return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
            }),
          )

        const lifecycle: Lifecycle = {
          servers: () =>
            Effect.gen(function* () {
              childCalls += 1
              const callID = nextCallID("$mcp.servers")
              const before = yield* plugin.trigger(
                "tool.execute.before",
                { tool: "$mcp.servers", sessionID: ctx.sessionID, callID },
                { args: {} as Record<string, unknown> },
              )
              void before
              if (Permission.evaluate("mcp.servers", "*", ruleset).action === "deny") {
                return yield* Effect.fail(toolError("Permission denied for mcp.servers"))
              }
              yield* ctx.ask({ permission: "mcp.servers", metadata: {}, patterns: ["*"], always: ["*"] })
              const result = Object.entries(yield* mcp.status()).map(([name, status]) => ({
                name,
                status: status.status,
              }))
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: "$mcp.servers", sessionID: ctx.sessionID, callID, args: {} },
                result,
              )
              return result
            }).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                const error = Cause.squash(cause)
                return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
              }),
            ),
          run: (action, input) =>
            Effect.gen(function* () {
              childCalls += 1
              const tool = `$mcp.${action}`
              const callID = nextCallID(tool)
              const before = yield* plugin.trigger(
                "tool.execute.before",
                { tool, sessionID: ctx.sessionID, callID },
                { args: (input ?? {}) as Record<string, unknown> },
              )
              const server = before.args?.server
              if (typeof server !== "string" || server.length === 0) {
                return yield* Effect.fail(toolError("MCP server name must be a non-empty exact configured name."))
              }

              const permission = `mcp.${action}`
              if (Permission.evaluate(permission, server, ruleset).action === "deny") {
                return yield* Effect.fail(toolError(`Permission denied for ${permission}: ${server}`))
              }
              const statuses = yield* mcp.status()
              if (!Object.hasOwn(statuses, server)) {
                return yield* Effect.fail(toolError(`Unknown configured MCP server: ${server}`))
              }
              yield* ctx.ask({ permission, metadata: { server }, patterns: [server], always: [server] })

              let result: { name: string; status: string; message: string }
              if (action === "connect") {
                if (statuses[server]!.status === "connected") {
                  result = { name: server, status: "connected", message: "Already connected." }
                } else {
                  yield* mcp.connect(server)
                  const status = (yield* mcp.status())[server]?.status ?? "unknown"
                  result = {
                    name: server,
                    status,
                    message: "Connection requested. Newly available tools appear in the next execute call.",
                  }
                }
              } else if (statuses[server]!.status !== "connected") {
                result = { name: server, status: statuses[server]!.status, message: "Already disconnected." }
              } else {
                yield* mcp.disconnect(server)
                const status = (yield* mcp.status())[server]?.status ?? "unknown"
                result = { name: server, status, message: "Disconnected." }
              }

              yield* plugin.trigger(
                "tool.execute.after",
                { tool, sessionID: ctx.sessionID, callID, args: before.args },
                result,
              )
              return result
            }).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                const error = Cause.squash(cause)
                return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
              }),
            ),
        }

        const runtime = CodeMode.make({
          discovery: { catalogBudget: 0 },
          tools: toolTree(
            catalog,
            callTool,
            instructions,
            Object.keys(yield* mcp.status()).length ? lifecycle : undefined,
          ),
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = (() => {
                if (input === null || input === undefined) return
                if (typeof input === "object" && !Array.isArray(input)) {
                  const value = input as Record<string, unknown>
                  return Object.keys(value).length > 0 ? value : undefined
                }
                return { input }
              })()
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
        })

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })
        const cancelled = (): CodeMode.Result => ({
          ok: false,
          error: { kind: "ExecutionFailure", message: "Execution cancelled." },
          toolCalls: calls.map((call) => ({ name: call.tool })),
        })

        const result = yield* Effect.raceFirst(runtime.execute(params.code), abort.pipe(Effect.map(cancelled)))
        const logs = result.logs ?? []
        const withLogs = (text: string) => {
          if (logs.length === 0) return text
          return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
        }

        if (!result.ok) {
          if (ctx.abort.aborted) {
            return {
              title: CODE_MODE_TOOL,
              metadata: { toolCalls: calls, error: true },
              output: "Execution cancelled.",
            } satisfies Tool.ExecuteResult<Metadata>
          }
          const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
          return yield* Effect.fail(new Error(withLogs([result.error.message, ...hints].join("\n"))))
        }

        // The interpreter validates returned values as plain JSON, so stringify cannot throw;
        // it yields undefined only for a program that returns undefined.
        const output =
          typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value, null, 2) ?? String(result.value))

        return {
          title: CODE_MODE_TOOL,
          metadata: { toolCalls: calls },
          output: withLogs(output),
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)
