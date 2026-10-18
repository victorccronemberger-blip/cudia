import { expect } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { testEffect } from "../lib/effect"

type HookProvider = Parameters<NonNullable<NonNullable<Hooks["provider"]>["models"]>>[0]

const failedProvider = ProviderV2.ID.anthropic
const failedModel = ModelV2.ID.make("claude-sonnet-4-6")
const healthyProvider = ProviderV2.ID.make("isolation-compatible")
const healthyModel = ModelV2.ID.make("healthy-model")
const apiAuth = { type: "api", key: "synthetic-test-key" } as const

function suite(options: {
  models?: (provider: HookProvider) => Promise<Record<string, never>>
  authLoader?: () => Promise<Record<string, never>>
  authGetFailure?: string
  storedAuth?: boolean
}) {
  const state = { modelCalls: 0, loaderCalls: 0, authMutations: 0, authGets: 0 }
  const hooks = [
    {
      ...(options.models && {
        provider: {
          id: String(failedProvider),
          models: async (provider: HookProvider) => {
            state.modelCalls++
            return options.models!(provider)
          },
        },
      }),
      ...(options.authLoader && {
        auth: {
          provider: String(failedProvider),
          methods: [],
          loader: async () => {
            state.loaderCalls++
            return options.authLoader!()
          },
        },
      }),
    },
  ]

  const authLayer = Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: (id) => {
        state.authGets++
        if (options.authGetFailure === id) return Effect.fail(new Auth.AuthError({ message: "synthetic auth failure" }))
        if (options.storedAuth && id === failedProvider) return Effect.succeed(apiAuth)
        return Effect.succeed(undefined)
      },
      all: () => Effect.succeed(options.storedAuth ? { [failedProvider]: apiAuth } : {}),
      set: () => Effect.sync(() => void state.authMutations++),
      remove: () => Effect.sync(() => void state.authMutations++),
    }),
  )

  const pluginLayer = Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      trigger: (_name, _input, output) => Effect.succeed(output),
      list: () => Effect.succeed(hooks),
      init: () => Effect.void,
    }),
  )

  const test = testEffect(
    LayerNode.compile(Provider.node, [
      [Auth.node, authLayer],
      [Plugin.node, pluginLayer],
    ]),
  )

  return { test, state, failedModel, failedProvider, healthyModel, healthyProvider }
}

const healthyConfig = {
  enabled_providers: [String(failedProvider), String(healthyProvider)],
  provider: {
    anthropic: { options: { apiKey: "synthetic-anthropic-key" } },
    "isolation-compatible": {
      name: "Isolation Compatible",
      npm: "@ai-sdk/openai-compatible",
      api: "https://provider-isolation.example/v1",
      options: { apiKey: "synthetic-compatible-key" },
      models: { "healthy-model": { name: "Healthy model" } },
    },
  },
}

{
  const isolated = suite({
    models: () => Promise.reject(new Error("synthetic models failure before auth loader")),
    authLoader: () => Promise.resolve({}),
    storedAuth: true,
  })
  isolated.test.instance(
    "a failed models hook skips later auth loading and preserves its original cause",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect((yield* provider.list())[failedProvider]).toBeUndefined()
      expect(isolated.state.loaderCalls).toBe(0)

      const error = yield* provider.getModel(failedProvider, isolated.failedModel).pipe(Effect.flip)
      expect(Provider.InitError.isInstance(error.cause)).toBe(true)
      if (!Provider.InitError.isInstance(error.cause)) throw error
      expect(String(error.cause.cause)).toContain("synthetic models failure before auth loader")
    }),
    { config: healthyConfig },
  )
}

{
  const isolated = suite({
    models: (input) => {
      const model = input.models[failedModel]
      if (!model) throw new Error("expected catalog model is missing")
      model.name = "synthetic mutated model"
      input.models[ModelV2.ID.make("synthetic-injected-model")] = model
      return Promise.reject(new Error("synthetic failure after mutating hook input"))
    },
  })
  isolated.test.instance(
    "a failed mutating models hook leaves the retained catalog unchanged",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const catalog = (yield* provider.catalog())[failedProvider]
      const original = catalog.models[failedModel]
      expect(original).toBeDefined()
      expect(original?.name).not.toBe("synthetic mutated model")
      expect(catalog.models[ModelV2.ID.make("synthetic-injected-model")]).toBeUndefined()

      const error = yield* provider.getModel(failedProvider, failedModel).pipe(Effect.flip)
      expect(Provider.InitError.isInstance(error.cause)).toBe(true)
      if (!Provider.InitError.isInstance(error.cause)) throw error
      expect(String(error.cause.cause)).toContain("synthetic failure after mutating hook input")
    }),
    { config: healthyConfig },
  )
}

for (const [name, models] of [
  ["rejected", () => Promise.reject(new Error("synthetic models rejection"))],
  [
    "synchronous throw",
    () => {
      throw new Error("synthetic synchronous models failure")
    },
  ],
] as const) {
  const isolated = suite({ models })
  isolated.test.instance(
    `a ${name} provider models hook leaves healthy providers and the catalog available`,
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const catalog = yield* provider.catalog()
      const active = yield* provider.list()

      expect(catalog[failedProvider]).toBeDefined()
      expect(active[failedProvider]).toBeUndefined()
      expect(active[healthyProvider]?.models[healthyModel]).toBeDefined()
      expect((yield* provider.defaultModel()).providerID).toBe(healthyProvider)

      const failed = yield* provider.getModel(failedProvider, isolated.failedModel).pipe(Effect.flip)
      expect(Provider.ModelNotFoundError.isInstance(failed)).toBe(true)
      expect(failed.message).toContain("Provider unavailable")
      expect(Provider.InitError.isInstance(failed.cause)).toBe(true)

      const model = yield* provider.getModel(healthyProvider, isolated.healthyModel)
      expect(yield* provider.getLanguage(model)).toBeDefined()
      expect(isolated.state.authMutations).toBe(0)
    }),
    { config: healthyConfig },
  )
}

{
  const isolated = suite({
    authLoader: () => Promise.reject(new Error("synthetic auth loader failure")),
    storedAuth: true,
  })
  isolated.test.instance(
    "a rejected plugin auth loader only disables its provider",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect((yield* provider.catalog())[failedProvider]).toBeDefined()
      expect((yield* provider.list())[failedProvider]).toBeUndefined()
      expect((yield* provider.list())[healthyProvider]).toBeDefined()
      const error = yield* provider.getModel(failedProvider, isolated.failedModel).pipe(Effect.flip)
      expect(Provider.InitError.isInstance(error.cause)).toBe(true)
      expect(isolated.state.loaderCalls).toBe(1)
      expect(isolated.state.authMutations).toBe(0)
    }),
    { config: healthyConfig },
  )
}

{
  const isolated = suite({ authGetFailure: "sap-ai-core" })
  isolated.test.instance(
    "a custom loader auth failure is isolated to its provider",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const catalog = yield* provider.catalog()
      const active = yield* provider.list()
      expect(catalog[ProviderV2.ID.make("sap-ai-core")]).toBeDefined()
      expect(active[healthyProvider]).toBeDefined()
      expect(active[ProviderV2.ID.make("sap-ai-core")]).toBeUndefined()
      expect(isolated.state.authMutations).toBe(0)
    }),
    { config: healthyConfig },
  )
}

{
  const isolated = suite({ models: () => new Promise(() => {}) })
  isolated.test.instance(
    "cancelling provider discovery returns control to the caller",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const result = yield* provider
        .list()
        .pipe(Effect.timeoutOrElse({ duration: "50 millis", orElse: () => Effect.succeed(undefined) }))
      expect(result).toBeUndefined()
    }),
    { config: healthyConfig },
  )
}

{
  const isolated = suite({ models: () => new Promise(() => {}) })
  isolated.test.instance(
    "provider model discovery times out and records an unavailable provider",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const active = yield* provider.list()
      expect(active[failedProvider]).toBeUndefined()
      expect((yield* provider.catalog())[failedProvider]).toBeDefined()
      const error = yield* provider.getModel(failedProvider, isolated.failedModel).pipe(Effect.flip)
      expect(Provider.InitError.isInstance(error.cause)).toBe(true)
    }),
    { config: healthyConfig },
    30_000,
  )
}

{
  const isolated = suite({ models: () => Promise.reject(new Error("disabled hook must not run")) })
  isolated.test.instance(
    "disabled providers skip plugin discovery hooks",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect((yield* provider.catalog())[failedProvider]).toBeDefined()
      expect(isolated.state.modelCalls).toBe(0)
      expect((yield* provider.list())[failedProvider]).toBeUndefined()
    }),
    { config: { ...healthyConfig, disabled_providers: [String(failedProvider)] } },
  )
}
