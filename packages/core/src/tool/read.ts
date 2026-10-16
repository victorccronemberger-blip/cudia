export * as ReadTool from "./read"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { FSUtil } from "../fs-util"
import { ToolOutputStore } from "../tool-output-store"
import { BoundedFile } from "../util/bounded-file"
import { OutputBudget } from "../util/output-budget"
import { ReadToolFileSystem } from "./read-filesystem"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const LocationInput = Schema.Struct({
  path: Schema.String,
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
  snapshot: ReadToolFileSystem.PageInput.fields.snapshot.annotate({
    description: "Required with a directory offset beyond 1; use the previous page's snapshot",
  }),
  textPage: Schema.optional(ReadToolFileSystem.ExactInput).annotate({
    description:
      "Exact current file text in UTF-16 units, including long lines. Start with {}; continue with nextOffset and contentHash. Do not combine with line offset/limit or a directory snapshot.",
  }),
})
const Input = LocationInput
const Output = Schema.Union([
  FileSystem.Content,
  ReadToolFileSystem.TextPage,
  ReadToolFileSystem.ExactPage,
  ReadToolFileSystem.ListPage,
])

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service
    const outputStore = yield* ToolOutputStore.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Read a text file or supported image, or page directory entries. Line pages may abbreviate long lines; textPage reads exact current text with hash-checked UTF-16 offsets. Directory continuation requires its snapshot. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Resolved targets use canonical paths.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => {
            if (!("encoding" in output) || output.encoding !== "base64" || !SUPPORTED_IMAGE_MIMES.has(output.mime))
              return [{ type: "text", text: JSON.stringify(output) }]
            return [
              { type: "text", text: "Image read successfully" },
              { type: "file", data: output.content, mime: output.mime, name: input.path },
            ]
          },
          execute: (input, context) => {
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path, kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const resource = target.resource
              const absolute = AbsolutePath.make(target.canonical)
              const type = yield* reader.inspect(absolute)
              yield* permission.assert({
                action: name,
                resources: [resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const budget = OutputBudget.resolve(yield* outputStore.limits(), ReadToolFileSystem.DEFAULT_BUDGET)
              if (budget.maxLines < 1 || budget.maxBytes < 1) return yield* new ReadToolFileSystem.BudgetError()
              if (
                input.textPage &&
                (input.offset !== undefined || input.limit !== undefined || input.snapshot !== undefined)
              )
                return yield* new ReadToolFileSystem.TextPageError({
                  reason: "do not combine exact and line/directory paging",
                })
              if (type === "directory") {
                if (input.textPage)
                  return yield* new ReadToolFileSystem.TextPageError({ reason: "text pages require a text file" })
                return yield* reader.list(
                  absolute,
                  { offset: input.offset, limit: input.limit, snapshot: input.snapshot },
                  budget,
                )
              }
              if (input.textPage) return yield* reader.exact(absolute, resource, input.textPage, budget)
              const content = yield* reader.read(
                absolute,
                resource,
                {
                  offset: input.offset,
                  limit: input.limit,
                  snapshot: input.snapshot,
                },
                budget,
              )
              if ("encoding" in content && content.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(content.mime)) {
                if (!OutputBudget.fits("Image read successfully", budget))
                  return yield* new ReadToolFileSystem.BudgetError()
                return yield* image
                  .normalize(resource, { ...content, encoding: "base64" })
                  .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
              }
              if ("encoding" in content && content.encoding === "base64")
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource }))
              return content
            }).pipe(
              Effect.mapError((error) => {
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof ReadToolFileSystem.MalformedUtf8Error ||
                  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
                  error instanceof ReadToolFileSystem.BudgetError ||
                  error instanceof ReadToolFileSystem.SnapshotError ||
                  error instanceof ReadToolFileSystem.TextPageError ||
                  error instanceof BoundedFile.SourceError ||
                  error instanceof FSUtil.DirectoryLimitError ||
                  error instanceof Image.DecodeError ||
                  error instanceof Image.SizeError
                    ? error.message
                    : `Unable to read ${input.path}`
                return new ToolFailure({ message })
              }),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read",
  layer,
  deps: [
    ToolRegistry.node,
    ReadToolFileSystem.node,
    LocationMutation.node,
    Image.node,
    PermissionV2.node,
    ToolOutputStore.node,
  ],
})
