import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, Ref, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

describe("Integration", () => {
  it.effect("registers integrations through the editor", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const openai = Integration.ID.make("openai")

      yield* integrations
        .transform((editor) => editor.update(openai, (integration) => (integration.name = "OpenAI")))
        .pipe(Scope.provide(scope))
      expect(yield* integrations.get(openai)).toEqual(
        new Integration.Info({ id: openai, name: "OpenAI", methods: [], connections: [] }),
      )

      yield* Scope.close(scope, Exit.void)
      expect(yield* integrations.get(openai)).toBeUndefined()
    }),
  )

  it.effect("reveals the previous registration when an override closes", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const id = Integration.ID.make("openai")
      const first = yield* Scope.fork(yield* Scope.Scope)
      const second = yield* Scope.fork(yield* Scope.Scope)

      yield* integrations
        .transform((editor) => editor.update(id, (integration) => (integration.name = "OpenAI")))
        .pipe(Scope.provide(first))
      yield* integrations
        .transform((editor) => editor.update(id, (integration) => (integration.name = "OpenAI Override")))
        .pipe(Scope.provide(second))
      expect((yield* integrations.get(id))?.name).toBe("OpenAI Override")

      yield* Scope.close(second, Exit.void)
      expect((yield* integrations.get(id))?.name).toBe("OpenAI")
      expect((yield* integrations.list()).map((integration) => integration.id)).toEqual([id])
    }),
  )

  it.effect("registers and overrides methods independently", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      const first = yield* Scope.fork(yield* Scope.Scope)
      const second = yield* Scope.fork(yield* Scope.Scope)
      const authorize = () =>
        Effect.succeed({
          mode: "auto" as const,
          url: "https://example.com/authorize",
          instructions: "Sign in",
          callback: Effect.never,
        })

      yield* integrations
        .transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "ChatGPT" },
            authorize,
          }),
        )
        .pipe(Scope.provide(first))
      yield* integrations
        .transform((editor) => {
          expect(editor.get(integrationID)).toEqual({ id: integrationID, name: "openai" })
          expect(editor.list()).toEqual([{ id: integrationID, name: "openai" }])
          expect(editor.method.list(integrationID)).toEqual([
            expect.objectContaining({ id: methodID, label: "ChatGPT" }),
          ])
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "ChatGPT Override" },
            authorize,
          })
        })
        .pipe(Scope.provide(second))

      expect((yield* integrations.get(integrationID))?.name).toBe("openai")
      expect((yield* integrations.get(integrationID))?.methods[0]).toMatchObject({ label: "ChatGPT Override" })

      yield* Scope.close(second, Exit.void)
      expect((yield* integrations.get(integrationID))?.methods[0]).toMatchObject({ label: "ChatGPT" })
      expect((yield* integrations.get(integrationID))?.methods).toEqual([expect.objectContaining({ id: methodID })])
    }),
  )

  it.effect("connects with a key and stores the credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const events = yield* EventV2.Service
      const integrationID = Integration.ID.make("openai")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { type: "key", label: "API key" },
        }),
      )
      const updated = yield* events
        .subscribe(Integration.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* integrations.connection.key({
        integrationID,
        key: "secret",
        label: "Work",
      })

      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({
          integrationID,
          label: "Work",
          value: Credential.Key.make({ type: "key", key: "secret" }),
        }),
      ])
      expect((yield* Fiber.join(updated)).length).toBe(1)
    }),
  )

  it.effect("completes code OAuth once and stores the credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "ChatGPT" },
          authorize: () =>
            Effect.succeed({
              mode: "code" as const,
              url: "https://example.com/authorize",
              instructions: "Paste the code",
              callback: (code: string) =>
                Effect.succeed(
                  Credential.OAuth.make({
                    type: "oauth",
                    methodID,
                    access: "access",
                    refresh: "refresh",
                    expires: 1,
                    metadata: { code },
                  }),
                ),
            }),
        }),
      )

      const attempt = yield* integrations.connection.oauth({
        integrationID,
        methodID,
        inputs: {},
        label: "Personal",
      })
      expect(attempt.mode).toBe("code")
      yield* integrations.attempt.complete({ attemptID: attempt.attemptID, code: "1234" })

      expect((yield* credentials.list(integrationID))[0]).toEqual(
        expect.objectContaining({
          integrationID,
          label: "Personal",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "access",
            refresh: "refresh",
            expires: 1,
            metadata: { code: "1234" },
          }),
        }),
      )
    }),
  )

  it.effect("keeps code attempts open when the code is missing and closes them on cancel", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      let closed = false
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "ChatGPT" },
          authorize: () =>
            Effect.addFinalizer(() => Effect.sync(() => (closed = true))).pipe(
              Effect.as({
                mode: "code" as const,
                url: "https://example.com/authorize",
                instructions: "Paste the code",
                callback: () => Effect.die("unexpected callback"),
              }),
            ),
        }),
      )

      const attempt = yield* integrations.connection.oauth({ integrationID, methodID, inputs: {} })
      expect(yield* integrations.attempt.complete({ attemptID: attempt.attemptID }).pipe(Effect.flip)).toBeInstanceOf(
        Integration.CodeRequiredError,
      )
      expect(closed).toBe(false)
      yield* integrations.attempt.cancel(attempt.attemptID)
      expect(closed).toBe(true)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("completes auto OAuth in the background", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Browser" },
          authorize: () =>
            Effect.succeed({
              mode: "auto" as const,
              url: "https://example.com/authorize",
              instructions: "Sign in",
              callback: Effect.succeed(
                Credential.OAuth.make({ type: "oauth", methodID, access: "access", refresh: "refresh", expires: 1 }),
              ),
            }),
        }),
      )

      const attempt = yield* integrations.connection.oauth({ integrationID, methodID, inputs: {} })
      yield* Effect.yieldNow
      expect(yield* integrations.attempt.status(attempt.attemptID)).toEqual({
        status: "complete",
        time: attempt.time,
      })
      expect(yield* credentials.list(integrationID)).toHaveLength(1)
    }),
  )

  it.live("shares one refresh for concurrent expired OAuth resolutions", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("refresh-race")
      const methodID = Integration.MethodID.make("oauth")
      const calls = yield* Ref.make(0)
      const bothStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const issued = Date.now()
      const refreshed = Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "refreshed-access",
        refresh: "refreshed-refresh",
        issued,
        expires: issued + 60_000,
      })

      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(calls, (current) => current + 1)
              if (count === 2) yield* Deferred.succeed(bothStarted, undefined)
              yield* Deferred.await(release)
              return refreshed
            }),
        }),
      )

      const saved = yield* credentials.create({
        integrationID,
        label: "Personal",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "refresh-token",
          expires: 0,
        }),
      })
      const connection = { type: "credential" as const, id: saved.id, label: saved.label }
      const first = yield* integrations.connection.resolve(connection).pipe(Effect.forkScoped)
      const second = yield* integrations.connection.resolve(connection).pipe(Effect.forkScoped)

      yield* Effect.race(Deferred.await(bothStarted), Effect.sleep(Duration.millis(100)))
      yield* Deferred.succeed(release, undefined)
      const values = yield* Effect.all([Fiber.join(first), Fiber.join(second)])

      const resolved = values[0]
      if (resolved?.type !== "oauth") throw new Error("refresh did not return an OAuth credential")
      expect(resolved).toMatchObject({
        type: "oauth",
        methodID,
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      })
      expect(values[1]).toEqual(resolved)
      expect(resolved.issued).toBeGreaterThanOrEqual(issued)
      expect(yield* Ref.get(calls)).toBe(1)
      expect((yield* credentials.get(saved.id))?.value).toEqual(resolved)
      expect(yield* integrations.connection.resolve(connection)).toEqual(resolved)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live("shares a failed refresh without retrying it for concurrent callers", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("refresh-failure")
      const methodID = Integration.MethodID.make("oauth")
      const calls = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: () =>
            Ref.updateAndGet(calls, (current) => current + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(new Error("refresh failed"))),
            ),
        }),
      )

      const saved = yield* credentials.create({
        integrationID,
        label: "Personal",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "refresh-token",
          expires: 0,
        }),
      })
      const connection = { type: "credential" as const, id: saved.id, label: saved.label }
      const first = yield* Effect.exit(integrations.connection.resolve(connection)).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const second = yield* Effect.exit(integrations.connection.resolve(connection)).pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(25))
      yield* Deferred.succeed(release, undefined)
      const exits = yield* Effect.all([Fiber.join(first), Fiber.join(second)])

      expect(exits.every(Exit.isFailure)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
      expect((yield* credentials.get(saved.id))?.value).toEqual(saved.value)
      expect(yield* integrations.connection.resolve(connection).pipe(Effect.flip)).toBeInstanceOf(
        Integration.AuthorizationError,
      )
      expect(yield* Ref.get(calls)).toBe(1)
      yield* integrations.connection.update(saved.id, { label: "Renamed" })
      expect(Exit.isFailure(yield* Effect.exit(integrations.connection.resolve(connection)))).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
      yield* credentials.update(saved.id, {
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "replacement-refresh-token",
          expires: 0,
        }),
      })
      expect((yield* credentials.get(saved.id))?.value).toMatchObject({
        refresh: "replacement-refresh-token",
        expires: 0,
      })
      expect(Exit.isFailure(yield* Effect.exit(integrations.connection.resolve(connection)))).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
      const replacement = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "replacement-access",
          refresh: "explicitly-authorized-refresh-token",
          expires: 0,
        }),
      })
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            integrations.connection.resolve({ type: "credential", id: replacement.id, label: replacement.label }),
          ),
        ),
      ).toBe(true)
      expect(yield* Ref.get(calls)).toBe(2)
    }),
  )

  it.live("resets issued time when a provider spreads a legacy OAuth credential into a fresh token", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("refresh-issued-reset")
      const methodID = Integration.MethodID.make("oauth")
      const calls = yield* Ref.make(0)
      const startedAt = Date.now()
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: (credential) =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.as(
                Credential.OAuth.make({
                  ...credential,
                  access: "fresh-access",
                  refresh: "fresh-refresh",
                  expires: startedAt + 60_000,
                }),
              ),
            ),
        }),
      )
      const saved = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "legacy-refresh",
          issued: startedAt - Duration.toMillis(Duration.hours(1)),
          expires: startedAt - 1,
        }),
      })
      const connection = { type: "credential" as const, id: saved.id, label: saved.label }

      const first = yield* integrations.connection.resolve(connection)
      const second = yield* integrations.connection.resolve(connection)

      if (first?.type !== "oauth") throw new Error("refresh did not return an OAuth credential")
      expect(first).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh" })
      expect(second).toEqual(first)
      expect(first?.issued).toBeGreaterThan(startedAt - 1_000)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.effect("keeps the shared refresh alive when one waiting caller is interrupted", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("refresh-interrupt")
      const methodID = Integration.MethodID.make("oauth")
      const calls = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const refreshed = Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "refreshed-access",
        refresh: "refreshed-refresh",
        issued: Date.now(),
        expires: Date.now() + 60_000,
      })

      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: () =>
            Ref.updateAndGet(calls, (current) => current + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(refreshed),
            ),
        }),
      )

      const saved = yield* credentials.create({
        integrationID,
        label: "Personal",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "refresh-token",
          expires: 0,
        }),
      })
      const connection = { type: "credential" as const, id: saved.id, label: saved.label }
      const first = yield* integrations.connection.resolve(connection).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const second = yield* integrations.connection.resolve(connection).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(first)
      yield* Deferred.succeed(release, undefined)

      const resolved = yield* Fiber.join(second)
      expect(resolved).toMatchObject({
        type: "oauth",
        methodID,
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      })
      expect(yield* Ref.get(calls)).toBe(1)
      expect((yield* credentials.get(saved.id))?.value).toMatchObject({
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        issued: resolved?.type === "oauth" ? resolved.issued : undefined,
      })
    }),
  )

  it.live(
    "does not refresh credentials without expiry and requires reauthorization when an expired token has no refresh method",
    () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const missingExpiryID = Integration.ID.make("refresh-unknown-expiry")
        const missingExpiryMethod = Integration.MethodID.make("oauth")
        const refreshCalls = yield* Ref.make(0)
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID: missingExpiryID,
            method: { id: missingExpiryMethod, type: "oauth", label: "Unknown expiry" },
            authorize: () => Effect.die("unexpected authorization"),
            refresh: () =>
              Ref.updateAndGet(refreshCalls, (count) => count + 1).pipe(
                Effect.as(
                  Credential.OAuth.make({
                    type: "oauth",
                    methodID: missingExpiryMethod,
                    access: "should-not-be-used",
                  }),
                ),
              ),
          }),
        )
        const unknownExpiry = yield* credentials.create({
          integrationID: missingExpiryID,
          value: Credential.OAuth.make({
            type: "oauth",
            methodID: missingExpiryMethod,
            access: "unknown-expiry-access",
            refresh: "refresh-token",
          }),
        })
        const unknownConnection = { type: "credential" as const, id: unknownExpiry.id, label: unknownExpiry.label }

        expect(yield* integrations.connection.resolve(unknownConnection)).toEqual(unknownExpiry.value)
        expect(yield* Ref.get(refreshCalls)).toBe(0)

        const expiredID = Integration.ID.make("refresh-expired-no-method")
        const expiredMethod = Integration.MethodID.make("oauth")
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID: expiredID,
            method: { id: expiredMethod, type: "oauth", label: "No refresh method" },
            authorize: () => Effect.die("unexpected authorization"),
          }),
        )
        const expired = yield* credentials.create({
          integrationID: expiredID,
          value: Credential.OAuth.make({
            type: "oauth",
            methodID: expiredMethod,
            access: "expired-access",
            refresh: "",
            expires: 0,
          }),
        })
        const error = yield* integrations.connection
          .resolve({ type: "credential", id: expired.id, label: expired.label })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(Integration.AuthorizationError)
        expect(String(error.cause)).toContain("reconnect to authorize again")
      }),
  )

  it.live("keeps uncertain refreshes isolated across integrations", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const firstID = Integration.ID.make("refresh-poison-first")
      const secondID = Integration.ID.make("refresh-poison-second")
      const methodID = Integration.MethodID.make("oauth")
      const firstCalls = yield* Ref.make(0)
      const secondCalls = yield* Ref.make(0)
      yield* integrations.transform((editor) => {
        editor.method.update({
          integrationID: firstID,
          method: { id: methodID, type: "oauth", label: "First" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: () =>
            Ref.updateAndGet(firstCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail(new Error("first refresh failed"))),
            ),
        })
        editor.method.update({
          integrationID: secondID,
          method: { id: methodID, type: "oauth", label: "Second" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: () =>
            Ref.updateAndGet(secondCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail(new Error("second refresh failed"))),
            ),
        })
      })
      const first = yield* credentials.create({
        integrationID: firstID,
        value: Credential.OAuth.make({ type: "oauth", methodID, access: "old-a", refresh: "refresh-a", expires: 0 }),
      })
      const second = yield* credentials.create({
        integrationID: secondID,
        value: Credential.OAuth.make({ type: "oauth", methodID, access: "old-b", refresh: "refresh-b", expires: 0 }),
      })
      const firstConnection = { type: "credential" as const, id: first.id, label: first.label }
      const secondConnection = { type: "credential" as const, id: second.id, label: second.label }

      expect(Exit.isFailure(yield* Effect.exit(integrations.connection.resolve(firstConnection)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(integrations.connection.resolve(secondConnection)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(integrations.connection.resolve(firstConnection)))).toBe(true)
      expect(yield* Ref.get(firstCalls)).toBe(1)
      expect(yield* Ref.get(secondCalls)).toBe(1)
    }),
  )

  it.live("does not exchange a token when the durable refresh claim cannot be persisted", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const integrationID = Integration.ID.make("refresh-claim-persist-failure")
      const methodID = Integration.MethodID.make("oauth")
      const calls = yield* Ref.make(0)
      yield* database.db.run(
        `CREATE TRIGGER integration_refresh_claim_failure BEFORE UPDATE ON credential
         WHEN NEW.integration_id = '${integrationID}' AND NEW.refresh_attempt IS NOT NULL
         BEGIN SELECT RAISE(ABORT, 'fixture claim persistence failure'); END`,
      )
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: (value) => Ref.update(calls, (count) => count + 1).pipe(Effect.as(value)),
        }),
      )
      const saved = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({ type: "oauth", methodID, access: "old", refresh: "unused-refresh", expires: 0 }),
      })
      const result = yield* Effect.exit(
        integrations.connection.resolve({ type: "credential", id: saved.id, label: saved.label }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(0)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(false)
      expect((yield* credentials.get(saved.id))?.value).toEqual(saved.value)
    }),
  )

  it.live("does not retry a successful token exchange when credential persistence fails", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const integrationID = Integration.ID.make("refresh-persist-failure")
      const methodID = Integration.MethodID.make("oauth")
      const label = "RefreshPersistenceFailureFixture"
      const calls = yield* Ref.make(0)
      yield* db.run(
        `CREATE TRIGGER integration_refresh_persist_failure BEFORE UPDATE ON credential
         WHEN NEW.integration_id = '${integrationID}' AND NEW.value != OLD.value
         BEGIN SELECT RAISE(ABORT, 'fixture refresh persistence failure'); END`,
      )
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () => Effect.die("unexpected authorization"),
          refresh: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.as(
                Credential.OAuth.make({
                  type: "oauth",
                  methodID,
                  access: "rotated-access",
                  refresh: "rotated-refresh",
                  issued: Date.now(),
                  expires: Date.now() + 60_000,
                }),
              ),
            ),
        }),
      )
      const saved = yield* credentials.create({
        integrationID,
        label,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "old-refresh-token",
          expires: 0,
        }),
      })
      const connection = { type: "credential" as const, id: saved.id, label: saved.label }

      const first = yield* Effect.exit(integrations.connection.resolve(connection))
      const second = yield* Effect.exit(integrations.connection.resolve(connection))

      expect(Exit.isFailure(first)).toBe(true)
      expect(Exit.isFailure(second)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
      expect((yield* credentials.get(saved.id))?.value).toEqual(saved.value)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
    }),
  )

  it.live("does not persist a refresh result from a replaced integration implementation", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("refresh-replaced-implementation")
      const methodID = Integration.MethodID.make("oauth")
      const originalScope = yield* Scope.fork(yield* Scope.Scope)
      const replacementScope = yield* Scope.fork(yield* Scope.Scope)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      yield* integrations
        .transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "Original" },
            authorize: () => Effect.die("unexpected authorization"),
            refresh: () =>
              Effect.gen(function* () {
                yield* Ref.update(calls, (count) => count + 1)
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                return Credential.OAuth.make({
                  type: "oauth",
                  methodID,
                  access: "obsolete-access",
                  refresh: "obsolete-refresh",
                  expires: Date.now() + 60_000,
                })
              }),
          }),
        )
        .pipe(Scope.provide(originalScope))
      const saved = yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "expired-access",
          refresh: "refresh-token",
          expires: 0,
        }),
      })
      const connection = { type: "credential" as const, id: saved.id, label: saved.label }
      const resolving = yield* integrations.connection.resolve(connection).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Scope.close(originalScope, Exit.void)
      yield* integrations
        .transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "Replacement" },
            authorize: () => Effect.die("unexpected authorization"),
            refresh: () =>
              Effect.succeed(
                Credential.OAuth.make({
                  type: "oauth",
                  methodID,
                  access: "replacement-access",
                  refresh: "replacement-refresh",
                  expires: Date.now() + 60_000,
                }),
              ),
          }),
        )
        .pipe(Scope.provide(replacementScope))
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(resolving)).toBeUndefined()
      expect(yield* Ref.get(calls)).toBe(1)
      expect((yield* credentials.get(saved.id))?.value).toEqual(saved.value)
    }),
  )

  it.effect("does not complete an OAuth attempt when credential persistence fails", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const integrationID = Integration.ID.make("oauth-persist-failure")
      const methodID = Integration.MethodID.make("code")
      const label = "PersistenceFailureFixture"
      yield* db.run(
        `CREATE TRIGGER integration_credential_persist_failure BEFORE INSERT ON credential
         WHEN NEW.label = '${label}' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`,
      )
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () =>
            Effect.succeed({
              mode: "code" as const,
              url: "https://example.com/authorize",
              instructions: "Paste the code",
              callback: () =>
                Effect.succeed(
                  Credential.OAuth.make({
                    type: "oauth",
                    methodID,
                    access: "access",
                    refresh: "refresh",
                    expires: 1,
                  }),
                ),
            }),
        }),
      )

      const attempt = yield* integrations.connection.oauth({ integrationID, methodID, inputs: {}, label })
      const result = yield* Effect.exit(integrations.attempt.complete({ attemptID: attempt.attemptID, code: "code" }))

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* integrations.attempt.status(attempt.attemptID)).toEqual({
        status: "failed",
        message: expect.any(String),
        time: attempt.time,
      })
      expect(yield* credentials.list(integrationID)).toEqual([])
      yield* db.run("DROP TRIGGER integration_credential_persist_failure")
    }),
  )

  it.effect("lets cancellation win before an OAuth callback reaches persistence", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("oauth-cancel-before-commit")
      const methodID = Integration.MethodID.make("code")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Test OAuth" },
          authorize: () =>
            Effect.succeed({
              mode: "code" as const,
              url: "https://example.com/authorize",
              instructions: "Paste the code",
              callback: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  return Credential.OAuth.make({
                    type: "oauth",
                    methodID,
                    access: "access",
                    refresh: "refresh",
                    expires: 1,
                  })
                }),
            }),
        }),
      )

      const attempt = yield* integrations.connection.oauth({ integrationID, methodID, inputs: {} })
      const completing = yield* integrations.attempt
        .complete({ attemptID: attempt.attemptID, code: "code" })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* integrations.attempt.cancel(attempt.attemptID)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(completing)

      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("expires abandoned OAuth attempts", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser")
      let closed = false
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Browser" },
          authorize: () =>
            Effect.addFinalizer(() => Effect.sync(() => (closed = true))).pipe(
              Effect.as({
                mode: "auto" as const,
                url: "https://example.com/authorize",
                instructions: "Sign in",
                callback: Effect.never,
              }),
            ),
        }),
      )

      const attempt = yield* integrations.connection.oauth({ integrationID, methodID, inputs: {} })
      expect(attempt.time.expires - attempt.time.created).toBe(Duration.toMillis(Duration.minutes(10)))
      yield* TestClock.adjust(Duration.minutes(10))
      yield* Effect.yieldNow
      expect(yield* integrations.attempt.status(attempt.attemptID)).toEqual({
        status: "expired",
        time: attempt.time,
      })
      expect(closed).toBe(true)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("projects credential and env connections", () => {
    const integrationID = Integration.ID.make("acme")
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.INTEGRATION_TEST_ACME_KEY
        process.env.INTEGRATION_TEST_ACME_KEY = "secret"
        delete process.env.INTEGRATION_TEST_ACME_MISSING
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const credentials = yield* Credential.Service
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID,
              method: {
                type: "env",
                names: ["INTEGRATION_TEST_ACME_KEY", "INTEGRATION_TEST_ACME_MISSING"],
              },
            }),
          )
          const work = yield* credentials.create({
            integrationID,
            label: "Work",
            value: Credential.Key.make({ type: "key", key: "a" }),
          })
          const personal = yield* credentials.create({
            integrationID,
            label: "Personal",
            value: Credential.Key.make({ type: "key", key: "b" }),
          })

          // Stored credentials and detected env vars appear as connections.
          expect((yield* integrations.get(integrationID))?.connections).toEqual([
            {
              type: "credential",
              id: personal.id,
              label: "Personal",
            },
            { type: "env", name: "INTEGRATION_TEST_ACME_KEY" },
          ])
          expect(yield* integrations.connection.active(integrationID)).toEqual({
            type: "credential",
            id: personal.id,
            label: "Personal",
          })
          expect(work.id).not.toBe(personal.id)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.INTEGRATION_TEST_ACME_KEY
          else process.env.INTEGRATION_TEST_ACME_KEY = previous
        }),
    )
  })
})
