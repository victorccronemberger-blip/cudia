export * as LSPTool from "./lsp"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { LSPV2 } from "../lsp"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "lsp"

export const Input = Schema.Struct({
  operation: Schema.Literals([...LSPV2.operations, "diagnostics"] as const),
  filePath: Schema.String.annotate({ description: "File path, absolute or relative to the active location" }),
  line: PositiveInt.annotate({ description: "1-based line" }),
  character: PositiveInt.annotate({ description: "1-based UTF-16 character offset" }),
  query: Schema.optional(Schema.String.annotate({ description: "workspaceSymbol search query" })),
})

export const Output = Schema.Struct({ server: Schema.String, result: Schema.Unknown, omitted: Schema.Number })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const setting = Config.latest(yield* config.entries(), "lsp")
    if (setting === undefined || setting === false) return
    if (typeof setting === "object" && !Object.values(setting).some((server) => !server.disabled)) return
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const mutation = yield* LocationMutation.Service
    const lsp = yield* LSPV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Query code definitions, references, hover, symbols, implementations, call hierarchy or diagnostics. Starts a configured, installed language server on demand with the active project's server configuration. Positions are 1-based UTF-16. Diagnostic freshness is reported explicitly. Responses retain their server origin. This query interface does not implement edits or server commands.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* mutation.resolve({ path: input.filePath, kind: "file" })
              const before = yield* fs.stat(target.canonical)
              if (before.type !== "File")
                return yield* new ToolFailure({ message: `LSP target is not a regular file: ${input.filePath}` })
              yield* permission.assert({
                action: name,
                resources:
                  input.operation === "workspaceSymbol" ? [...new Set([target.resource, "."])] : [target.resource],
                save: ["*"],
                metadata: {
                  operation: input.operation,
                  filePath: target.resource,
                  scope: input.operation === "workspaceSymbol" ? "workspace" : "document",
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const current = yield* mutation.resolve({ path: input.filePath, kind: "file" })
              if (current.canonical !== target.canonical)
                return yield* new ToolFailure({
                  message: "LSP target changed while checking the query. Retry the query.",
                })
              if ((yield* fs.stat(current.canonical)).type !== "File")
                return yield* new ToolFailure({
                  message: "LSP target changed while checking the query. Retry the query.",
                })
              if (input.operation === "diagnostics") {
                const report = yield* lsp.diagnostics({ filePath: current.canonical })
                return { server: report.server, result: report, omitted: report.omitted }
              }
              return yield* lsp.query({
                ...input,
                operation: input.operation,
                filePath: current.canonical,
                line: input.line - 1,
                character: input.character - 1,
              })
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message:
                        error instanceof LSPV2.Failure
                          ? error.message
                          : `Unable to query ${input.operation} for ${input.filePath}`,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lsp",
  layer,
  deps: [Config.node, ToolRegistry.node, FSUtil.node, LocationMutation.node, LSPV2.node, PermissionV2.node],
})
