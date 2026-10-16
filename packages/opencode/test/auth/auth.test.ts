import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("preserves native OAuth registration metadata through storage", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const credentials = Auth.Oauth.make({
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: 1000,
        metadata: {
          oauthMode: "chatgpt",
          clientId: "issued",
          subject: "subject",
          hostId: "host",
          scopes: "granted",
          idToken: "signed",
        },
      })
      yield* auth.set("oauth-roundtrip", credentials)
      expect(yield* auth.get("oauth-roundtrip")).toEqual(credentials)
      yield* auth.remove("oauth-roundtrip")
    }),
  )

  it.instance("concurrent provider writes preserve every credential", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const names = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`)
      yield* Effect.all(
        names.map((name) => auth.set(name, { type: "api", key: name })),
        { concurrency: "unbounded" },
      )
      const all = yield* auth.all()
      names.forEach((name) => expect(all[name]).toEqual({ type: "api", key: name }))
      yield* Effect.all(
        names.map((name) => auth.remove(name)),
        { concurrency: "unbounded" },
      )
    }),
  )

  it.instance("a stale refresh cannot overwrite newer credentials", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const old = Auth.Oauth.make({ type: "oauth", access: "old", refresh: "old-refresh", expires: 1000 })
      const next = Auth.Oauth.make({ type: "oauth", access: "new", refresh: "new-refresh", expires: 2000 })
      yield* auth.set("oauth-cas", old)
      expect(yield* Effect.promise(() => Auth.replaceStored("oauth-cas", old, next))).toBe(true)
      expect(yield* Effect.promise(() => Auth.replaceStored("oauth-cas", old, old))).toBe(false)
      expect(yield* auth.get("oauth-cas")).toEqual(next)
      yield* auth.remove("oauth-cas")
    }),
  )

  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )
})
