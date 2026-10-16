export * as SessionStore from "./store"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
  /** Includes pre-compaction history; two rows suffice to reject ambiguous call IDs. */
  readonly toolMessages: (
    sessionID: SessionSchema.ID,
    callID: string,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly hasRecoverableToolResult: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      toolMessages: Effect.fn("SessionStore.toolMessages")(function* (sessionID, callID) {
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, "assistant"),
              sql`exists (select 1 from json_each(${SessionMessageTable.data}, '$.content') as part
                where json_extract(part.value, '$.type') = 'tool'
                  and json_extract(part.value, '$.id') = ${callID})`,
            ),
          )
          .limit(2)
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) =>
          decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
            Effect.mapError(() => new MessageDecodeError({ sessionID, messageID: row.id })),
          ),
        )
      }),
      hasRecoverableToolResult: Effect.fn("SessionStore.hasRecoverableToolResult")(function* (sessionID) {
        const row = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, "assistant"),
              sql`exists (select 1 from json_each(${SessionMessageTable.data}, '$.content') as part
                where json_extract(part.value, '$.type') = 'tool'
                  and json_extract(part.value, '$.state.status') = 'completed'
                  and json_extract(part.value, '$.time.pruned') is null
                  and (
                    json_array_length(json_extract(part.value, '$.state.outputPaths')) > 0
                    or exists (select 1 from json_each(json_extract(part.value, '$.state.structured')))
                    or exists (select 1 from json_each(json_extract(part.value, '$.state.content')) as content
                      where json_extract(content.value, '$.type') = 'file'
                        or (json_extract(content.value, '$.type') = 'text'
                          and length(cast(json_extract(content.value, '$.text') as blob)) > 0))
                  ))`,
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
