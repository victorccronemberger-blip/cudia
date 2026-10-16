export * as MCPTool from "./mcp"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"
import { MCPV2 } from "../mcp"
import { MCPError } from "../mcp/error"
import { MCPResourceCatalog } from "../mcp/resource-catalog"
import { ToolProvenance } from "./provenance"
import { ToolSource } from "../harness/tool-source"
import { PermissionV2 } from "../permission"
import { SkillCatalog } from "../skill/catalog"
import { makeLocationNode } from "../effect/app-node"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"

export const name = "mcp"

const Page = {
  query: Schema.String.annotate({ description: "Search metadata; use an empty string to browse" }),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(SkillCatalog.MAX_PAGE_SIZE))),
}
const Server = Schema.String.check(Schema.isMinLength(1))
const Names = Schema.Array(Schema.String.check(Schema.isMinLength(1)))
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(8))
const ResourcePage = { ...Page, snapshot: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/)).pipe(Schema.optional) }

export const Input = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("servers"), ...Page }),
  Schema.Struct({ operation: Schema.Literal("connect"), server: Server }),
  Schema.Struct({ operation: Schema.Literal("disconnect"), server: Server }),
  Schema.Struct({ operation: Schema.Literal("instructions"), server: Server }),
  Schema.Struct({ operation: Schema.Literal("search"), server: Server, ...Page }),
  Schema.Struct({ operation: Schema.Literal("expose"), server: Server, names: Names }),
  Schema.Struct({ operation: Schema.Literal("hide"), server: Server, names: Names }),
  Schema.Struct({ operation: Schema.Literals(["resources", "templates"]), server: Server, ...ResourcePage }),
  Schema.Struct({
    operation: Schema.Literal("read"),
    server: Server,
    uri: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(MCPResourceCatalog.MAX_URI_BYTES)),
  }),
])

export const description =
  "Manage configured MCP servers. Search tool metadata, then expose exact names for this session's next turn; hide removes exposure. Resources/templates search metadata with snapshots for continuation; read fetches one exact resource URI. Instructions retrieves cached guidance from an already connected server as source data, without connecting or making a request. Connect does not read resources. Disconnect closes the shared connection for every session."

function renderResourceContent(content: MCPV2.ResourceResult["contents"][number]) {
  if (!("text" in content)) return { text: JSON.stringify(content) }
  const { text, ...metadata } = content
  const prefix = `${JSON.stringify(metadata)}\n`
  return { text: `${prefix}${text}`, body: { start: prefix.length, end: prefix.length + text.length } }
}

function resourceOutput(server: string, requestedURI: string, result: MCPV2.ResourceResult) {
  const textContents = result.contents.flatMap((content, contentIndex) =>
    "text" in content ? [{ content, contentIndex }] : [],
  )
  const selected = textContents.slice(0, ToolProvenance.MAX_ENTRIES).map(({ content, contentIndex }) => {
    const rendered = renderResourceContent(content)
    const origin = JSON.stringify({ server, requestedURI, uri: content.uri })
    return {
      contentIndex,
      receipt: rendered.body
        ? ToolSource.create({
            kind: "mcp-resource",
            origin,
            output: rendered.text,
            start: rendered.body.start,
            end: rendered.body.end,
          })
        : undefined,
    }
  })
  const output = { ...result, contents: [...result.contents] }
  return ToolProvenance.attach(output, selected, textContents.length - selected.length)
}

const failure = (error: MCPError.Failure | PermissionV2.Error | Error) => {
  if (error instanceof MCPError.Failure) return new ToolFailure({ message: error.message })
  if (error instanceof PermissionV2.CorrectedError) return new ToolFailure({ message: error.feedback })
  if (error instanceof PermissionV2.BlockedError) return new ToolFailure({ message: "MCP operation denied" })
  return new ToolFailure({ message: "MCP operation denied or unavailable" })
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mcp = yield* MCPV2.Service
    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description,
            input: Input,
            output: Schema.Unknown,
            toModelOutput: ({ input, output }) => {
              if (input.operation === "read") {
                const result = output as MCPV2.ResourceResult
                return result.contents.map((content) => ({
                  type: "text" as const,
                  text: renderResourceContent(content).text,
                }))
              }
              return [{ type: "text", text: JSON.stringify(output) ?? "MCP operation completed" }]
            },
            execute: (input, context) =>
              Effect.gen(function* () {
                switch (input.operation) {
                  case "servers":
                    return yield* mcp.servers({ query: input.query, offset: input.offset, limit: input.limit }, context)
                  case "connect":
                    return yield* mcp.connect(input.server, context)
                  case "disconnect":
                    return yield* mcp.disconnect(input.server, context)
                  case "instructions": {
                    const output = yield* mcp.instructions(input.server, context)
                    if (output.instructions === undefined) return output
                    return ToolProvenance.attach({ ...output }, [
                      {
                        contentIndex: 0,
                        receipt: ToolSource.create({
                          kind: "mcp-guidance",
                          origin: input.server,
                          output: JSON.stringify(output),
                        }),
                      },
                    ])
                  }
                  case "search":
                    return yield* mcp.search(
                      input.server,
                      { query: input.query, offset: input.offset, limit: input.limit },
                      context,
                    )
                  case "expose":
                    return yield* mcp.expose(input.server, input.names, context)
                  case "hide":
                    return yield* mcp.hide(input.server, input.names, context)
                  case "resources":
                    return yield* mcp.resources(
                      input.server,
                      { query: input.query, offset: input.offset, limit: input.limit, snapshot: input.snapshot },
                      context,
                    )
                  case "templates":
                    return yield* mcp.templates(
                      input.server,
                      { query: input.query, offset: input.offset, limit: input.limit, snapshot: input.snapshot },
                      context,
                    )
                  case "read":
                    return resourceOutput(input.server, input.uri, yield* mcp.read(input.server, input.uri, context))
                }
              }).pipe(Effect.mapError(failure)),
          }),
          "mcp",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/mcp", layer, deps: [ToolRegistry.node, MCPV2.node] })
