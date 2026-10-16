export * as LSP from "./lsp"

import { Schema } from "effect"
import { optional } from "./schema"

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["not_started", "starting", "connected", "error", "missing", "disabled"]),
  failure: Schema.String.pipe(optional),
  diagnosticMode: Schema.Literals(["pull", "push", "none"]).pipe(optional),
}).annotate({ identifier: "LSP.Status" })
export type Status = typeof Status.Type
