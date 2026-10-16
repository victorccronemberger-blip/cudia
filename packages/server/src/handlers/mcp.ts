import { MCPV2 } from "@opencode-ai/core/mcp"
import { MCPError } from "@opencode-ai/core/mcp/error"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InvalidRequestError, MCPServerNotFoundError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"
import { response } from "../location"

export const MCPHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "mcp.list",
        Effect.fn(function* () {
          const service = yield* MCPV2.Service
          return yield* response(service.admin.list())
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn(function* (ctx) {
          const service = yield* MCPV2.Service
          yield* service.admin
            .connect(ctx.params.server)
            .pipe(Effect.mapError((error) => mapFailure(ctx.params.server, error)))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn(function* (ctx) {
          const service = yield* MCPV2.Service
          yield* service.admin
            .disconnect(ctx.params.server)
            .pipe(Effect.mapError((error) => mapFailure(ctx.params.server, error)))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

function mapFailure(server: string, error: MCPError.Failure) {
  if (error.kind === "not_configured") return new MCPServerNotFoundError({ server, message: error.message })
  return new InvalidRequestError({ message: error.message, kind: `mcp_${error.kind}` })
}
