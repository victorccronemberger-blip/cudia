import { Vcs } from "@opencode-ai/core/vcs"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { VcsOutputLimitError } from "@opencode-ai/protocol/groups/vcs"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const VcsHandler = HttpApiBuilder.group(Api, "server.vcs", (handlers) =>
  Effect.succeed(
    handlers
      .handle("vcs.get", () => Vcs.Service.use((vcs) => response(vcs.info().pipe(Effect.mapError(mapFailure)))))
      .handle("vcs.status", () => Vcs.Service.use((vcs) => response(vcs.status().pipe(Effect.mapError(mapFailure)))))
      .handle("vcs.diff", (ctx) =>
        Vcs.Service.use((vcs) =>
          response(vcs.diff(ctx.query.mode, { context: ctx.query.context }).pipe(Effect.mapError(mapFailure))),
        ),
      ),
  ),
)

function mapFailure(error: Vcs.OperationError) {
  if (error.reason === "output_limit")
    return new VcsOutputLimitError({ operation: error.operation, message: error.message, limit: error.limit })
  if (error.reason === "invalid_input") return new InvalidRequestError({ message: error.message, kind: "vcs" })
  if (error.reason === "unavailable") return new ServiceUnavailableError({ message: error.message, service: "vcs" })
  return error
}
