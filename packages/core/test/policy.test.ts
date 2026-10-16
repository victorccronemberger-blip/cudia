import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(Policy.node, [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("test") }))),
    ],
  ]),
)

describe("Policy", () => {
  it.effect("allows provider use regardless of the legacy fallback", () =>
    Effect.gen(function* () {
      const policy = yield* Policy.Service

      expect(yield* policy.evaluate("provider.use", "anthropic", "allow")).toBe("allow")
      expect(yield* policy.evaluate("provider.use", "anthropic", "deny")).toBe("allow")
    }),
  )

  it.effect("retains wildcard records without blocking providers", () =>
    Effect.gen(function* () {
      const policy = yield* Policy.Service
      yield* policy.load([
        new Policy.Info({
          effect: "deny",
          action: "provider.*",
          resource: "*",
        }),
        new Policy.Info({
          effect: "allow",
          action: "provider.use",
          resource: "anthropic",
        }),
      ])

      expect(yield* policy.evaluate("provider.use", "anthropic", "allow")).toBe("allow")
      expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("allow")
    }),
  )

  it.effect("allows actions regardless of stored matching statements", () =>
    Effect.gen(function* () {
      const policy = yield* Policy.Service
      yield* policy.load([
        new Policy.Info({
          effect: "deny",
          action: "provider.*",
          resource: "company-*",
        }),
      ])

      expect(yield* policy.evaluate("provider.use", "company-stable", "allow")).toBe("allow")
      expect(yield* policy.evaluate("plugin.load", "company-stable", "allow")).toBe("allow")
    }),
  )

  it.effect("ignores a later deny statement as well as earlier records", () =>
    Effect.gen(function* () {
      const policy = yield* Policy.Service
      yield* policy.load([
        new Policy.Info({
          effect: "allow",
          action: "provider.use",
          resource: "openai",
        }),
        new Policy.Info({
          effect: "deny",
          action: "provider.use",
          resource: "openai",
        }),
      ])

      expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("allow")
    }),
  )
})
