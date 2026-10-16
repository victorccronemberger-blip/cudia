import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { tool } from "ai"
import z from "zod"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function scenario(
  name: string,
  body: (
    f: ReturnType<typeof fixture>,
  ) => Effect.Effect<void, unknown, LLM.Service | EventV2Bridge.Service | TestInstance>,
) {
  const f = fixture()
  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([LLM.node, EventV2Bridge.node]), [
      [Provider.node, f.provider.layer],
      [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
      [
        Plugin.node,
        Layer.succeed(
          Plugin.Service,
          Plugin.Service.of({
            trigger: (_name, _input, output) => Effect.succeed(output),
            list: () => Effect.succeed([]),
            init: () => Effect.void,
          }),
        ),
      ],
    ]),
  )
  it.instance(name, () => body(f), { config: { permission: { "*": "deny" } } })
}

function fixture() {
  const calls: {
    model: GitLabWorkflowLanguageModel
    signal?: AbortSignal
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>
  }[] = []
  const pending = new Map<number, ReturnType<typeof deferred>>()
  const models: GitLabWorkflowLanguageModel[] = []
  const stopped: GitLabWorkflowLanguageModel[] = []
  const make = () => {
    const model = new GitLabWorkflowLanguageModel(
      "workflow-test",
      {
        provider: "gitlab.workflow",
        instanceUrl: "https://gitlab.invalid",
        getHeaders: () => ({}),
        fetch: Object.assign(
          async () => {
            throw new Error("Unexpected workflow network request")
          },
          { preconnect: () => {} },
        ),
      },
      { projectId: "test/project" },
    )
    model.stopWorkflow = () => {
      stopped.push(model)
    }
    model.doStream = async (options) => {
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          calls.push({ model, signal: options.abortSignal, controller })
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "answer" })
          controller.enqueue({ type: "text-delta", id: "answer", delta: "ready" })
          pending.get(calls.length)?.resolve()
        },
      })
      return { stream }
    }
    return model
  }
  const template = make()
  const model = ProviderTest.model({
    providerID: ProviderV2.ID.make("gitlab"),
    id: ModelV2.ID.make("workflow-test"),
    api: { id: "workflow-test", npm: "gitlab-ai-provider", url: "https://gitlab.invalid" },
  })
  const provider = ProviderTest.fake({
    model,
    getLanguage: (_model, options) =>
      Effect.sync(() => {
        if (options?.cache !== false) return template
        const next = make()
        models.push(next)
        return next
      }),
  })
  const wait = (count: number) =>
    Effect.promise(() => {
      if (calls.length >= count) return Promise.resolve()
      const next = deferred()
      pending.set(count, next)
      return next.promise
    })
  const input = (session: string, label: string): LLM.StreamInput => ({
    sessionID: session,
    model,
    user: {
      id: MessageID.make(`msg_${label}`),
      sessionID: SessionID.make(session),
      role: "user",
      time: { created: 0 },
      agent: "test",
      model: { providerID: model.providerID, modelID: model.id },
    },
    agent: {
      name: "test",
      mode: "primary",
      prompt: `prompt-${label}`,
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    },
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
    system: [],
    messages: [{ role: "user", content: `message-${label}` }],
    tools: {
      [label]: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => `${label}:${value}`,
      }),
    },
  })
  const finish = (index: number) =>
    Effect.sync(() => {
      const controller = calls[index].controller
      controller.enqueue({ type: "text-end", id: "answer" })
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      })
      controller.close()
    })
  return { template, provider, calls, models, stopped, wait, input, finish }
}

scenario("workflow calls isolate session bindings and ignore legacy ask/deny rules", (f) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const a = yield* llm.stream(f.input("ses_A", "A")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(1)
    const b = yield* llm.stream(f.input("ses_B", "B")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(2)
    const first = f.calls[0].model
    const second = f.calls[1].model
    expect(first).not.toBe(second)
    expect(first.sessionID).toBe("ses_A")
    expect(second.sessionID).toBe("ses_B")
    expect(first.systemPrompt).toBe("prompt-A")
    expect(second.systemPrompt).toBe("prompt-B")
    expect(first.sessionPreapprovedTools).toEqual(["A"])
    expect(second.sessionPreapprovedTools).toEqual(["B"])
    expect(yield* Effect.promise(() => first.approvalHandler!([{ name: "remote", args: "not-json" }]))).toEqual({
      approved: true,
    })
    expect(yield* Effect.promise(() => first.toolExecutor!("A", '{"value":"one"}', "req_A"))).toEqual({
      result: "A:one",
      metadata: undefined,
      title: undefined,
    })
    expect(yield* Effect.promise(() => second.toolExecutor!("B", '{"value":"two"}', "req_B"))).toEqual({
      result: "B:two",
      metadata: undefined,
      title: undefined,
    })
    expect(yield* Effect.promise(() => first.toolExecutor!("B", "{}", "wrong"))).toEqual({
      result: "",
      error: "Unknown tool: B",
    })
    expect(f.template.sessionID).not.toBe("ses_A")
    expect(f.template.systemPrompt).toBeNull()
    yield* f.finish(0)
    yield* f.finish(1)
    yield* Fiber.join(a)
    yield* Fiber.join(b)
    expect(first.systemPrompt).toBeNull()
    expect(first.sessionPreapprovedTools).toEqual([])
    expect(f.stopped).toEqual([])
  }),
)

scenario("workflow lease spans the full stream, retains normal sessions, and rejects stale callbacks", (f) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const a = yield* llm.stream(f.input("ses_same", "A")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(1)
    const first = f.calls[0].model
    const stale = first.toolExecutor!
    const approval = Object.getOwnPropertyDescriptor(GitLabWorkflowLanguageModel.prototype, "approvalHandler")!
    let observedNextBinding = false
    Object.defineProperty(first, "approvalHandler", {
      configurable: true,
      get() {
        return approval.get!.call(first)
      },
      set(value) {
        if (first.systemPrompt === "prompt-B") {
          observedNextBinding = true
          expect(f.calls[0].signal?.aborted).toBe(true)
        }
        approval.set!.call(first, value)
      },
    })
    const b = yield* llm.stream(f.input("ses_same", "B")).pipe(Stream.runDrain, Effect.forkChild)
    yield* Effect.yieldNow
    expect(f.calls.length).toBe(1)
    expect(first.systemPrompt).toBe("prompt-A")
    yield* f.finish(0)
    yield* Fiber.join(a)
    yield* f.wait(2)
    expect(f.calls[1].model).toBe(first)
    expect(first.systemPrompt).toBe("prompt-B")
    expect(observedNextBinding).toBe(true)
    yield* Effect.promise(async () => {
      await expect(stale("A", '{"value":"late"}', "old")).rejects.toThrow("no longer active")
    })
    expect(f.calls[0].signal?.aborted).toBe(true)
    yield* f.finish(1)
    yield* Fiber.join(b)
    expect(f.models.length).toBe(1)
    expect(f.stopped).toEqual([])
  }),
)

scenario("early consumer exit and active interruption retire workflow instances", (f) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    yield* llm.stream(f.input("ses_cancel", "A")).pipe(Stream.take(1), Stream.runDrain)
    expect(f.stopped).toEqual([f.calls[0].model])
    const a = yield* llm.stream(f.input("ses_cancel", "B")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(2)
    expect(f.calls[1].model).not.toBe(f.calls[0].model)
    yield* Fiber.interrupt(a)
    const exit = yield* Fiber.await(a)
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(f.calls[1].signal?.aborted).toBe(true)
    expect(f.stopped).toEqual([f.calls[0].model, f.calls[1].model])
    const b = yield* llm.stream(f.input("ses_cancel", "C")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(3)
    expect(f.models.length).toBe(3)
    yield* f.finish(2)
    yield* Fiber.join(b)
  }),
)

scenario("deleting a workflow session interrupts its pending stream without stopping another session", (f) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const a = yield* llm.stream(f.input("ses_deleted", "A")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(1)
    const b = yield* llm.stream(f.input("ses_survives", "B")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(2)
    yield* events.publish(SessionV1.Event.Deleted, {
      sessionID: SessionID.make("ses_deleted"),
      info: {
        id: SessionID.make("ses_deleted"),
        slug: "deleted",
        projectID: Project.ID.make("test-project"),
        directory: (yield* TestInstance).directory,
        title: "Deleted",
        version: "test",
        time: { created: 0, updated: 0 },
      },
    })
    const exit = yield* Fiber.await(a)
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(f.calls[0].signal?.aborted).toBe(true)
    expect(f.calls[1].signal?.aborted).toBe(false)
    expect(f.calls[1].model.systemPrompt).toBe("prompt-B")
    expect(f.stopped).not.toContain(f.calls[1].model)
    yield* f.finish(1)
    yield* Fiber.join(b)
  }),
)

scenario("workflow stream errors retire the failed model and surface the original cause", (f) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const a = yield* llm.stream(f.input("ses_error", "A")).pipe(Stream.runDrain, Effect.exit, Effect.forkChild)
    yield* f.wait(1)
    const failure = new Error("local workflow transport failure")
    f.calls[0].controller.enqueue({ type: "error", error: failure })
    f.calls[0].controller.close()
    const exit = yield* Fiber.join(a)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
    expect(f.stopped).toContain(f.calls[0].model)
    const b = yield* llm.stream(f.input("ses_error", "B")).pipe(Stream.runDrain, Effect.forkChild)
    yield* f.wait(2)
    expect(f.calls[1].model).not.toBe(f.calls[0].model)
    yield* f.finish(1)
    yield* Fiber.join(b)
  }),
)
