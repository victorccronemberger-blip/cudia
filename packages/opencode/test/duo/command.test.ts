import { afterAll, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { Duo } from "@/duo"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLM } from "@/session/llm"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { InstanceStore } from "@/project/instance-store"
import { Storage } from "@/storage/storage"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const config = mkdtempSync(path.join(tmpdir(), "cudia-duo-command-test-"))
writeFileSync(
  path.join(config, "duo.json"),
  JSON.stringify({
    participants: [
      { name: "Drael", model: "test-a/one", variant: "high", agent: "general" },
      { name: "GPT", model: "test-b/two", variant: "high", agent: "general" },
    ],
    review: true,
  }),
)
afterAll(() => rmSync(config, { recursive: true, force: true }))

const records = new Map<string, unknown>()
const memory = Layer.mock(Storage.Service, {
  read: <T>(key: string[]) => {
    const value = records.get(key.join("/"))
    return value === undefined
      ? Effect.fail(new Storage.NotFoundError({ message: "missing" }))
      : Effect.succeed(value as T)
  },
  write: (key: string[], value: unknown) => Effect.sync(() => void records.set(key.join("/"), structuredClone(value))),
  update: <T>(key: string[], fn: (draft: T) => void) => {
    const value = records.get(key.join("/")) as T
    fn(value)
    records.set(key.join("/"), value)
    return Effect.succeed(value)
  },
  remove: (key: string[]) => Effect.sync(() => void records.delete(key.join("/"))),
  list: () => Effect.succeed([]),
})
const requests: LLM.StreamInput[] = []
let failProviderA = false
let workGate:
  | {
      aEntered: Deferred.Deferred<void>
      bEntered: Deferred.Deferred<void>
      releaseA: Deferred.Deferred<void>
      releaseB: Deferred.Deferred<void>
    }
  | undefined
let livePeerGate:
  | {
      aWorkEntered: Deferred.Deferred<void>
      bWorkEntered: Deferred.Deferred<void>
      releaseBWork: Deferred.Deferred<void>
      bReviewNextCall: Deferred.Deferred<void>
      releaseBReview: Deferred.Deferred<void>
      aNextWorkEntered: Deferred.Deferred<void>
      releaseANextWork: Deferred.Deferred<void>
      fixturePath: string
      fixtureText: string
      aWorkCalls: number
      bReviewCalls: number
    }
  | undefined
const suite = testEffect(
  LayerNode.compile(LayerNode.group([SessionPrompt.node, Session.node, SessionProjector.node, Duo.node]), [
    [Global.node, Global.layerWith({ config })],
    [Storage.node, memory],
    [
      LLM.node,
      Layer.mock(LLM.Service)({
        stream: (input) => {
          requests.push(input)
          if (livePeerGate && input.agent.name === "general") {
            const isReview = input.messages.some((message) =>
              JSON.stringify(message.content).includes("Duo peer review by"),
            )
            if (input.model.providerID === "test-a" && !isReview) {
              livePeerGate.aWorkCalls++
              if (livePeerGate.aWorkCalls === 1)
                return Stream.unwrap(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(livePeerGate!.aWorkEntered, undefined)
                    yield* Deferred.await(livePeerGate!.bReviewNextCall)
                    return toolResponse(
                      "DRAEL_TOOL_TURN_MARKER",
                      livePeerGate!.fixturePath,
                      livePeerGate!.fixtureText,
                      "drael-read",
                    )
                  }),
                )
              if (livePeerGate.aWorkCalls === 2)
                return Stream.unwrap(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(livePeerGate!.aNextWorkEntered, undefined)
                    yield* Deferred.await(livePeerGate!.releaseANextWork)
                    return response("DRAEL_WORK_FINAL_MARKER")
                  }),
                )
            }
            if (input.model.providerID === "test-b" && !isReview)
              return Stream.unwrap(
                Effect.gen(function* () {
                  yield* Deferred.succeed(livePeerGate!.bWorkEntered, undefined)
                  yield* Deferred.await(livePeerGate!.releaseBWork)
                  return response("GPT_WORK_PUBLIC_MARKER")
                }),
              )
            if (input.model.providerID === "test-b" && isReview) {
              livePeerGate.bReviewCalls++
              if (livePeerGate.bReviewCalls === 1)
                return toolResponse(
                  "GPT_REVIEW_PUBLIC_MARKER",
                  livePeerGate.fixturePath,
                  livePeerGate.fixtureText,
                  "gpt-review-read",
                )
              if (livePeerGate.bReviewCalls === 2)
                return Stream.unwrap(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(livePeerGate!.bReviewNextCall, undefined)
                    yield* Deferred.await(livePeerGate!.releaseBReview)
                    return response("GPT_REVIEW_FINAL_MARKER")
                  }),
                )
            }
          }
          if (failProviderA && input.agent.name === "general" && input.model.providerID === "test-a")
            return Stream.die(new Error("simulated provider failure"))
          const isDuoWork =
            input.agent.name === "general" &&
            input.messages.some((message) =>
              JSON.stringify(message.content).includes("Duo: work toward this shared objective"),
            ) &&
            !input.messages.some((message) => JSON.stringify(message.content).includes("Duo peer review by"))
          if (workGate && isDuoWork && input.model.providerID === "test-a")
            return Stream.unwrap(
              Effect.gen(function* () {
                yield* Deferred.succeed(workGate!.aEntered, undefined)
                yield* Deferred.await(workGate!.releaseA)
                return response()
              }),
            )
          if (workGate && isDuoWork && input.model.providerID === "test-b")
            return Stream.unwrap(
              Effect.gen(function* () {
                yield* Deferred.succeed(workGate!.bEntered, undefined)
                yield* Deferred.await(workGate!.releaseB)
                return response()
              }),
            )
          return response()
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

const provider = (name: string, model: string) => ({
  name,
  env: [],
  npm: "@ai-sdk/openai-compatible",
  models: {
    [model]: {
      name: model,
      limit: { context: 100000, output: 10000 },
      variants: { high: { reasoningEffort: "high" } },
    },
  },
  options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
})
const instanceConfig = {
  permission: { "*": "allow" as const },
  provider: { "test-a": provider("Test A", "one"), "test-b": provider("Test B", "two") },
}

function response(text = "Reviewed implementation and verified the requested result.") {
  const usage = new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
  return Stream.make(
    LLMEvent.textStart({ id: "answer" }),
    LLMEvent.textDelta({ id: "answer", text }),
    LLMEvent.textEnd({ id: "answer" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
    LLMEvent.finish({ reason: "stop", usage }),
  )
}

function toolResponse(text: string, fixturePath: string, fixtureText: string, callID: string) {
  const usage = new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
  return Stream.make(
    LLMEvent.textStart({ id: "answer" }),
    LLMEvent.textDelta({ id: "answer", text }),
    LLMEvent.textEnd({ id: "answer" }),
    LLMEvent.toolCall({
      id: callID,
      name: "read",
      input: { filePath: fixturePath },
      providerExecuted: true,
    }),
    LLMEvent.toolResult({
      id: callID,
      name: "read",
      result: { type: "text", value: { title: "Read fixture", output: fixtureText, metadata: {} } },
      providerExecuted: true,
    }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage }),
    LLMEvent.finish({ reason: "tool-calls", usage }),
  )
}

suite.instance(
  "/duo runs both configured models, reuses their child sessions for peer review, then gives both results to the coordinator",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const duo = yield* Duo.Service
      const instance = yield* TestInstance
      const chat = yield* sessions.create({ title: "Native Duo command" })
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const state = yield* duo.get(chat.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!state) return
          const runRoot = path.dirname(state.members[0].directory)
          yield* Effect.promise(async () => {
            for (const member of state.members) {
              const child = Bun.spawn(["git", "worktree", "remove", "--force", member.directory], {
                cwd: instance.directory,
                stdout: "ignore",
                stderr: "ignore",
              })
              await child.exited
            }
            const prune = Bun.spawn(["git", "worktree", "prune"], {
              cwd: instance.directory,
              stdout: "ignore",
              stderr: "ignore",
            })
            await prune.exited
            await fs.rm(runRoot, { recursive: true, force: true })
          })
        }),
      )
      const start = requests.length
      const objective = "Implement the shared fixture change and verify it."

      yield* awaitWithTimeout(
        prompt.command({ sessionID: chat.id, command: "duo", arguments: objective }),
        "Duo command did not complete",
        "30 seconds",
      )

      const run = yield* duo.get(chat.id)
      expect(run?.status).toBe("completed")
      expect(run?.schedule).toBe("parallel")
      expect(run?.members.map((member) => member.model)).toEqual(["test-a/one", "test-b/two"])
      expect(run?.members[0].directory).not.toBe(run?.members[1].directory)
      expect(run?.members.every((member) => member.work?.status === "completed")).toBe(true)
      expect(run?.members.every((member) => member.review?.status === "completed")).toBe(true)
      expect(run?.members[0].taskID).toBeDefined()
      expect(run?.members[1].taskID).toBeDefined()

      const calls = requests.slice(start)
      const childCalls = calls.filter((request) => request.agent.name === "general")
      expect(childCalls).toHaveLength(4)
      expect(childCalls.map((request) => `${request.model.providerID}/${request.model.id}`).sort()).toEqual([
        "test-a/one",
        "test-a/one",
        "test-b/two",
        "test-b/two",
      ])
      expect(childCalls.filter((request) => request.sessionID === run?.members[0].taskID)).toHaveLength(2)
      expect(childCalls.filter((request) => request.sessionID === run?.members[1].taskID)).toHaveLength(2)
      const workMessages = childCalls.filter(
        (request) =>
          request.messages.some((message) =>
            JSON.stringify(message.content).includes("Duo: work toward this shared objective"),
          ) && !request.messages.some((message) => JSON.stringify(message.content).includes("Duo peer review by")),
      )
      expect(workMessages).toHaveLength(2)
      expect(workMessages[0].messages.find((message) => message.role === "user")?.content).toEqual(
        workMessages[1].messages.find((message) => message.role === "user")?.content,
      )
      expect(
        childCalls.filter((request) =>
          request.messages.some((message) => JSON.stringify(message.content).includes("Duo peer review by")),
        ),
      ).toHaveLength(2)

      const coordinator = calls.findLast((request) => request.agent.name === "build")
      expect(coordinator).toBeDefined()
      expect(
        coordinator?.messages.some((message) =>
          JSON.stringify(message.content).includes("Resultados: Drael: trabalho completed, revisão completed"),
        ),
      ).toBe(true)
      expect(
        coordinator?.messages.some((message) => JSON.stringify(message.content).includes("GPT: trabalho completed")),
      ).toBe(true)
      expect(calls.every((request) => request.sessionID === chat.id || request.agent.name === "general")).toBe(true)
    }),
  { git: true, config: instanceConfig },
  { timeout: 30000 },
)

suite.instance(
  "/duo shares live review progress with a still-running peer in a non-Git workspace",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const duo = yield* Duo.Service
      const instance = yield* TestInstance
      const chat = yield* sessions.create({ title: "Duo live peer progress without Git" })
      const fixturePath = path.join(instance.directory, "duo-live-fixture.txt")
      const fixtureText = "READ_FIXTURE_CONTENT_5C89"
      yield* Effect.promise(() => fs.writeFile(fixturePath, fixtureText))
      const gates = {
        aWorkEntered: yield* Deferred.make<void>(),
        bWorkEntered: yield* Deferred.make<void>(),
        releaseBWork: yield* Deferred.make<void>(),
        bReviewNextCall: yield* Deferred.make<void>(),
        releaseBReview: yield* Deferred.make<void>(),
        aNextWorkEntered: yield* Deferred.make<void>(),
        releaseANextWork: yield* Deferred.make<void>(),
        fixturePath,
        fixtureText,
        aWorkCalls: 0,
        bReviewCalls: 0,
      }
      livePeerGate = gates
      yield* Effect.addFinalizer(() => {
        livePeerGate = undefined
        return Effect.all(
          [
            Deferred.succeed(gates.releaseBWork, undefined),
            Deferred.succeed(gates.releaseBReview, undefined),
            Deferred.succeed(gates.releaseANextWork, undefined),
          ],
          { discard: true },
        )
      })

      const start = requests.length
      const command = yield* prompt
        .command({
          sessionID: chat.id,
          command: "duo",
          arguments: "Compare both implementations and use the peer's live findings.",
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(
        Effect.all([Deferred.await(gates.aWorkEntered), Deferred.await(gates.bWorkEntered)]),
        "both non-Git Duo work streams did not start",
        "20 seconds",
      )
      yield* Deferred.succeed(gates.releaseBWork, undefined)
      yield* awaitWithTimeout(
        Deferred.await(gates.bReviewNextCall),
        "GPT did not publish its review-turn progress",
        "20 seconds",
      )
      yield* awaitWithTimeout(
        Deferred.await(gates.aNextWorkEntered),
        "Drael did not start its next provider turn",
        "20 seconds",
      )

      const running = yield* duo.get(chat.id)
      expect(running?.schedule).toBe("parallel")
      expect(running?.members[0].directory).toBe(instance.directory)
      expect(running?.members[1].directory).toBe(instance.directory)
      expect(running?.members[0].work).toBeUndefined()

      const calls = requests.slice(start)
      const draelFollowup = calls.find(
        (request) =>
          request.sessionID === running?.members[0].taskID &&
          request.model.providerID === "test-a" &&
          JSON.stringify(request.messages).includes("GPT_REVIEW_PUBLIC_MARKER"),
      )
      expect(draelFollowup).toBeDefined()
      const followupMessages = JSON.stringify(draelFollowup?.messages)
      expect(followupMessages).toContain("Phase: review. Status: working.")
      expect(followupMessages).toContain(path.basename(instance.directory))
      expect(followupMessages).toContain(fixtureText)
      expect(followupMessages.match(/GPT_REVIEW_PUBLIC_MARKER/g)).toHaveLength(1)

      yield* Deferred.succeed(gates.releaseBReview, undefined)
      yield* Deferred.succeed(gates.releaseANextWork, undefined)
      yield* awaitWithTimeout(Fiber.join(command), "non-Git Duo did not finish", "30 seconds")

      const finished = yield* duo.get(chat.id)
      expect(finished?.status).toBe("completed")
      expect(finished?.members.every((member) => member.work?.status === "completed")).toBe(true)
      expect(finished?.members.every((member) => member.review?.status === "completed")).toBe(true)
    }),
  { git: false, config: instanceConfig },
  { timeout: 30000 },
)

suite.instance(
  "/duo records a cancelled child independently while its peer completes review and integration",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const duo = yield* Duo.Service
      const store = yield* InstanceStore.Service
      const instance = yield* TestInstance
      const chat = yield* sessions.create({ title: "Duo child cancellation" })
      const gates = {
        aEntered: yield* Deferred.make<void>(),
        bEntered: yield* Deferred.make<void>(),
        releaseA: yield* Deferred.make<void>(),
        releaseB: yield* Deferred.make<void>(),
      }
      workGate = gates
      yield* Effect.addFinalizer(() => {
        workGate = undefined
        return Effect.gen(function* () {
          const state = yield* duo.get(chat.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!state) return
          const runRoot = path.dirname(state.members[0].directory)
          yield* Effect.promise(async () => {
            for (const member of state.members) {
              const child = Bun.spawn(["git", "worktree", "remove", "--force", member.directory], {
                cwd: instance.directory,
                stdout: "ignore",
                stderr: "ignore",
              })
              await child.exited
            }
            const prune = Bun.spawn(["git", "worktree", "prune"], {
              cwd: instance.directory,
              stdout: "ignore",
              stderr: "ignore",
            })
            await prune.exited
            await fs.rm(runRoot, { recursive: true, force: true })
          })
        })
      })
      const start = requests.length
      const command = yield* prompt
        .command({
          sessionID: chat.id,
          command: "duo",
          arguments: "Implement the shared fixture change and verify it despite a child cancellation.",
        })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        Effect.all([Deferred.await(gates.aEntered), Deferred.await(gates.bEntered)]),
        "both Duo work streams did not start",
        "20 seconds",
      )

      const running = yield* duo.get(chat.id)
      const cancelled = running?.members[0]
      const peer = running?.members[1]
      expect(cancelled?.taskID).toBeDefined()
      expect(peer?.taskID).toBeDefined()
      yield* store.provide({ directory: cancelled!.directory }, prompt.cancel(cancelled!.taskID!))
      expect(duo.owns(chat.id)).toBe(true)
      yield* Deferred.succeed(gates.releaseB, undefined)
      yield* awaitWithTimeout(Fiber.join(command), "Duo did not finish after the peer completed", "30 seconds")

      const finished = yield* duo.get(chat.id)
      expect(finished?.status).toBe("completed")
      expect(finished?.members[0].work?.status).toBe("failed")
      expect(finished?.members[0].work?.error).toContain("Aborted")
      expect(finished?.members[1].work?.status).toBe("completed")
      expect(finished?.members[1].review?.status).toBe("completed")
      const calls = requests.slice(start)
      expect(calls.filter((request) => request.agent.name === "general")).toHaveLength(3)
      expect(
        calls.some(
          (request) =>
            request.sessionID === peer?.taskID && JSON.stringify(request.messages).includes("Duo peer review by"),
        ),
      ).toBe(true)
    }),
  { git: true, config: instanceConfig },
  { timeout: 30000 },
)

suite.instance(
  "/duo keeps the healthy participant working after the peer provider fails and hands integration to that participant",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const duo = yield* Duo.Service
      const instance = yield* TestInstance
      const chat = yield* sessions.create({ title: "Duo peer failure fallback" })
      failProviderA = true
      yield* Effect.addFinalizer(() => {
        failProviderA = false
        return Effect.gen(function* () {
          const state = yield* duo.get(chat.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!state) return
          const runRoot = path.dirname(state.members[0].directory)
          yield* Effect.promise(async () => {
            for (const member of state.members) {
              const child = Bun.spawn(["git", "worktree", "remove", "--force", member.directory], {
                cwd: instance.directory,
                stdout: "ignore",
                stderr: "ignore",
              })
              await child.exited
            }
            const prune = Bun.spawn(["git", "worktree", "prune"], {
              cwd: instance.directory,
              stdout: "ignore",
              stderr: "ignore",
            })
            await prune.exited
            await fs.rm(runRoot, { recursive: true, force: true })
          })
        })
      })
      const start = requests.length

      yield* awaitWithTimeout(
        prompt.command({
          sessionID: chat.id,
          command: "duo",
          arguments: "Implement the shared fixture change and verify it despite one provider outage.",
        }),
        "Duo failure fallback did not complete",
        "30 seconds",
      )

      const run = yield* duo.get(chat.id)
      expect(run?.status).toBe("completed")
      expect(run?.members[0].work).toMatchObject({ status: "failed" })
      expect(run?.members[0].work?.error).toContain("simulated provider failure")
      expect(run?.members[1].work?.status).toBe("completed")
      expect(run?.members[0].review).toBeUndefined()
      expect(run?.members[1].review?.status).toBe("completed")
      const calls = requests.slice(start)
      expect(calls.filter((request) => request.agent.name === "general")).toHaveLength(3)
      const coordinator = calls.findLast((request) => request.agent.name === "build")
      expect(String(coordinator?.model.providerID)).toBe("test-b")
      expect(String(coordinator?.user.model.providerID)).toBe("test-b")
      expect(
        coordinator?.messages.some((message) =>
          JSON.stringify(message.content).includes("Drael falhou nesta rodada. A integração será feita por GPT"),
        ),
      ).toBe(true)
      expect(
        coordinator?.messages.some((message) =>
          JSON.stringify(message.content).includes("Resultados: Drael: trabalho failed"),
        ),
      ).toBe(true)
      expect(
        coordinator?.messages.some((message) =>
          JSON.stringify(message.content).includes("GPT: trabalho completed, revisão completed"),
        ),
      ).toBe(true)
    }),
  { git: true, config: instanceConfig },
  { timeout: 30000 },
)
