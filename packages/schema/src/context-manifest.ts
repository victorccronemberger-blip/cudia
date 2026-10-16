export * as ContextManifestSchema from "./context-manifest"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

/** Content provenance spans use absolute, half-open UTF-16 offsets in the exact manifest text. */
export interface Origin extends Schema.Schema.Type<typeof Origin> {}
export const Origin = Schema.Struct({
  kind: Schema.Literals(["file", "skill", "reference", "runtime", "unknown"]),
  id: Schema.NonEmptyString,
  start: NonNegativeInt,
  end: NonNegativeInt,
  // These describe observed input content, which can differ from its rendered representation.
  sha256: Hash.pipe(optional),
  bytes: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "ContextManifest.Origin" })

/** Producer framing includes join separators; origins identify only explicitly observed content. */
export interface Part extends Schema.Schema.Type<typeof Part> {}
export const Part = Schema.Struct({
  producer: Schema.NonEmptyString,
  phase: Schema.Literals(["baseline", "update", "removed"]),
  start: NonNegativeInt,
  end: NonNegativeInt,
  origins: Schema.Array(Origin),
}).annotate({ identifier: "ContextManifest.Part" })

export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  hashEncoding: Schema.Literal("json-utf8"),
  length: NonNegativeInt,
  bytes: NonNegativeInt,
  sha256: Hash,
  parts: Schema.Array(Part),
}).annotate({ identifier: "ContextManifest.Manifest" })
