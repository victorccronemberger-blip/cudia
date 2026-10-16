import { expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { SessionID } from "@/session/schema"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { WorkflowSessions } from "@/session/llm/workflow"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

type ModelRecord = {
  readonly model: GitLabWorkflowLanguageModel
  stopped: number
  reset: number
}

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value?: T) => void
}

type Harness = {
  readonly models: ModelRecord[]
  languageCalls: number
  directory: string
  factory?: (directory: string) => GitLabWorkflowLanguageModel
  factoryEffect?: () => Effect.Effect<GitLabWorkflowLanguageModel>
  readonly service: typeof WorkflowSessions.Service
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve: (value) => resolve(value as T) }
}

function createModel(harness: Harness) {
  const model = new GitLabWorkflowLanguageModel(
    "duo-workflow-sonnet-4-6",
    {
      provider: "gitlab.workflow",
      instanceUrl: "https://gitlab.invalid",
      getHeaders: () => ({}),
      fetch: Object.assign(
        async () => {
          throw new Error("Unexpected network request in WorkflowSessions test")
        },
        { preconnect: async () => undefined },
      ),
    },
    { workingDirectory: harness.directory, projectId: "group/project" },
  )
  const record = { model, stopped: 0, reset: 0 }
  Reflect.set(model, "stopWorkflow", () => record.stopped++)
  Reflect.set(model, "resetWorkflow", () => record.reset++)
  harness.models.push(record)
  return model
}

function makeHarness(limit = 128) {
  const harness = { models: [], languageCalls: 0, directory: "", service: WorkflowSessions.Service } as Harness
  const fake = ProviderTest.fake({
    getLanguage: (_model, options) =>
      Effect.gen(function* () {
        expect(options?.cache).toBe(false)
        harness.languageCalls++
        return yield* harness.factoryEffect
          ? harness.factoryEffect()
          : Effect.sync(() => (harness.factory ? harness.factory(harness.directory) : createModel(harness)))
      }),
  })
  const layer = AppNodeBuilder.build(LayerNode.group([WorkflowSessions.node, EventV2.node]), [
    [Provider.node, fake.layer],
    [RuntimeFlags.node, RuntimeFlags.layer({ workflowSessionLimit: limit })],
  ])
  return { harness, it: testEffect(layer) }
}

function scenario<E>(
  name: string,
  body: (
    harness: Harness,
  ) => Effect.Effect<void, E, WorkflowSessions.Service | EventV2.Service | InstanceStore.Service | Scope.Scope>,
  limit = 128,
) {
  const { harness, it } = makeHarness(limit)
  it.instance(name, () =>
    Effect.gen(function* () {
      harness.directory = (yield* TestInstance).directory
      yield* body(harness)
    }),
  )
}

function input(harness: Harness, sessionID: string, controller = new AbortController()) {
  return {
    sessionID,
    model: ProviderTest.model(),
    template: createModel(harness),
    controller,
  }
}

function acquire(harness: Harness, value: ReturnType<typeof input>, complete = false) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* harness.service
      const lease = yield* sessions.acquire(value)
      if (complete) lease.complete()
      return lease
    }),
  )
}

type TestLease = { model: GitLabWorkflowLanguageModel; current: () => boolean; complete: () => void }

function hold(
  harness: Harness,
  value: ReturnType<typeof input>,
  waiting: Deferred<void>,
  ready: Deferred<TestLease>,
  release?: Deferred<void>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* harness.service
      waiting.resolve()
      const lease = yield* sessions.acquire(value)
      ready.resolve(lease)
      if (release) yield* Effect.promise(() => release.promise)
      else yield* Effect.never
    }),
  )
}

scenario("completed workflow leases retain one model per session and isolate concurrent sessions", (harness) =>
  Effect.gen(function* () {
    const first = yield* acquire(harness, input(harness, "session-a"), true)
    const second = yield* acquire(harness, input(harness, "session-a"), true)
    const other = yield* acquire(harness, input(harness, "session-b"), true)

    expect(first.model).toBe(second.model)
    expect(other.model).not.toBe(first.model)
    expect(harness.models.filter((item) => item.model === first.model)).toHaveLength(1)
    expect(harness.models.find((item) => item.model === first.model)?.stopped).toBe(0)
  }),
)

scenario(
  "same-session callers queue, waiter interruption preserves the active model, and incomplete release retires it",
  (harness) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const firstController = new AbortController()
      const firstWaiting = deferred()
      const firstReady = deferred<TestLease>()
      const firstRelease = deferred()
      const firstFiber = yield* hold(
        harness,
        input(harness, "session-queued", firstController),
        firstWaiting,
        firstReady,
        firstRelease,
      ).pipe(Effect.forkIn(scope))
      const active = yield* Effect.promise(() => firstReady.promise)

      const waiter = deferred()
      const waiterReady = deferred<TestLease>()
      const secondFiber = yield* hold(harness, input(harness, "session-queued"), waiter, waiterReady).pipe(
        Effect.forkIn(scope),
      )
      yield* Effect.promise(() => waiter.promise)
      expect(active.current()).toBe(true)
      yield* Fiber.interrupt(secondFiber)
      expect(harness.models.find((item) => item.model === active.model)?.stopped).toBe(0)

      const nextWaiting = deferred()
      const nextReady = deferred<TestLease>()
      const nextRelease = deferred()
      const nextFiber = yield* hold(
        harness,
        input(harness, "session-queued"),
        nextWaiting,
        nextReady,
        nextRelease,
      ).pipe(Effect.forkIn(scope))
      yield* Effect.promise(() => nextWaiting.promise)
      active.complete()
      firstRelease.resolve()
      yield* Fiber.join(firstFiber)
      const queuedNext = yield* Effect.promise(() => nextReady.promise)
      expect(firstController.signal.aborted).toBe(true)
      expect(queuedNext.model).toBe(active.model)
      queuedNext.complete()
      nextRelease.resolve()
      yield* Fiber.join(nextFiber)

      const cancelController = new AbortController()
      const cancelWaiting = deferred()
      const cancelReady = deferred<TestLease>()
      const cancelFiber = yield* hold(
        harness,
        input(harness, "session-queued", cancelController),
        cancelWaiting,
        cancelReady,
      ).pipe(Effect.forkIn(scope))
      const cancelActive = yield* Effect.promise(() => cancelReady.promise)
      expect(cancelActive.model).toBe(active.model)

      const queuedWaiting = deferred()
      const queuedReady = deferred<TestLease>()
      const queuedRelease = deferred()
      const queuedFiber = yield* hold(
        harness,
        input(harness, "session-queued"),
        queuedWaiting,
        queuedReady,
        queuedRelease,
      ).pipe(Effect.forkIn(scope))
      yield* Effect.promise(() => queuedWaiting.promise)
      cancelController.abort(new Error("active owner cancelled"))
      yield* Fiber.interrupt(cancelFiber)
      expect(cancelActive.current()).toBe(false)
      expect(harness.models.find((item) => item.model === active.model)?.stopped).toBe(1)
      const afterCancel = yield* Effect.promise(() => queuedReady.promise)
      expect(afterCancel.model).not.toBe(active.model)
      expect(afterCancel.current()).toBe(true)
      afterCancel.complete()
      queuedRelease.resolve()
      yield* Fiber.join(queuedFiber)
    }),
)

scenario(
  "capacity preserves cached entries when the limit is reached",
  (harness) =>
    Effect.gen(function* () {
      const first = yield* acquire(harness, input(harness, "session-capacity"), true).pipe(Effect.exit)
      expect(Exit.isSuccess(first)).toBe(true)
      if (Exit.isFailure(first)) return
      const cached = first.value
      const denied = yield* acquire(harness, input(harness, "session-full")).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)

      const existingExit = yield* acquire(harness, input(harness, "session-capacity"), true).pipe(Effect.exit)
      expect(Exit.isSuccess(existingExit)).toBe(true)
      if (Exit.isFailure(existingExit)) return
      const existing = existingExit.value
      expect(existing.model).toBe(cached.model)
    }),
  1,
)

scenario(
  "a pre-aborted acquisition releases an empty entry and frees its capacity slot",
  (harness) =>
    Effect.gen(function* () {
      const failedController = new AbortController()
      failedController.abort(new Error("cancel before factory"))
      const failure = yield* acquire(harness, input(harness, "session-empty-failure", failedController)).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isFailure(failure)) {
        const message = Cause.prettyErrors(failure.cause).join("\n")
        expect(message).toContain("cancel before factory")
        expect(message).not.toContain("Workflow session/model capacity reached")
      }

      const released = yield* acquire(harness, input(harness, "session-after-failure"), true)
      expect(released.model).toBeDefined()
    }),
  1,
)

for (const action of ["deletion", "disposal"] as const)
  scenario(
    `${action} during provider construction retires the orphan and releases capacity`,
    (harness) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const factoryEntered = deferred()
        const factoryResult = deferred<GitLabWorkflowLanguageModel>()
        harness.factoryEffect = () =>
          Effect.promise(() => {
            factoryEntered.resolve()
            return factoryResult.promise
          })
        const controller = new AbortController()
        const pending = Effect.scoped(
          Effect.gen(function* () {
            const sessions = yield* harness.service
            return yield* sessions.acquire(input(harness, "session-pending-delete", controller))
          }),
        ).pipe(Effect.exit)
        const fiber = yield* pending.pipe(Effect.forkIn(scope))
        yield* Effect.promise(() => factoryEntered.promise)

        if (action === "disposal") {
          const ctx = yield* InstanceRef
          if (!ctx) return yield* Effect.die(new Error("Missing test InstanceRef"))
          const store = yield* InstanceStore.Service
          yield* store.dispose(ctx)
        } else {
          const events = yield* EventV2.Service
          yield* events.publish(SessionV1.Event.Deleted, {
            sessionID: SessionID.make("session-pending-delete"),
            info: SessionV1.SessionInfo.make({
              id: SessionID.make("session-pending-delete"),
              slug: "pending-deleted-session",
              projectID: Project.ID.make("test-project"),
              directory: harness.directory,
              title: "Pending deleted session",
              version: "test",
              time: { created: 0, updated: 0 },
            }),
          })
        }
        expect(controller.signal.aborted).toBe(true)

        const orphan = createModel(harness)
        factoryResult.resolve(orphan)
        const result = yield* Fiber.join(fiber)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.prettyErrors(result.cause).join("\n")).toContain("session-pending-delete")
        }
        const record = harness.models.find((item) => item.model === orphan)
        expect(record?.stopped).toBe(1)
        expect(record?.reset).toBe(1)

        harness.factoryEffect = undefined
        const store = yield* InstanceStore.Service
        const next = yield* store.provide(
          { directory: harness.directory },
          acquire(harness, input(harness, "session-after-pending-delete"), true).pipe(Effect.exit),
        )
        expect(Exit.isSuccess(next)).toBe(true)
      }),
    1,
  )

scenario(
  "session deletion aborts its owner, retires its model, and frees capacity",
  (harness) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const controller = new AbortController()
      const waiting = deferred()
      const ready = deferred<{ model: GitLabWorkflowLanguageModel; current: () => boolean; complete: () => void }>()
      const fiber = yield* hold(harness, input(harness, "session-deleted", controller), waiting, ready).pipe(
        Effect.forkIn(scope),
      )
      const active = yield* Effect.promise(() => ready.promise)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID: SessionID.make("session-deleted"),
        info: SessionV1.SessionInfo.make({
          id: SessionID.make("session-deleted"),
          slug: "deleted-session",
          projectID: Project.ID.make("test-project"),
          directory: harness.directory,
          title: "Deleted session",
          version: "test",
          time: { created: 0, updated: 0 },
        }),
      })

      expect(controller.signal.aborted).toBe(true)
      expect(active.current()).toBe(false)
      expect(harness.models.find((item) => item.model === active.model)?.stopped).toBe(1)
      const next = yield* acquire(harness, input(harness, "session-after-delete"), true)
      expect(next.model).not.toBe(active.model)
      yield* Fiber.interrupt(fiber)
    }),
  1,
)

scenario(
  "deletion closes a queued waiter after aborting its owner without creating a replacement",
  (harness) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const ownerController = new AbortController()
      const ownerWaiting = deferred()
      const ownerReady = deferred<TestLease>()
      const ownerFiber = yield* hold(
        harness,
        input(harness, "session-delete-queued", ownerController),
        ownerWaiting,
        ownerReady,
      ).pipe(Effect.forkIn(scope))
      const owner = yield* Effect.promise(() => ownerReady.promise)
      const languageCalls = harness.languageCalls

      const waiterStarted = deferred()
      const waiterExit = deferred<Exit.Exit<TestLease, unknown>>()
      const waiterFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* harness.service
          waiterStarted.resolve()
          const result = yield* sessions.acquire(input(harness, "session-delete-queued")).pipe(Effect.exit)
          waiterExit.resolve(result)
        }),
      ).pipe(Effect.forkIn(scope))
      yield* Effect.promise(() => waiterStarted.promise)

      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID: SessionID.make("session-delete-queued"),
        info: SessionV1.SessionInfo.make({
          id: SessionID.make("session-delete-queued"),
          slug: "queued-deleted-session",
          projectID: Project.ID.make("test-project"),
          directory: harness.directory,
          title: "Queued deleted session",
          version: "test",
          time: { created: 0, updated: 0 },
        }),
      })
      expect(ownerController.signal.aborted).toBe(true)
      expect(owner.current()).toBe(false)
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)))

      yield* Fiber.interrupt(ownerFiber)
      const result = yield* Effect.promise(() => waiterExit.promise)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.prettyErrors(result.cause).join("\n")).toContain("session-delete-queued")
      }
      yield* Fiber.join(waiterFiber)
      expect(harness.languageCalls).toBe(languageCalls)
      expect(harness.models.find((item) => item.model === owner.model)?.stopped).toBeGreaterThanOrEqual(1)

      const replacement = yield* acquire(harness, input(harness, "session-after-queued-delete"), true).pipe(Effect.exit)
      expect(Exit.isSuccess(replacement)).toBe(true)
    }),
  1,
)

scenario("disposing an instance through InstanceStore releases and retires its workflow leases", (harness) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const controller = new AbortController()
    const waiting = deferred()
    const ready = deferred<TestLease>()
    const fiber = yield* hold(harness, input(harness, "session-instance-disposed", controller), waiting, ready).pipe(
      Effect.forkIn(scope),
    )
    const active = yield* Effect.promise(() => ready.promise)
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die(new Error("Missing test InstanceRef"))
    const store = yield* InstanceStore.Service
    yield* store.dispose(ctx)

    expect(controller.signal.aborted).toBe(true)
    expect(active.current()).toBe(false)
    expect(harness.models.find((item) => item.model === active.model)?.stopped).toBe(1)
    const replacement = yield* acquire(harness, input(harness, "session-after-dispose"), true)
    expect(replacement.model).not.toBe(active.model)
    yield* Fiber.interrupt(fiber)
  }),
)

scenario("a shared factory model is rejected without changing its existing request bindings", (harness) =>
  Effect.gen(function* () {
    const shared = createModel(harness)
    shared.systemPrompt = "existing binding"
    harness.factory = () => shared
    const first = yield* acquire(harness, { ...input(harness, "session-shared"), template: shared }, true).pipe(
      Effect.catchTag("WorkflowFactoryError", () => Effect.succeed(undefined)),
    )
    expect(first).toBeUndefined()
    expect(shared.systemPrompt).toBe("existing binding")
    expect(shared.sessionID).toBe("")
  }),
)
