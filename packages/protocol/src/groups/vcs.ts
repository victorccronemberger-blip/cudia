import { Vcs } from "@opencode-ai/schema/vcs"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export class VcsOutputLimitError extends Schema.TaggedErrorClass<VcsOutputLimitError>()(
  "VcsOutputLimitError",
  { operation: Schema.String, message: Schema.String, limit: Schema.optional(Schema.Number) },
  { httpApiStatus: 413 },
) {}

const errors = [
  Vcs.OperationError.annotate({ httpApiStatus: 500 }),
  VcsOutputLimitError,
  InvalidRequestError,
  ServiceUnavailableError,
] as const

export const VcsGroup = HttpApiGroup.make("server.vcs")
  .add(
    HttpApiEndpoint.get("vcs.get", "/api/vcs", {
      query: LocationQuery,
      success: Location.response(Vcs.Info),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.vcs.get", summary: "Read repository information" })),
  )
  .add(
    HttpApiEndpoint.get("vcs.status", "/api/vcs/status", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Vcs.FileStatus)),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.vcs.status", summary: "Read working changes" })),
  )
  .add(
    HttpApiEndpoint.get("vcs.diff", "/api/vcs/diff", {
      query: Schema.Struct({
        ...LocationQuery.fields,
        mode: Vcs.Mode,
        context: Schema.NumberFromString.pipe(Schema.decodeTo(Vcs.Context), Schema.optional),
      }),
      success: Location.response(Schema.Array(Vcs.FileDiff)),
      error: errors,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.vcs.diff", summary: "Read repository differences" })),
  )
  .annotateMerge(OpenApi.annotations({ title: "vcs", description: "Location-scoped read-only Git routes." }))
