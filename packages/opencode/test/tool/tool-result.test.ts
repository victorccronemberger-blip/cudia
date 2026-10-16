import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { ToolResultTool } from "@/tool/tool-result"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

let configuredMaxBytes = 50 * 1024
const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    Database.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    Ripgrep.node,
    Session.node,
    SessionProjector.node,
    RuntimeFlags.node,
    Truncate.node,
  ]),
  [
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [
      Truncate.node,
      Layer.mock(Truncate.Service, {
        limits: () => Effect.succeed({ maxBytes: configuredMaxBytes, maxLines: 2000 }),
      }),
    ],
  ],
)
const it = testEffect(layer)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const seed = Effect.fn("ToolResultTest.seed")(function* (input: {
  output: string
  truncated?: boolean
  completed?: boolean
  attachments?: boolean
}) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({})
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  const partID = PartID.ascending()
  const part: SessionV1.ToolPart = {
    id: partID,
    messageID: assistant.id,
    sessionID: chat.id,
    type: "tool",
    tool: "shell",
    callID: "call-recorded-result",
    state:
      input.completed === false
        ? {
            status: "error",
            input: { command: "private" },
            error: "private failure",
            time: { start: Date.now(), end: Date.now() },
          }
        : {
            status: "completed",
            input: { command: "private" },
            output: input.output,
            title: "Recorded output",
            metadata: { truncated: input.truncated, internal: "private metadata" },
            time: { start: Date.now(), end: Date.now() },
            ...(input.attachments
              ? {
                  attachments: [
                    {
                      id: PartID.ascending(),
                      messageID: assistant.id,
                      sessionID: chat.id,
                      type: "file",
                      mime: "text/plain",
                      url: "data:text/plain,private-attachment",
                      filename: "private.txt",
                    },
                  ],
                }
              : {}),
          },
  }
  yield* sessions.updatePart(part)
  return { chat, assistant, partID }
})

function context(input: { sessionID: SessionV1.SessionInfo["id"]; ask: Tool.Context["ask"] }): Tool.Context {
  return {
    sessionID: input.sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: input.ask,
  }
}

const getTool = Effect.gen(function* () {
  const info = yield* ToolResultTool
  return yield* Tool.init(info)
})

function failureMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

describe("tool.tool_result", () => {
  it.instance("paginates exact stored output with Unicode-safe offsets and bounded JSON", () =>
    Effect.gen(function* () {
      const tool = yield* getTool
      const source = "A🙂é𐐷\ud800Z\n🚀"
      const seeded = yield* seed({ output: source, truncated: true, attachments: true })
      const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []
      const ctx = context({
        sessionID: seeded.chat.id,
        ask: (request) => Effect.sync(() => asks.push(request)),
      })
      const pages: string[] = []
      let offset = 0
      let complete = false
      let outputHash: string | undefined
      while (!complete) {
        const result = yield* tool.execute(
          {
            messageID: seeded.assistant.id,
            partID: seeded.partID,
            offset,
            limit: 2,
            ...(outputHash ? { outputHash } : {}),
          },
          ctx,
        )
        const response = JSON.parse(result.output)
        expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(6000)
        expect(result.metadata.truncated).toBe(false)
        expect(response.offsetUnit).toBe("utf16_code_units")
        expect(response.totalLength).toBe(source.length)
        expect(response.captureTruncated).toBe(true)
        expect(response.attachmentCount).toBe(1)
        expect(response.outputHash).toMatch(/^[\da-f]{64}$/)
        expect(result.output).not.toContain("private")
        pages.push(response.text)
        offset = response.nextOffset
        outputHash = response.outputHash
        complete = response.complete
      }
      expect(pages.join("")).toBe(source)
      expect(asks.length).toBeGreaterThan(1)
      expect(asks[0].permission).toBe("tool_result")
      expect(asks[0].patterns).toEqual([
        `message:${Buffer.from(JSON.stringify(seeded.assistant.id), "utf8").toString("hex")}`,
        `part:${Buffer.from(JSON.stringify(seeded.partID), "utf8").toString("hex")}`,
      ])
      expect(asks[0].patterns.join(" ")).not.toContain(seeded.assistant.id)

      const insidePair = yield* tool
        .execute({ messageID: seeded.assistant.id, partID: seeded.partID, offset: 2, limit: 2, outputHash }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(insidePair)).toBe(true)
      if (Exit.isFailure(insidePair))
        expect(failureMessage(insidePair.cause)).toBe("Offset falls inside a Unicode surrogate pair.")

      const missingHash = yield* tool
        .execute({ messageID: seeded.assistant.id, partID: seeded.partID, offset: 1 }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(missingHash)).toBe(true)
      if (Exit.isFailure(missingHash))
        expect(failureMessage(missingHash.cause)).toBe("Pass outputHash from the first page when continuing.")

      const oversizedLimit = yield* tool
        .execute({ messageID: seeded.assistant.id, partID: seeded.partID, limit: 4097 }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(oversizedLimit)).toBe(true)

      const lone = yield* seed({ output: "\ud800" })
      const replacement = yield* seed({ output: "\ufffd" })
      const lonePage = yield* tool.execute(
        { messageID: lone.assistant.id, partID: lone.partID },
        context({ sessionID: lone.chat.id, ask: ctx.ask }),
      )
      expect(JSON.parse(lonePage.output).captureTruncated).toBe(null)
      const replacementPage = yield* tool.execute(
        { messageID: replacement.assistant.id, partID: replacement.partID },
        context({ sessionID: replacement.chat.id, ask: ctx.ask }),
      )
      expect(JSON.parse(lonePage.output).outputHash).not.toBe(JSON.parse(replacementPage.output).outputHash)
    }),
  )

  it.instance("uses one opaque unavailable error and requests permission before lookup", () =>
    Effect.gen(function* () {
      const tool = yield* getTool
      const sessions = yield* Session.Service
      const saved = yield* seed({ output: "recorded" })
      const foreign = yield* sessions.create({})
      const requests: Array<Parameters<Tool.Context["ask"]>[0]> = []
      const allowed = context({
        sessionID: saved.chat.id,
        ask: (request) => Effect.sync(() => requests.push(request)),
      })
      const foreignSession = context({ sessionID: foreign.id, ask: allowed.ask })
      const missingMessage = MessageID.ascending()
      const missingPart = PartID.ascending()

      const unavailable: string[] = []
      for (const input of [
        { messageID: saved.assistant.id, partID: saved.partID, ctx: foreignSession },
        { messageID: missingMessage, partID: saved.partID, ctx: allowed },
        { messageID: saved.assistant.id, partID: missingPart, ctx: allowed },
      ]) {
        const exit = yield* tool
          .execute({ messageID: input.messageID, partID: input.partID }, input.ctx)
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) unavailable.push(failureMessage(exit.cause))
      }

      const failedCapture = yield* seed({ output: "private error", completed: false })
      const failed = yield* tool
        .execute({ messageID: failedCapture.assistant.id, partID: failedCapture.partID }, allowed)
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) unavailable.push(failureMessage(failed.cause))
      expect(new Set(unavailable)).toEqual(
        new Set(["No completed tool result is available for the supplied identifiers."]),
      )

      const denied = yield* tool
        .execute(
          { messageID: MessageID.ascending(), partID: PartID.ascending() },
          context({
            sessionID: saved.chat.id,
            ask: () => Effect.die(new Error("permission denied first")),
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(failureMessage(denied.cause)).toBe("permission denied first")
      expect(requests.length).toBeGreaterThan(0)
    }),
  )

  it.instance("fits serialized pages to configured output limits and fails when the envelope cannot fit", () =>
    Effect.gen(function* () {
      const tool = yield* getTool
      const seeded = yield* seed({ output: "🙂".repeat(3000) })
      const ctx = context({ sessionID: seeded.chat.id, ask: () => Effect.void })
      configuredMaxBytes = 50 * 1024
      const protocolBound = yield* tool.execute({ messageID: seeded.assistant.id, partID: seeded.partID }, ctx)
      expect(Buffer.byteLength(protocolBound.output, "utf8")).toBeLessThanOrEqual(6000)
      expect(JSON.parse(protocolBound.output).complete).toBe(false)

      configuredMaxBytes = 400
      const result = yield* tool.execute({ messageID: seeded.assistant.id, partID: seeded.partID }, ctx)
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(400)
      expect(JSON.parse(result.output).complete).toBe(false)

      configuredMaxBytes = 100
      const tooSmall = yield* tool
        .execute({ messageID: seeded.assistant.id, partID: seeded.partID, limit: 2 }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(tooSmall)).toBe(true)
      if (Exit.isFailure(tooSmall))
        expect(failureMessage(tooSmall.cause)).toBe("Recorded tool result envelope exceeds the output limit.")

      const source = "🙂".repeat(3000)
      const emptyEnvelope = JSON.stringify({
        text: "",
        offset: 0,
        nextOffset: 0,
        complete: false,
        totalLength: source.length,
        outputHash: "0".repeat(64),
        offsetUnit: "utf16_code_units",
        captureTruncated: null,
        attachmentCount: 0,
      })
      configuredMaxBytes = Buffer.byteLength(emptyEnvelope, "utf8") + 1
      const oneUnitCannotProgress = yield* tool
        .execute({ messageID: seeded.assistant.id, partID: seeded.partID, limit: 2 }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(oneUnitCannotProgress)).toBe(true)
      if (Exit.isFailure(oneUnitCannotProgress))
        expect(failureMessage(oneUnitCannotProgress.cause)).toBe(
          "Recorded tool result envelope exceeds the output limit.",
        )
      configuredMaxBytes = 50 * 1024
    }),
  )

  it.instance("rejects a continuation after the completed output changes", () =>
    Effect.gen(function* () {
      const tool = yield* getTool
      const sessions = yield* Session.Service
      const seeded = yield* seed({ output: "abcdef" })
      const ctx = context({ sessionID: seeded.chat.id, ask: () => Effect.void })
      const first = yield* tool.execute({ messageID: seeded.assistant.id, partID: seeded.partID, limit: 2 }, ctx)
      const page = JSON.parse(first.output)
      const part = yield* sessions.getPart({
        sessionID: seeded.chat.id,
        messageID: seeded.assistant.id,
        partID: seeded.partID,
      })
      if (!part || part.type !== "tool" || part.state.status !== "completed") throw new Error("Tool part missing")
      yield* sessions.updatePart({ ...part, state: { ...part.state, output: "ABCDEF" } })

      const next = yield* tool
        .execute(
          {
            messageID: seeded.assistant.id,
            partID: seeded.partID,
            offset: page.nextOffset,
            outputHash: page.outputHash,
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(next)).toBe(true)
      if (Exit.isFailure(next))
        expect(failureMessage(next.cause)).toBe("Recorded tool result changed since the previous page.")
    }),
  )
})
