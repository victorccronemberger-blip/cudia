export * as ToolContextSource from "./tool-context-source"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

const Digest = { bytes: NonNegativeInt, sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }

export const Body = Schema.Union([
  Schema.Struct({ ...Digest, type: Schema.Literal("utf16-span"), start: NonNegativeInt, end: NonNegativeInt }),
  Schema.Struct({ ...Digest, type: Schema.Literal("json-member"), member: Schema.Literal("instructions") }),
]).annotate({ identifier: "Tool.ContextSource.Body" })
export type Body = typeof Body.Type

/** Local observations of loader output; these do not authenticate the source. */
export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  hashEncoding: Schema.Literal("json-utf8"),
  kind: Schema.Literals(["skill", "mcp-guidance", "mcp-resource"]),
  origin: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(1024)),
  output: Schema.Struct({ ...Digest, length: NonNegativeInt }),
  body: Body,
}).annotate({ identifier: "Tool.ContextSource.Receipt" })

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({ contentIndex: NonNegativeInt, receipt: Receipt }).annotate({
  identifier: "Tool.ContextSource.Entry",
})

export interface Bundle extends Schema.Schema.Type<typeof Bundle> {}
export const Bundle = Schema.Struct({
  version: Schema.Literal(1),
  // Indices refer to the producer projection. Replaced output has no established index mapping.
  projection: Schema.Literals(["original", "replaced"]),
  entries: Schema.Array(Entry).check(Schema.isMaxLength(8)),
  omitted: NonNegativeInt,
}).annotate({ identifier: "Tool.ContextSource.Bundle" })
