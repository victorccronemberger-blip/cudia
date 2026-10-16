export * as LSPError from "./error"

import { Schema } from "effect"

export class Failure extends Schema.TaggedErrorClass<Failure>()("LSPV2.Failure", {
  kind: Schema.Literals([
    "disabled",
    "unavailable",
    "configuration",
    "path",
    "document",
    "budget",
    "unsupported",
    "protocol",
    "startup",
    "timeout",
    "request",
    "closed",
  ]),
  message: Schema.String,
}) {}
