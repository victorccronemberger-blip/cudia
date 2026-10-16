import { MCP } from "@opencode-ai/schema/mcp"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, MCPServerNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const MCPGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.list", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Array(MCP.Server)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.list",
          summary: "List MCP servers",
          description: "Retrieve MCP server connection status and aggregate tool exposure counts.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:server/connect", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: [InvalidRequestError, MCPServerNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.connect",
          summary: "Connect MCP server",
          description: "Connect a configured MCP server for the selected location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:server/disconnect", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: [InvalidRequestError, MCPServerNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.disconnect",
          summary: "Disconnect MCP server",
          description: "Disconnect a configured MCP server for the selected location.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "MCP", description: "Location-scoped MCP connection administration." }))
