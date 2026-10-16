import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { Session } from "../session/session"
import { MessageID, PartID } from "../session/schema"
import { Tool } from "./tool"
import { Truncate } from "./truncate"
import DESCRIPTION from "./tool-result.txt"
import { TextPage } from "../util/text-page"
const NOT_AVAILABLE = "No completed tool result is available for the supplied identifiers."

export const Parameters = Schema.Struct({
  messageID: MessageID,
  partID: PartID,
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(TextPage.MAX_UNITS))),
  outputHash: Schema.optional(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/))),
})

export const ToolResultTool = Tool.define(
  "tool_result",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const truncate = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "tool_result",
            patterns: [
              `message:${Buffer.from(JSON.stringify(params.messageID), "utf8").toString("hex")}`,
              `part:${Buffer.from(JSON.stringify(params.partID), "utf8").toString("hex")}`,
            ],
            always: [
              `message:${Buffer.from(JSON.stringify(params.messageID), "utf8").toString("hex")}`,
              `part:${Buffer.from(JSON.stringify(params.partID), "utf8").toString("hex")}`,
            ],
            metadata: {},
          })

          const part = yield* sessions.getPart({
            sessionID: ctx.sessionID,
            messageID: params.messageID,
            partID: params.partID,
          })
          if (!part || part.type !== "tool" || part.state.status !== "completed")
            return yield* Effect.fail(new Error(NOT_AVAILABLE))

          const state = part.state
          const output = state.output
          const outputHash = TextPage.hash(output)
          const offset = params.offset ?? 0
          const limit = params.limit ?? TextPage.MAX_UNITS
          if (params.outputHash !== undefined && params.outputHash !== outputHash)
            return yield* Effect.fail(new Error("Recorded tool result changed since the previous page."))
          if (offset > 0 && params.outputHash === undefined)
            return yield* Effect.fail(new Error("Pass outputHash from the first page when continuing."))
          const limits = yield* truncate.limits()
          const maxBytes = Math.min(TextPage.MAX_BYTES, limits.maxBytes)
          if (limits.maxLines < 1)
            return yield* Effect.fail(new Error("Recorded tool result envelope exceeds the output limit."))

          const captureTruncated = typeof state.metadata?.truncated === "boolean" ? state.metadata.truncated : null
          const attachmentCount = state.attachments?.length ?? 0
          const makeOutput = (last: number) => {
            const response = {
              text: output.slice(offset, last),
              offset,
              nextOffset: last,
              complete: last >= output.length,
              totalLength: output.length,
              outputHash,
              offsetUnit: "utf16_code_units",
              captureTruncated,
              attachmentCount,
            }
            return JSON.stringify(response)
          }

          const result = TextPage.format(output, { offset, limit, maxBytes }, makeOutput)
          if (!result.ok) {
            const message = {
              offset: "Offset is outside the recorded tool result.",
              surrogate: "Offset falls inside a Unicode surrogate pair.",
              character: "Page limit cannot include the next Unicode character.",
              budget: "Recorded tool result envelope exceeds the output limit.",
            }[result.error]
            return yield* Effect.fail(new Error(message))
          }

          return {
            title: "Recorded tool result",
            output: result.output,
            metadata: { truncated: false },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
