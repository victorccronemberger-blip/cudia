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
import { Goal } from "../../src/goal"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID } from "../../src/session/schema"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const requests: LLM.StreamInput[] = []
const replies: Stream.Stream<LLMEvent, unknown>[] = []
const suite = testEffect(
  LayerNode.compile(LayerNode.group([SessionPrompt.node, Session.node, SessionProjector.node, Goal.node]), [
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
  permission: { "*": "allow" as const },
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

function completeGoal(evidence = "The requested fixture result was checked.") {
  return Stream.unwrap(
    Effect.gen(function* () {
      const request = requests.at(-1)!
      const execute = request.tools.update_goal?.execute
      if (!execute) return yield* Effect.die("Native update_goal was not exposed")
      yield* Effect.promise(() =>
        execute(
          { status: "completed", evidence },
          { toolCallId: "goal-completion", messages: [], abortSignal: new AbortController().signal },
        ),
      )
      return reply()
    }),
  )
}

suite.instance(
  "an unfinished goal continues in the same session without child agents and idles after a no-work continuation",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Native goal continuation" })
      const start = requests.length
      replies.push(reply(), reply())
      yield* prompt.command({
        sessionID: chat.id,
        command: "goal",
        arguments: "Produce the requested fixture",
        model: "test/operational",
      })
      expect(requests.length - start).toBe(2)
      expect(
        requests.slice(start).every((request) => request.sessionID === chat.id && request.agent.name === "build"),
      ).toBe(true)
      for (const request of requests.slice(start)) {
        expect(request.tools.get_goal).toBeDefined()
        expect(request.tools.update_goal).toBeDefined()
        expect(
          request.messages.some(
            (message) =>
              message.role === "user" && JSON.stringify(message.content).includes("Produce the requested fixture"),
          ),
        ).toBe(true)
        expect(request.system.join("\n")).not.toContain("[Active goal]")
      }
      expect((yield* goals.get(chat.id))?.status).toBe("active")
      expect((yield* goals.get(chat.id))?.stopReason).toContain("no work tool call")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  { config },
)

suite.instance(
  "native completion stores evidence and prevents another automatic turn",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Native goal completion" })
      const start = requests.length
      replies.push(completeGoal("fixture.txt contains the requested value"))
      yield* prompt.command({
        sessionID: chat.id,
        command: "goal",
        arguments: "Check fixture.txt",
        model: "test/operational",
      })
      expect(requests.length - start).toBe(1)
      expect(yield* goals.get(chat.id)).toMatchObject({
        status: "completed",
        evidence: "fixture.txt contains the requested value",
      })
      replies.push(reply())
      yield* prompt.prompt({
        sessionID: chat.id,
        model,
        parts: [{ type: "text", text: "Follow-up without an active goal" }],
      })
      expect(requests.at(-1)?.tools.get_goal).toBeUndefined()
      expect(requests.at(-1)?.tools.update_goal).toBeUndefined()
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("[Active goal]")
    }),
  { config },
)

suite.instance(
  "user steering takes the next turn and selected model while a goal is running",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Steered native goal" })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const start = requests.length
      replies.push(
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return reply()
          }),
        ),
        completeGoal(),
      )
      const work = yield* prompt
        .command({ sessionID: chat.id, command: "goal", arguments: "Finish the fixture", model: "test/operational" })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "first goal request not started", "10 seconds")
      yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        model: { providerID: model.providerID, modelID: ModelV2.ID.make("control") },
        variant: "changed",
        parts: [{ type: "text", text: "Use the corrected fixture and current model." }],
      })
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Fiber.join(work), "steered goal did not finish", "10 seconds")
      expect(requests.length - start).toBe(2)
      expect(requests[start + 1]?.model.id).toBe(ModelV2.ID.make("control"))
      expect(requests[start + 1]?.user.model.variant).toBe("changed")
      expect(JSON.stringify(requests[start + 1]?.messages)).toContain("Use the corrected fixture")
      expect((yield* goals.get(chat.id))?.status).toBe("completed")
    }),
  { config },
)

suite.instance(
  "a saved objective is restored to provider context after its original transcript anchor disappears",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Persistent objective" })
      replies.push(reply(), reply())
      yield* prompt.command({
        sessionID: chat.id,
        command: "goal",
        arguments: "Keep the original verifiable objective",
        model: "test/operational",
      })
      const saved = yield* goals.get(chat.id)
      for (const message of yield* sessions.messages({ sessionID: chat.id }))
        yield* sessions.removeMessage({ sessionID: chat.id, messageID: message.info.id })
      replies.push(completeGoal())
      yield* prompt.prompt({
        sessionID: chat.id,
        model,
        parts: [{ type: "text", text: "Continue from the compacted summary" }],
      })
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Keep the original verifiable objective")
      expect((yield* goals.get(chat.id))?.id).toBe(saved?.id)
      expect((yield* goals.get(chat.id))?.status).toBe("completed")
    }),
  { config },
)

suite.instance(
  "interrupting a goal preserves usage already reported by the provider",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Interrupted goal usage" })
      const entered = yield* Deferred.make<void>()
      const usage = new Usage({ inputTokens: 17, outputTokens: 5, totalTokens: 22 })
      replies.push(
        Stream.concat(
          Stream.make(LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage })),
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }),
          ),
        ),
      )
      const work = yield* prompt
        .command({ sessionID: chat.id, command: "goal", arguments: "Run until interrupted", model: "test/operational" })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "usage was not reported", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* awaitWithTimeout(Fiber.await(work), "goal did not stop", "10 seconds")
      expect(yield* goals.get(chat.id)).toMatchObject({ status: "paused", tokensUsed: 22 })
    }),
  { config },
)

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
  "goal attachments survive pausing the main executor during streaming",
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
      expect(requests[initial]?.agent.name).toBe("build")
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
