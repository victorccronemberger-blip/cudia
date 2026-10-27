import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Goal } from "@/goal"
import { Deferred, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("exposes create_goal to a non-plan assistant and binds it to the current user message", () =>
  Effect.gen(function* () {
    const parentID = MessageID.ascending()
    const calls: unknown[] = []
    const asked: string[] = []
    const accounted: string[] = []
    const created: Goal.State = {
      id: "goal-created",
      sessionID,
      objective: "Create the requested artifact",
      status: "active",
      iteration: 1,
      startedAt: 1,
      updatedAt: 1,
      maxIterations: 4,
      tokenBudget: 18000,
      tokensUsed: 0,
      runtime: 2,
      revision: 0,
      completionCriteria: [],
      plan: [],
      observations: [],
      failures: [],
      recentHashes: [],
      replanned: false,
      parentID,
    }
    let current: Goal.State | undefined
    const goal = {
      get: () => Effect.succeed(current),
      creationRevision: () => 0,
      create: (nextSessionID: SessionID, nextParentID: MessageID, input: unknown, revision: number) =>
        Effect.sync(() => {
          calls.push([nextSessionID, nextParentID, input, revision])
          current = created
          return created
        }),
      account: (_nextSessionID: SessionID, message: SessionV1.WithParts) =>
        Effect.sync(() => {
          accounted.push(message.info.id)
        }),
    } as unknown as Goal.Interface
    const permission = Permission.Service.of({
      ...fakePermission,
      ask: (input) =>
        Effect.sync(() => {
          asked.push(input.permission)
        }),
    })
    const assistant = {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID,
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    } satisfies SessionV1.Assistant
    const priorMessage = (created: number, messageParentID = parentID): SessionV1.WithParts => ({
      info: { ...assistant, id: MessageID.ascending(), parentID: messageParentID, time: { created } },
      parts: [],
    })
    const earlier = priorMessage(2)
    const later = priorMessage(4)
    const unrelated = priorMessage(1, MessageID.ascending())
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [later, unrelated, { info: assistant, parts: [] }, earlier],
      promptOps: {} as never,
      goal,
    }).pipe(Effect.provide(Layer.succeed(Permission.Service, permission)))

    expect(tools.create_goal).toBeDefined()
    const execute = tools.create_goal?.execute
    if (!execute) throw new Error("create_goal tool is missing execute")
    const output = yield* Effect.promise(() =>
      execute(
        { objective: "Create the requested artifact", max_iterations: 4, token_budget: 18000 },
        { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] },
      ),
    )

    expect(calls).toEqual([
      [sessionID, parentID, { objective: "Create the requested artifact", maxIterations: 4, tokenBudget: 18000 }, 0],
    ])
    expect(asked).toEqual(["create_goal"])
    expect(accounted).toEqual(
      [earlier, later]
        .sort((left, right) => left.info.id.localeCompare(right.info.id))
        .map((message) => message.info.id),
    )
    expect(JSON.stringify(output)).toContain("Goal: Create the requested artifact")
    expect(JSON.stringify(output)).toContain("Tokens: 0/18000")

    const planTools = yield* SessionTools.resolve({
      agent: { ...agent, name: "plan" },
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      goal,
    })
    expect(planTools.create_goal).toBeUndefined()
  }),
)

it.effect("cancels create_goal while it is queued and never mutates after abort", () =>
  Effect.gen(function* () {
    const parentID = MessageID.ascending()
    const semaphore = yield* Semaphore.make(1)
    const holding = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const queued = yield* Deferred.make<void>()
    const holder = yield* semaphore
      .withPermit(
        Effect.gen(function* () {
          yield* Deferred.succeed(holding, undefined)
          yield* Deferred.await(release)
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(holding)

    let attempts = 0
    let mutations = 0
    const created: Goal.State = {
      id: "goal-cancelled-call",
      sessionID,
      objective: "Do not create after cancellation",
      status: "active",
      iteration: 1,
      startedAt: 1,
      updatedAt: 1,
      completionCriteria: [],
      plan: [],
      observations: [],
      failures: [],
      recentHashes: [],
      replanned: false,
      parentID,
    }
    const goal = {
      get: () => Effect.succeed(undefined),
      creationRevision: () => 0,
      create: () =>
        Effect.gen(function* () {
          attempts++
          yield* Deferred.succeed(queued, undefined)
          return yield* semaphore.withPermit(
            Effect.sync(() => {
              mutations++
              return created
            }),
          )
        }),
      account: () => Effect.void,
    } as unknown as Goal.Interface
    const assistant = {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID,
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    } satisfies SessionV1.Assistant
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      goal,
    })
    const execute = tools.create_goal?.execute
    if (!execute) throw new Error("create_goal tool is missing execute")
    const args = { objective: "Do not create after cancellation" }
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const early = yield* Effect.promise(() =>
      settle(execute(args, { toolCallId: callID, abortSignal: alreadyAborted.signal, messages: [] })),
    )
    expect(early.ok).toBe(false)
    expect(attempts).toBe(0)

    const controller = new AbortController()
    const pending = settle(execute(args, { toolCallId: callID, abortSignal: controller.signal, messages: [] }))
    yield* Deferred.await(queued)
    controller.abort()
    const cancelled = yield* Effect.promise(() => pending)
    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.error).toMatchObject({ name: "AbortError" })
    expect(mutations).toBe(0)

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    expect(mutations).toBe(0)
  }),
)
