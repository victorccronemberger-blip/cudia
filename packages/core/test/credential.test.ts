import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Credential.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const newIntegrationID = () => Integration.ID.make(`credential-${crypto.randomUUID()}`)
const oauth = (access: string, refresh = "refresh-token") =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("code"),
    access,
    refresh,
    expires: 1,
  })

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = newIntegrationID()
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("persists one OAuth refresh claim and completes it while preserving the label", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const saved = yield* credentials.create({ integrationID: newIntegrationID(), label: "Work", value: oauth("old") })
      const claim = yield* credentials.refresh.begin(saved)

      expect(claim).toBeDefined()
      expect(saved).not.toHaveProperty("refresh_attempt")
      expect(yield* credentials.refresh.pending(saved.id)).toBe(true)

      const rejected = yield* Effect.exit(credentials.refresh.begin(saved))
      expect(Exit.isFailure(rejected)).toBe(true)
      if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toBeInstanceOf(Credential.RefreshPendingError)

      const replacement = oauth("new", "rotated-refresh-token")
      expect(yield* credentials.refresh.complete(claim!, replacement)).toEqual(replacement)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(false)
      expect(yield* credentials.get(saved.id)).toEqual({ ...saved, label: "Work", value: replacement })
    }),
  )

  it.effect("rejects a second claim even when the expected credential value changed", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const saved = yield* credentials.create({ integrationID: newIntegrationID(), value: oauth("old") })
      yield* credentials.refresh.begin(saved)
      const altered = new Credential.Info({ ...saved, value: oauth("changed") })

      const rejected = yield* Effect.exit(credentials.refresh.begin(altered))
      expect(Exit.isFailure(rejected)).toBe(true)
      if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toBeInstanceOf(Credential.RefreshPendingError)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
    }),
  )

  it.effect("keeps a claim after a generic value update and rejects the old completion", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const saved = yield* credentials.create({ integrationID: newIntegrationID(), value: oauth("old") })
      const claim = yield* credentials.refresh.begin(saved)
      const changed = oauth("manual-update")
      yield* credentials.update(saved.id, { value: changed })

      expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
      expect(yield* credentials.refresh.complete(claim!, oauth("stale-completion"))).toBeUndefined()
      expect((yield* credentials.get(saved.id))?.value).toEqual(changed)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
    }),
  )

  it.effect("does not let an old claim overwrite a replacement or recreate a deleted credential", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integration = newIntegrationID()
      const saved = yield* credentials.create({ integrationID: integration, value: oauth("old") })
      const claim = yield* credentials.refresh.begin(saved)
      const replacement = yield* credentials.create({ integrationID: integration, value: oauth("reauthorized") })

      expect(yield* credentials.refresh.complete(claim!, oauth("stale-completion"))).toBeUndefined()
      expect(yield* credentials.get(saved.id)).toBeUndefined()
      expect((yield* credentials.get(replacement.id))?.value).toEqual(replacement.value)

      const second = yield* credentials.create({ integrationID: newIntegrationID(), value: oauth("old") })
      const secondClaim = yield* credentials.refresh.begin(second)
      yield* credentials.remove(second.id)
      expect(yield* credentials.refresh.complete(secondClaim!, oauth("stale-completion"))).toBeUndefined()
      expect(yield* credentials.get(second.id)).toBeUndefined()
    }),
  )

  it.effect("leaves no claim when claim persistence aborts", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const saved = yield* credentials.create({ integrationID: newIntegrationID(), value: oauth("old") })
      yield* db.run(
        `CREATE TRIGGER credential_refresh_claim_abort BEFORE UPDATE OF refresh_attempt ON credential
         WHEN NEW.refresh_attempt IS NOT NULL BEGIN SELECT RAISE(ABORT, 'claim persistence fixture'); END`,
      )
      const result = yield* Effect.exit(credentials.refresh.begin(saved))
      yield* db.run("DROP TRIGGER credential_refresh_claim_abort")

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(false)
    }),
  )

  it.effect("keeps the old value and claim when completion persistence aborts", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const saved = yield* credentials.create({ integrationID: newIntegrationID(), value: oauth("old") })
      const claim = yield* credentials.refresh.begin(saved)
      yield* db.run(
        `CREATE TRIGGER credential_refresh_complete_abort BEFORE UPDATE OF refresh_attempt ON credential
         WHEN OLD.refresh_attempt IS NOT NULL AND NEW.refresh_attempt IS NULL
         BEGIN SELECT RAISE(ABORT, 'completion persistence fixture'); END`,
      )
      const result = yield* Effect.exit(credentials.refresh.complete(claim!, oauth("new")))
      yield* db.run("DROP TRIGGER credential_refresh_complete_abort")

      expect(Exit.isFailure(result)).toBe(true)
      expect((yield* credentials.get(saved.id))?.value).toEqual(saved.value)
      expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
    }),
  )
})
