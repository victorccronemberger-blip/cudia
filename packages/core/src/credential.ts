export * as Credential from "./credential"

import { asc, eq, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { createHash, randomUUID } from "node:crypto"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export function fingerprint(value: Value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export type RefreshClaim = {
  readonly credentialID: ID
  readonly nonce: string
  readonly snapshot: string
}

export class RefreshPendingError extends Error {
  readonly _tag = "Credential.RefreshPendingError"

  constructor() {
    super("Credential refresh is already pending.")
  }
}

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
  readonly refresh: {
    readonly pending: (id: ID) => Effect.Effect<boolean>
    readonly begin: (expected: Info) => Effect.Effect<RefreshClaim | undefined, RefreshPendingError>
    readonly complete: (claim: RefreshClaim, value: OAuth) => Effect.Effect<OAuth | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Value)
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
      })
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        return (yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        return (yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* tx
                  .delete(CredentialTable)
                  .where(eq(CredentialTable.integration_id, credential.integrationID))
                  .run()
                yield* tx
                  .insert(CredentialTable)
                  .values({
                    id: credential.id,
                    integration_id: credential.integrationID,
                    label: credential.label,
                    value: credential.value,
                  })
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
      refresh: {
        pending: Effect.fn("Credential.refresh.pending")(function* (id) {
          const row = yield* db
            .select({ pending: sql<number>`${CredentialTable.refresh_attempt} IS NOT NULL` })
            .from(CredentialTable)
            .where(eq(CredentialTable.id, id))
            .get()
            .pipe(Effect.orDie)
          return row?.pending === 1
        }),
        begin: Effect.fn("Credential.refresh.begin")(function* (expected) {
          if (expected.value.type !== "oauth") return undefined
          const result = yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const row = yield* tx
                    .select({
                      id: CredentialTable.id,
                      integration_id: CredentialTable.integration_id,
                      label: CredentialTable.label,
                      value: CredentialTable.value,
                    })
                    .from(CredentialTable)
                    .where(eq(CredentialTable.id, expected.id))
                    .get()
                  if (!row) return { kind: "missing" as const }
                  const pending = yield* tx
                    .select({ pending: sql<number>`${CredentialTable.refresh_attempt} IS NOT NULL` })
                    .from(CredentialTable)
                    .where(eq(CredentialTable.id, expected.id))
                    .get()
                  if (pending?.pending === 1) return { kind: "pending" as const }
                  const current = row.integration_id
                    ? new Info({
                        id: row.id,
                        integrationID: row.integration_id,
                        label: row.label,
                        value: decode(row.value),
                      })
                    : undefined
                  if (!current || fingerprint(current.value) !== fingerprint(expected.value))
                    return { kind: "changed" as const }
                  const snapshot = fingerprint(current.value)
                  const nonce = randomUUID()
                  const time_created = yield* Clock.currentTimeMillis
                  yield* tx
                    .update(CredentialTable)
                    .set({ refresh_attempt: { nonce, snapshot, time_created } })
                    .where(eq(CredentialTable.id, expected.id))
                    .run()
                  return { kind: "claimed" as const, claim: { credentialID: expected.id, nonce, snapshot } }
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          if (result.kind === "pending") return yield* Effect.fail(new RefreshPendingError())
          return result.kind === "claimed" ? result.claim : undefined
        }),
        complete: Effect.fn("Credential.refresh.complete")(function* (claim, value) {
          const result = yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const row = yield* tx
                    .select()
                    .from(CredentialTable)
                    .where(eq(CredentialTable.id, claim.credentialID))
                    .get()
                  if (!row || row.refresh_attempt == null) return undefined
                  if (row.refresh_attempt.nonce !== claim.nonce || row.refresh_attempt.snapshot !== claim.snapshot)
                    return undefined
                  const current = stored(row)
                  if (!current || current.value.type !== "oauth" || fingerprint(current.value) !== claim.snapshot)
                    return undefined
                  yield* tx
                    .update(CredentialTable)
                    .set({ value, refresh_attempt: null })
                    .where(eq(CredentialTable.id, claim.credentialID))
                    .run()
                  return value
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          return result
        }),
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
