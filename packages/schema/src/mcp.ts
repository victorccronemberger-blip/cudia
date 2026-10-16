export * as MCP from "./mcp"

import { Schema } from "effect"
import { Integration } from "./integration"
import { NonNegativeInt, optional } from "./schema"

export const Status = Schema.Literals([
  "disabled",
  "disconnected",
  "connecting",
  "connected",
  "failed",
  "authentication_required",
]).annotate({ identifier: "MCP.Status" })
export type Status = typeof Status.Type

export interface Authentication extends Schema.Schema.Type<typeof Authentication> {}
export const Authentication = Schema.Struct({
  integrationID: Integration.ID,
  methodID: Integration.MethodID,
}).annotate({ identifier: "MCP.Authentication" })

export interface Failure extends Schema.Schema.Type<typeof Failure> {}
export const Failure = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "MCP.Failure" })

export interface Server extends Schema.Schema.Type<typeof Server> {}
export const Server = Schema.Struct({
  name: Schema.String,
  status: Status,
  toolCount: NonNegativeInt,
  exposureCount: NonNegativeInt,
  authentication: optional(Authentication),
  error: optional(Failure),
}).annotate({ identifier: "MCP.Server" })
