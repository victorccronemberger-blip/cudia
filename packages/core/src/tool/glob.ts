export * as GlobTool from "./glob"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description:
      "Directory to search. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Results use canonical paths.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput, limit?: number) => {
  const lines = output.length === 0 ? ["No files found"] : output.map((item) => item.path)
  if (limit !== undefined && output.length >= limit)
    lines.push(`Result limit reached (${limit}). Refine the path or pattern to check for more.`)
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find files by glob pattern. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Results use canonical paths. Use path to narrow the search and limit to bound the result count.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((entry) => ({ ...entry, path: path.resolve(root, entry.path) })),
                input.limit,
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (target.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: target.resource,
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const current = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (current.canonical !== target.canonical)
                return yield* new ToolFailure({ message: "Search target changed during approval. Retry the search." })
              const cwd = current.canonical
              if ((yield* fs.stat(cwd)).type !== "Directory")
                return yield* new ToolFailure({ message: `Glob target is not a directory: ${input.path ?? "."}` })
              return yield* ripgrep
                .glob({
                  cwd,
                  pattern: input.pattern,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((entry) =>
                      FileSystem.Entry.make({
                        ...entry,
                        path: RelativePath.make(path.relative(root, path.resolve(cwd, entry.path))),
                      }),
                    ),
                  ),
                )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: `Unable to find files matching ${input.pattern} in ${input.path ?? "."}`,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, Ripgrep.node, FSUtil.node, Location.node, LocationMutation.node, PermissionV2.node],
})
