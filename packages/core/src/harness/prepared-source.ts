export * as PreparedSource from "./prepared-source"

import { Schema } from "effect"

export const Mapping = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("mapped"),
    messageIndex: Schema.Number,
    partIndex: Schema.Number,
    role: Schema.Literals(["assistant", "tool"]),
    resultType: Schema.Literals(["text", "content"]),
    resultContentIndex: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    state: Schema.Literal("unmapped"),
    reason: Schema.Literals([
      "source-mismatch",
      "native-override",
      "unsupported-result",
      "not-observed",
      "ambiguous-occurrence",
      "prepared-value-changed",
      "copy-boundary-changed",
    ]),
  }),
])
export type Mapping = typeof Mapping.Type

/** Metadata-only allowlist; no provider content is copied into historical retention. */
export function copy(value: Mapping): Mapping {
  if (value.state === "unmapped") return { state: value.state, reason: value.reason }
  return {
    state: value.state,
    messageIndex: value.messageIndex,
    partIndex: value.partIndex,
    role: value.role,
    resultType: value.resultType,
    ...(value.resultContentIndex === undefined ? {} : { resultContentIndex: value.resultContentIndex }),
  }
}
