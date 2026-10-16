export * as ToolResultTool from "./tool-result"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { ToolOutputStore } from "../tool-output-store"
import { TextPage } from "../util/text-page"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "tool_result"
export const Input = Schema.Struct({
  callID: Schema.String.check(Schema.isMinLength(1)),
  messageID: Schema.optional(SessionMessage.ID),
  source: Schema.optional(Schema.Literals(["text", "structured", "content"])),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(TextPage.MAX_UNITS))),
  outputHash: Schema.optional(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/))),
})

const Output = Schema.Struct({
  messageID: SessionMessage.ID,
  callID: Schema.String,
  source: Schema.Literals(["text", "structured", "content"]),
  text: Schema.String,
  offset: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
  complete: Schema.Boolean,
  totalLength: NonNegativeInt,
  outputHash: Schema.String,
  offsetUnit: Schema.Literal("utf16_code_units"),
  contentTextBounded: Schema.Boolean,
  captureTruncated: Schema.NullOr(Schema.Boolean),
  attachmentCount: NonNegativeInt,
})

export const description =
  "Page a completed tool result from this session without rerunning it. Use its callID; add messageID from a retention marker if available. text reads the full retained projection, structured serializes stored structured data, content serializes persisted content (its text may be bounded). Offsets count UTF-16 units; pass outputHash on every nonzero offset."

/** Select availability from the history already loaded for the provider turn. */
export function available(messages: ReadonlyArray<SessionMessage.Message>) {
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          part.time.pruned === undefined &&
          ((part.state.outputPaths?.length ?? 0) > 0 ||
            part.state.content.some((item) => item.type === "file" || item.text.length > 0) ||
            Object.keys(part.state.structured).length > 0),
      ),
  )
}

const failure = (message: string) => new ToolFailure({ message })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const store = yield* SessionStore.Service
    const outputStore = yield* ToolOutputStore.Service
    const location = yield* Location.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      error instanceof PermissionV2.CorrectedError ? error.feedback : "Tool result access denied",
                    ),
                  ),
                )
              const offset = input.offset ?? 0
              const limit = input.limit ?? TextPage.MAX_UNITS
              const source = input.source ?? "text"
              if (offset > 0 && input.outputHash === undefined)
                return yield* failure("outputHash is required for every nonzero offset")

              const resolve = Effect.fn("ToolResultTool.resolve")(function* () {
                const session = yield* store.get(context.sessionID)
                if (
                  !session ||
                  session.location.directory !== location.directory ||
                  session.location.workspaceID !== location.workspaceID
                )
                  return yield* failure("Tool result session is unavailable at this location")
                const messages = input.messageID
                  ? yield* store
                      .message(input.messageID)
                      .pipe(
                        Effect.flatMap((entry) =>
                          entry?.sessionID === context.sessionID
                            ? Effect.succeed([entry.message])
                            : Effect.fail(failure("Tool result does not belong to this session")),
                        ),
                      )
                  : yield* store
                      .toolMessages(context.sessionID, input.callID)
                      .pipe(Effect.mapError(() => failure("Tool result history is unavailable")))
                const matches = messages.flatMap((message) =>
                  message.type !== "assistant"
                    ? []
                    : message.content.flatMap((part) =>
                        part.type === "tool" && part.id === input.callID ? [{ messageID: message.id, part }] : [],
                      ),
                )
                if (matches.length !== 1)
                  return yield* failure(
                    matches.length === 0 ? "Tool result was not found" : "Ambiguous callID; supply its messageID",
                  )
                const match = matches[0]!
                if (match.part.state.status !== "completed" || match.part.time.pruned !== undefined)
                  return yield* failure("Tool result is incomplete or was pruned")
                const state = match.part.state
                const retained = (state.outputPaths?.length ?? 0) > 0
                const captureTruncated =
                  match.part.name === "bash" && typeof state.structured.truncated === "boolean"
                    ? state.structured.truncated
                    : null
                const text =
                  source === "structured"
                    ? JSON.stringify(state.structured)
                    : source === "content"
                      ? JSON.stringify(state.content)
                      : retained
                        ? undefined
                        : state.content.length === 0
                          ? JSON.stringify(state.structured, null, 2)
                          : state.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
                const descriptor = TextPage.hash(
                  JSON.stringify({
                    messageID: match.messageID,
                    name: match.part.name,
                    source,
                    text,
                    paths: source === "text" ? state.outputPaths : undefined,
                    retained,
                    captureTruncated,
                    mediaCount: state.content.filter((part) => part.type === "file").length,
                    attachments: state.attachments,
                  }),
                )
                return { messageID: match.messageID, state, retained, text, descriptor, captureTruncated }
              })
              const selected = yield* resolve()
              const snapshot =
                selected.text === undefined
                  ? yield* outputStore
                      .page({
                        sessionID: context.sessionID,
                        assistantMessageID: selected.messageID,
                        toolCallID: input.callID,
                        outputPaths: selected.state.outputPaths ?? [],
                        offset,
                        limit,
                      })
                      .pipe(Effect.mapError((error) => failure(error.message)))
                  : {
                      text: selected.text,
                      start: 0,
                      totalLength: selected.text.length,
                      contentHash: TextPage.hash(selected.text),
                    }
              const outputHash = TextPage.hash(JSON.stringify([source, snapshot.contentHash]))
              if (input.outputHash !== undefined && input.outputHash !== outputHash)
                return yield* failure("Tool result changed or outputHash belongs to a different source")
              if (offset > snapshot.totalLength) return yield* failure("offset exceeds the selected result")
              const limits = yield* outputStore.limits()
              if (limits.maxLines < 1) return yield* failure("Tool output line budget cannot fit a page")
              const local = offset - snapshot.start
              const base = {
                messageID: selected.messageID,
                callID: input.callID,
                source,
                offset,
                totalLength: snapshot.totalLength,
                outputHash,
                offsetUnit: "utf16_code_units" as const,
                contentTextBounded: selected.retained,
                captureTruncated: selected.captureTruncated,
                attachmentCount:
                  selected.state.content.filter((part) => part.type === "file").length +
                  (selected.state.attachments?.length ?? 0),
              }
              const page = (end: number) => ({
                ...base,
                text: snapshot.text.slice(local, end),
                nextOffset: snapshot.start + end < snapshot.totalLength ? snapshot.start + end : null,
                complete: snapshot.start + end >= snapshot.totalLength,
              })
              const formatted = TextPage.format(
                snapshot.text,
                { offset: local, limit, maxBytes: Math.min(TextPage.MAX_BYTES, limits.maxBytes) },
                (end) => JSON.stringify(page(end)),
              )
              if (!formatted.ok) return yield* failure(`Cannot page tool result: ${formatted.error}`)
              if ((yield* resolve()).descriptor !== selected.descriptor)
                return yield* failure("Tool result changed while it was being read")
              return page(formatted.end)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/tool-result",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionStore.node, ToolOutputStore.node, Location.node],
})
