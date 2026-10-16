export * as MCPError from "./error"

import { Schema } from "effect"

/** Public failures contain bounded operational facts, never transport diagnostics or secrets. */
export class Failure extends Schema.TaggedErrorClass<Failure>()("MCP.Failure", {
  kind: Schema.Literals([
    "not_configured",
    "disconnected",
    "stale",
    "unavailable",
    "startup",
    "request",
    "timeout",
    "authentication_required",
    "invalid_schema",
    "budget",
    "catalog",
  ]),
  message: Schema.String,
}) {}
