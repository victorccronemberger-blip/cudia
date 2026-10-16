import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore } from "effect"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"

export class CapacityError extends Schema.TaggedErrorClass<CapacityError>()("WorkflowCapacityError", {
  limit: Schema.Number,
}) {
  override get message() {
    return `Workflow session/model capacity reached (${this.limit}). Existing entries remain available. Remove unused sessions or increase CUDIA_WORKFLOW_SESSION_LIMIT.`
  }
}

export class ClosedError extends Schema.TaggedErrorClass<ClosedError>()("WorkflowClosedError", {
  sessionID: Schema.String,
}) {
  override get message() {
    return `Workflow session is no longer active: ${this.sessionID}`
  }
}

export class FactoryError extends Schema.TaggedErrorClass<FactoryError>()("WorkflowFactoryError", {
  message: Schema.String,
}) {}

export type Lease = {
  readonly model: GitLabWorkflowLanguageModel
  readonly current: () => boolean
  readonly complete: () => void
}

type Owner = {
  readonly controller: AbortController
  model?: GitLabWorkflowLanguageModel
  completed: boolean
}

type Entry = {
  readonly key: string
  readonly sessionID: string
  readonly lock: Semaphore.Semaphore
  model?: GitLabWorkflowLanguageModel
  owner?: Owner
  disposed: boolean
  users: number
}

export interface Interface {
  readonly acquire: (input: {
    readonly sessionID: string
    readonly model: Provider.Model
    readonly template: GitLabWorkflowLanguageModel
    readonly controller: AbortController
  }) => Effect.Effect<Lease, CapacityError | ClosedError | FactoryError | Provider.ModelNotFoundError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowSessions") {}

const inactive = async () => {
  throw new DOMException("Workflow call is no longer active", "AbortError")
}

// A non-null rejecting executor prevents a retired call from enabling the
// dependency's unconfigured-executor path. No request prompt is retained here.
const detach = (model: GitLabWorkflowLanguageModel) =>
  Effect.try({
    try: () => {
      model.toolExecutor = inactive
      model.approvalHandler = inactive
      model.systemPrompt = null
      model.sessionPreapprovedTools = []
    },
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.logWarning("failed to detach workflow request bindings")))

const retire = (model: GitLabWorkflowLanguageModel) =>
  Effect.try({
    try: () => {
      model.stopWorkflow()
      model.resetWorkflow()
    },
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.logWarning("failed to stop an owned workflow")))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const limit = flags.workflowSessionLimit ?? 128
    const used = new WeakSet<GitLabWorkflowLanguageModel>()
    const state = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        const entries = new Map<string, Entry>()
        const lifecycle = { closed: false }

        const dispose = Effect.fn("WorkflowSessions.dispose")(function* (entry: Entry) {
          entry.disposed = true
          entry.owner?.controller.abort(new DOMException("Workflow session disposed", "AbortError"))
          const model = entry.model
          entry.model = undefined
          if (!model) return
          yield* detach(model)
          yield* retire(model)
        })

        const off = yield* events.listen((event) =>
          Effect.gen(function* () {
            if (event.type !== SessionV1.Event.Deleted.type) return
            if (event.location && event.location.directory !== ctx.directory) return
            const sessionID = (event.data as { sessionID: string }).sessionID
            const selected = [...entries.values()].filter((entry) => entry.sessionID === sessionID)
            for (const entry of selected) {
              entries.delete(entry.key)
              yield* dispose(entry)
            }
          }),
        )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            lifecycle.closed = true
            yield* off
            for (const entry of entries.values()) yield* dispose(entry)
            entries.clear()
          }),
        )
        return { entries, used, lifecycle }
      }),
    )

    const acquire: Interface["acquire"] = Effect.fn("WorkflowSessions.acquire")(function* (input) {
      const s = yield* InstanceState.get(state)
      const key = JSON.stringify([input.sessionID, input.model.providerID, input.model.id])
      const existing = s.entries.get(key)
      if (!existing && s.entries.size >= limit) return yield* new CapacityError({ limit })
      const entry: Entry = existing ?? {
        key,
        sessionID: input.sessionID,
        lock: Semaphore.makeUnsafe(1),
        disposed: false,
        users: 0,
      }
      if (!existing) s.entries.set(key, entry)

      yield* Effect.acquireRelease(
        Effect.sync(() => entry.users++),
        () =>
          Effect.sync(() => {
            entry.users--
            if (entry.users === 0 && !entry.model && s.entries.get(key) === entry) s.entries.delete(key)
          }),
      )
      const owner = yield* Effect.acquireRelease(
        entry.lock
          .take(1)
          .pipe(Effect.interruptible, Effect.as({ controller: input.controller, completed: false } as Owner)),
        (owner, exit) =>
          Effect.gen(function* () {
            if (entry.owner !== owner) return
            entry.owner = undefined
            if (!owner.model) return
            const invalid =
              !owner.completed || Exit.isFailure(exit) || owner.controller.signal.aborted || entry.disposed
            if (invalid && entry.model === owner.model) entry.model = undefined
            yield* detach(owner.model)
            // Quiesce the previous invocation before another waiter can install
            // bindings on a retained model. Normal EOF keeps its remote identity.
            owner.controller.abort(new DOMException("Workflow call finished", "AbortError"))
            if (invalid) yield* retire(owner.model)
          }).pipe(Effect.ensuring(entry.lock.release(1))),
      )

      const valid = () => !s.lifecycle.closed && !entry.disposed && s.entries.get(key) === entry
      if (!valid()) return yield* new ClosedError({ sessionID: input.sessionID })
      input.controller.signal.throwIfAborted()
      entry.owner = owner
      const language = entry.model ?? (yield* provider.getLanguage(input.model, { cache: false }))
      if (
        (!valid() || input.controller.signal.aborted) &&
        language instanceof GitLabWorkflowLanguageModel &&
        language !== input.template &&
        !s.used.has(language)
      ) {
        s.used.add(language)
        yield* detach(language)
        yield* retire(language)
      }
      if (!valid()) return yield* new ClosedError({ sessionID: input.sessionID })
      input.controller.signal.throwIfAborted()
      if (!(language instanceof GitLabWorkflowLanguageModel))
        return yield* new FactoryError({ message: "Workflow factory returned an incompatible language model." })
      if (!entry.model && (language === input.template || s.used.has(language)))
        return yield* new FactoryError({
          message: "Workflow factory returned a shared model; session isolation failed.",
        })
      s.used.add(language)
      entry.model = language
      owner.model = language
      return {
        model: language,
        current: () => valid() && entry.owner === owner && !input.controller.signal.aborted,
        complete: () => {
          owner.completed = true
        },
      }
    })

    return Service.of({ acquire })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Provider.node, EventV2Bridge.node, RuntimeFlags.node],
})

export * as WorkflowSessions from "./workflow"
