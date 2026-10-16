import { LSP } from "@opencode-ai/schema/lsp"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const LSPGroup = HttpApiGroup.make("server.lsp").add(
  HttpApiEndpoint.get("lsp.status", "/api/lsp", {
    query: LocationQuery,
    success: Location.response(Schema.Array(LSP.Status)),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "lsp.status",
        summary: "Get language server status",
        description: "Observe Location-scoped language server metadata without discovering or starting processes.",
      }),
    ),
)
