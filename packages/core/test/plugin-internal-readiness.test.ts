import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Catalog } from "../src/catalog"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { ModelsDev } from "../src/models-dev"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { PluginInternal } from "../src/plugin/internal"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const entries = [
  new Config.Document({
    type: "document",
    path: "readiness-test-config",
    info: Schema.decodeUnknownSync(Config.Info)({
      model: "readiness/readiness-model",
      providers: {
        readiness: {
          name: "Readiness provider",
          models: {
            "readiness-model": { name: "Configured readiness model" },
          },
        },
      },
    }),
  }),
] satisfies Config.Entry[]

const readinessLayer = (options: { readonly models: ModelsDev.Interface }) =>
  AppNodeBuilder.build(LayerNode.group([PluginInternal.node, Catalog.node, Database.node, EventV2.node]), [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))],
    [ModelsDev.node, Layer.succeed(ModelsDev.Service, ModelsDev.Service.of(options.models))],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          Location.Info.make({
            directory: AbsolutePath.make(process.cwd()),
            project: {
              id: Project.ID.make("readiness"),
              directory: AbsolutePath.make(process.cwd()),
            },
          }),
        ),
      ),
    ],
  ])

function modelDefault() {
  return Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    return yield* catalog.model.default()
  })
}

describe("PluginInternal location readiness", () => {
  it.live("waits for configured provider registration before exposing the model default", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const observed = yield* Deferred.make<void>()
      const layer = readinessLayer({
        models: {
          get: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return {}
            }),
          refresh: () => Effect.void,
        },
      })
      const read = modelDefault().pipe(
        Effect.tap(() => Deferred.succeed(observed, undefined)),
        Effect.provide(layer),
      )
      const fiber = yield* Effect.forkScoped(read)

      // An early publication can close the scope before the background loader reaches the gate.
      const first = yield* Effect.raceFirst(
        Deferred.await(entered).pipe(Effect.as("initializing")),
        Deferred.await(observed).pipe(Effect.as("published")),
      )
      const early = yield* Deferred.isDone(observed)

      yield* Deferred.succeed(release, undefined)
      const model = yield* Fiber.join(fiber)
      expect(first).toBe("initializing")
      expect(early).toBe(false)
      expect(yield* Deferred.isDone(observed)).toBe(true)
      expect(model?.providerID).toBe(ProviderV2.ID.make("readiness"))
      expect(model?.id).toBe(ModelV2.ID.make("readiness-model"))
      expect(model?.name).toBe("Configured readiness model")
    }),
  )

  it.live("propagates a catalog bootstrap defect instead of exposing a fallback", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = readinessLayer({
        models: {
          get: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* Effect.die(new Error("readiness bootstrap defect"))
            }),
          refresh: () => Effect.void,
        },
      })
      const fiber = yield* Effect.forkScoped(modelDefault().pipe(Effect.provide(layer), Effect.exit))

      yield* Deferred.await(entered)
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("readiness bootstrap defect")
      }
    }),
  )

  it.live("honors cancellation after protected catalog initialization finishes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const observed = yield* Deferred.make<void>()
      const layer = readinessLayer({
        models: {
          get: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({})),
          refresh: () => Effect.void,
        },
      })
      const fiber = yield* Effect.forkScoped(
        modelDefault().pipe(
          Effect.tap(() => Deferred.succeed(observed, undefined)),
          Effect.provide(layer),
        ),
      )
      yield* Deferred.await(entered)
      // Request interruption without waiting for the protected acquisition to finish.
      yield* Effect.sync(() => fiber.interruptUnsafe())
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* Deferred.isDone(observed)).toBe(false)
    }),
  )
})
