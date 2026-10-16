export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description:
      "File or directory to search. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Results use canonical paths.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description:
      'File glob for directory searches (for example, "*.js" or "*.{ts,tsx}"). An explicit file path is searched regardless of include.',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput, limit?: number) => {
  const lines = output.length === 0 ? ["No files found"] : [`Found ${output.length} matches`]
  let current = ""
  for (const match of output) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (limit !== undefined && output.length >= limit)
    lines.push(`Result limit reached (${limit}). Refine the path or pattern to check for more.`)
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search file contents by regular expression. Paths resolve against the active Location; parent-relative, absolute, and symlink-resolved paths can target elsewhere. Results use canonical paths. Use path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns file resources, line numbers and bounded line previews.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(root, match.entry.path) },
                })),
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
              const before = yield* fs.stat(target.canonical)
              if (before.type !== "File" && before.type !== "Directory")
                return yield* new ToolFailure({
                  message: `Grep target is not a file or directory: ${input.path ?? "."}`,
                })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: target.resource,
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const current = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (current.canonical !== target.canonical)
                return yield* new ToolFailure({ message: "Search target changed during approval. Retry the search." })
              const info = yield* fs.stat(current.canonical)
              if (info.type !== before.type)
                return yield* new ToolFailure({
                  message: "Search target changed during approval. Retry the search.",
                })
              const cwd = info.type === "Directory" ? current.canonical : path.dirname(current.canonical)
              return yield* ripgrep
                .grep({
                  cwd,
                  pattern: input.pattern,
                  file: info.type === "File" ? path.basename(current.canonical) : undefined,
                  include: input.include,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(path.relative(root, path.resolve(cwd, match.entry.path))),
                        }),
                      }),
                    ),
                  ),
                )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message:
                        error instanceof Ripgrep.InvalidPatternError
                          ? error.message
                          : `Unable to grep for ${input.pattern} in ${input.path ?? "."}`,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, Location.node, LocationMutation.node, PermissionV2.node],
})
