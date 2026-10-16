import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID } from "../../src/session/schema"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const requests: LLM.StreamInput[] = []
const replies: Stream.Stream<LLMEvent, unknown>[] = []
const suite = testEffect(
  LayerNode.compile(LayerNode.group([SessionPrompt.node, Session.node, SessionProjector.node]), [
    [
      LLM.node,
      Layer.mock(LLM.Service)({
        stream: (input) => {
          requests.push(input)
          return replies.shift() ?? Stream.die(new Error("Unexpected model request"))
        },
      }),
    ],
    [
      SessionSummary.node,
      Layer.mock(SessionSummary.Service)({
        summarize: () => Effect.void,
        diff: () => Effect.succeed([]),
        computeDiff: () => Effect.succeed([]),
      }),
    ],
    [
      LSP.node,
      Layer.mock(LSP.Service)({
        init: () => Effect.void,
        status: () => Effect.succeed([]),
        hasClients: () => Effect.succeed(false),
        diagnostics: () => Effect.succeed({}),
      }),
    ],
    [
      MCP.node,
      Layer.mock(MCP.Service)({
        status: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
        instructions: () => Effect.succeed([]),
        tools: () => Effect.succeed({}),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("operational") }
const config = {
  agent: { "goal-planner": { mode: "subagent" as const, prompt: "Plan the requested goal." } },
  provider: {
    test: {
      name: "Test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        operational: { name: "Operational", limit: { context: 100000, output: 10000 } },
        control: { name: "Control", limit: { context: 100000, output: 10000 } },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

function reply() {
  const usage = new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
  return Stream.make(
    LLMEvent.textStart({ id: "answer" }),
    LLMEvent.textDelta({ id: "answer", text: "Operational work completed." }),
    LLMEvent.textEnd({ id: "answer" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
    LLMEvent.finish({ reason: "stop", usage }),
  )
}

suite.instance(
  "goal status does not finish a pending operational turn or replace its model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned operational session" })
      const user = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model,
        noReply: true,
        parts: [{ type: "text", text: "Finish the pending operational task." }],
      })
      const assistantID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: user.info.id,
        sessionID: chat.id,
        agent: "build",
        mode: "build",
        path: { cwd: ".", root: "." },
        providerID: model.providerID,
        modelID: model.modelID,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
        finish: "tool-calls",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: chat.id,
        type: "tool",
        callID: "pending-operational-call",
        tool: "read",
        state: { status: "pending", input: { filePath: "pending.txt" }, raw: "" },
      })

      const initial = requests.length
      const control = yield* prompt.command({
        sessionID: chat.id,
        command: "goal",
        arguments: "status",
        model: "test/control",
        variant: "control-mode",
      })
      expect(requests.length).toBe(initial)
      expect(control.info.role).toBe("assistant")
      if (control.info.role === "assistant") expect(control.info.variant).toBe("control-mode")
      expect(control.parts.some((part) => part.type === "text" && part.metadata?.goalControl === true)).toBe(true)
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const controls = stored.filter((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.goalControl === true),
      )
      expect(controls.map((message) => message.info.role)).toEqual(["user", "assistant"])
      expect(controls[0]?.parts.some((part) => part.type === "text" && part.ignored === true)).toBe(true)

      replies.push(reply())
      const completed = yield* awaitWithTimeout(
        prompt.loop({ sessionID: chat.id }),
        "operational continuation did not complete",
        "10 seconds",
      )
      expect(completed.info.id).not.toBe(control.info.id)
      expect(completed.info.role).toBe("assistant")
      expect(requests.length).toBe(initial + 1)
      const continuation = requests[initial]!
      expect(continuation.user.id).toBe(user.info.id)
      expect(continuation.model.id).toBe(model.modelID)
      expect(JSON.stringify(continuation.messages)).toContain("Finish the pending operational task.")
      expect(JSON.stringify(continuation.messages)).not.toContain("GOAL CONTROL")
      expect(JSON.stringify(continuation.messages)).not.toContain("No active goal")

      yield* prompt.command({ sessionID: chat.id, command: "goal", arguments: "status", model: "test/control" })
      const next = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Continue with the same operational model." }],
      })
      expect(next.info.role).toBe("user")
      if (next.info.role === "user") expect(next.info.model).toMatchObject(model)
    }),
  { config },
)

suite.instance(
  "goal attachments survive pausing the real planner before execution starts",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned attached session" })
      const initial = requests.length
      const entered = yield* Deferred.make<void>()
      replies.push(
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }),
        ),
      )
      const fiber = yield* prompt
        .command({
          sessionID: chat.id,
          command: "goal",
          arguments: "Finish the attached operational task",
          model: "test/operational",
          variant: "careful",
          parts: [
            {
              type: "file",
              mime: "text/plain",
              filename: "goal-evidence.txt",
              url: "data:text/plain;base64,cGVyc2lzdGVudCBnb2FsIGV2aWRlbmNl",
            },
          ],
        })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "goal planner was not entered", "10 seconds")
      expect(requests[initial]?.agent.name).toBe("goal-planner")
      expect(requests[initial]?.user.model.variant).toBe("careful")
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const attachment = messages.find((message) =>
        message.parts.some((part) => part.type === "file" && part.filename === "goal-evidence.txt"),
      )
      expect(attachment?.info.role).toBe("user")
      if (attachment?.info.role === "user") expect(attachment.info.model.variant).toBe("careful")
      expect(attachment?.parts.some((part) => part.type === "text" && part.text === "persistent goal evidence")).toBe(
        true,
      )
      expect(attachment?.parts.some((part) => part.type === "text" && part.metadata?.goalControl === true)).toBe(false)
      yield* awaitWithTimeout(prompt.cancel(chat.id), "goal planner did not pause", "10 seconds")
      yield* awaitWithTimeout(Fiber.await(fiber), "paused goal command did not stop", "10 seconds")
      const status = yield* prompt.command({ sessionID: chat.id, command: "goal", arguments: "status" })
      expect(status.parts.some((part) => part.type === "text" && part.text.includes("Status: paused"))).toBe(true)
      const stored = yield* sessions.messages({ sessionID: chat.id })
      expect(
        stored
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "file" && part.filename === "goal-evidence.txt"),
      ).toHaveLength(1)
      expect(requests.length).toBe(initial + 1)
    }),
  { config },
)

suite.instance(
  "cancelling an active prompt after goal status returns its operational assistant",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned interrupted session" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model,
        noReply: true,
        parts: [{ type: "text", text: "Operational request still running." }],
      })
      const entered = yield* Deferred.make<void>()
      replies.push(
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }),
        ),
      )
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "operational model was not entered", "10 seconds")
      const before = yield* sessions.messages({ sessionID: chat.id })
      const active = before.findLast((message) => message.info.role === "assistant")
      expect(active).toBeDefined()
      const control = yield* prompt.command({
        sessionID: chat.id,
        command: "goal",
        arguments: "status",
        model: "test/control",
      })
      yield* awaitWithTimeout(prompt.cancel(chat.id), "prompt cancellation did not finish", "10 seconds")
      const result = yield* awaitWithTimeout(Fiber.join(fiber), "cancelled prompt did not return", "10 seconds")
      expect(result.info.id).toBe(active!.info.id)
      expect(result.info.id).not.toBe(control.info.id)
      expect(result.parts.some((part) => part.type === "text" && part.metadata?.goalControl === true)).toBe(false)
    }),
  { config },
)
