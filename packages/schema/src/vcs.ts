export * as Vcs from "./vcs"

import { Schema } from "effect"
import { NonNegativeInt, RelativePath, optional } from "./schema"

export const Mode = Schema.Literals(["working", "branch"]).annotate({ identifier: "Vcs.Mode" })
export type Mode = typeof Mode.Type

export const Context = NonNegativeInt.check(Schema.isLessThanOrEqualTo(2_147_483_647)).annotate({
  identifier: "Vcs.Context",
})

export const FileStatus = Schema.Struct({
  file: RelativePath,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "Vcs.FileStatus" })
export interface FileStatus extends Schema.Schema.Type<typeof FileStatus> {}

export const FileDiff = Schema.Struct({ ...FileStatus.fields, patch: Schema.String }).annotate({
  identifier: "Vcs.FileDiff",
})
export interface FileDiff extends Schema.Schema.Type<typeof FileDiff> {}

export const Info = Schema.Struct({
  branch: Schema.String.pipe(optional),
  defaultBranch: Schema.String.pipe(optional),
}).annotate({ identifier: "Vcs.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("VcsOperationError", {
  reason: Schema.Literals(["command", "output_limit", "invalid_input", "unavailable"]),
  operation: Schema.String,
  message: Schema.String,
  limit: Schema.Number.pipe(optional),
}) {}
