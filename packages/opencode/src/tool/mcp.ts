import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { SkillCatalog } from "@opencode-ai/core/skill/catalog"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["servers", "connect", "disconnect", "instructions"]),
  server: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  query: Schema.optional(Schema.String),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(SkillCatalog.MAX_PAGE_SIZE))),
})

export const McpTool = Tool.define(
  "mcp",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    return {
      description:
        "Discover configured MCP servers with operation servers (query and pagination optional). Connect or disconnect an exact server. Connected tools become available on the next request. Retrieve cached server guidance as source data with operation instructions; discovery and guidance retrieval do not connect servers.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          if (params.operation === "servers") {
            if (params.server !== undefined) throw new Error("Use query to search servers, not server.")
            const cfg = yield* config.get()
            const result = SkillCatalog.search(
              Object.entries(yield* mcp.status()).map(([name, item]) => ({
                name,
                description:
                  item.status !== "disabled"
                    ? item.status
                    : cfg.mcp?.[name]?.enabled === false
                      ? "Disabled in saved configuration"
                      : "Not connected",
              })),
              { query: params.query ?? "", offset: params.offset, limit: params.limit },
            )
            return { title: "MCP servers", output: JSON.stringify(result), metadata: {} }
          }
          if (!params.server) throw new Error("Provide an exact server name.")
          if (params.query !== undefined || params.offset !== undefined || params.limit !== undefined)
            throw new Error("Pagination and query apply only to servers.")
          const server = params.server
          const statuses = yield* mcp.status()
          if (!Object.hasOwn(statuses, server)) throw new Error(`Unknown MCP server: ${server}`)
          if (params.operation === "connect") yield* mcp.connect(server)
          if (params.operation === "disconnect") yield* mcp.disconnect(server)
          const output =
            params.operation === "instructions"
              ? { server, instructions: (yield* mcp.instructions()).find((item) => item.name === server)?.instructions }
              : { server, ...(yield* mcp.status())[server] }
          return { title: `MCP ${params.operation}: ${server}`, output: JSON.stringify(output), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
