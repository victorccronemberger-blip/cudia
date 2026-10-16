import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Installation } from "../../src/installation"
import { testEffect } from "../lib/effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const env = LayerNode.compile(Installation.node)

describe("CUDIA installation updates", () => {
  testEffect(env).effect("does not probe upstream installation sources", () =>
    Effect.gen(function* () {
      expect(yield* Installation.use.method()).toBe("unknown")
      const latest = yield* Effect.exit(Installation.use.latest())
      expect(Exit.isFailure(latest)).toBe(true)
      if (Exit.isFailure(latest)) expect(String(latest.cause)).toContain("cudia update --check")
    }),
  )

  testEffect(env).effect("does not run an upstream package-manager installer", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("npm", "99.0.0"))
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.message).toContain("cudia update")
    }),
  )

  testEffect(env).effect("does not report the installed version as a checked latest version", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Installation.use.info())
      expect(Exit.isFailure(result)).toBe(true)
    }),
  )
})
