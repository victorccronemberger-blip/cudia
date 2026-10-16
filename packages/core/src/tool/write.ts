/**
 * Model-facing V2 file-write leaf. Paths resolve against the active Location;
 * parent-relative, absolute, and symlink-resolved paths can target elsewhere.
 * Resolved targets use canonical paths.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { LocationMutation } from "../location-mutation"
import { LSPMutation } from "../lsp/mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to write. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Resolved targets use canonical paths.",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
  lsp: LSPMutation.Result.pipe(Schema.optional),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}${LSPMutation.format(output.lsp)}`

/** Deferred V2 write UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const permission = yield* PermissionV2.Service
    const lsp = yield* LSPMutation.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Write content to one file. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Resolved targets use canonical paths.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const result = yield* files.writeTextPreservingBom({ target, content: input.content })
                const report = yield* lsp.after([{ filePath: result.target, kind: "changed" }])
                return { ...result, ...(report ? { lsp: report } : {}) }
              }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to write ${input.path}` }))),
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, PermissionV2.node, LSPMutation.node],
})
