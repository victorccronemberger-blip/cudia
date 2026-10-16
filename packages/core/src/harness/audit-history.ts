export * as ContextHistory from "./audit-history"

import { randomUUID } from "node:crypto"
import { lstat, mkdir, open } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "#sqlite"
import { Report } from "./audit"
import { metadata } from "./audit-metadata"

export const FILE = "cudia-context-history.sqlite"
export const BUSY_TIMEOUT_MS = 100
export const OPERATION_TIMEOUT_MS = 2_000
export const MAX_DATABASE_BYTES = 32 * 1024 * 1024
export const MAX_PAGE_BYTES = 1024 * 1024
export const MAX_PAGE_ROWS = 20
export const LIMITS = { rows: 256, bytes: 16 * 1024 * 1024, captureBytes: 128 * 1024 } as const
const APPLICATION_ID = 0x43554148

export class Error extends Schema.TaggedErrorClass<Error>()("ContextHistoryError", {
  reason: Schema.Literals(["unavailable", "unsupported", "too_large", "invalid_capture", "invalid_query"]),
}) {}

export type Limits = { readonly rows: number; readonly bytes: number; readonly captureBytes: number }
type State = { version: number; pruned: number; max_rows: number; max_bytes: number; max_capture_bytes: number }
export type Entry = { readonly sequence: number; readonly id: string; readonly capture: Report }
export type Page = {
  readonly entries: ReadonlyArray<Entry>
  readonly nextBefore?: number
  readonly retained: { readonly count: number; readonly bytes: number; readonly first?: number; readonly last?: number }
  readonly pruned: number
  readonly limits: Limits
  readonly coverage: "bounded successfully persisted prepared-request metadata; not a complete execution log"
}

function limits(value: Limits) {
  return (
    Number.isSafeInteger(value.rows) &&
    value.rows > 0 &&
    value.rows <= LIMITS.rows &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.bytes <= LIMITS.bytes &&
    Number.isSafeInteger(value.captureBytes) &&
    value.captureBytes > 0 &&
    value.captureBytes <= LIMITS.captureBytes &&
    value.captureBytes <= value.bytes
  )
}

const identity = (sql: SqlClient) =>
  Effect.gen(function* () {
    const [application] = yield* sql.unsafe<{ application_id: number }>("PRAGMA application_id")
    const [version] = yield* sql.unsafe<{ user_version: number }>("PRAGMA user_version")
    if (application?.application_id === APPLICATION_ID && version?.user_version === 1) return "owned" as const
    const [tables] = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    if (application?.application_id === 0 && version?.user_version === 0 && tables?.count === 0) return "empty" as const
    return yield* new Error({ reason: "unsupported" })
  })

const state = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<State>(
      "SELECT version, pruned, max_rows, max_bytes, max_capture_bytes FROM history_state WHERE singleton = 1",
    )
    const value = rows[0]
    if (
      rows.length !== 1 ||
      value?.version !== 1 ||
      !Number.isSafeInteger(value.pruned) ||
      value.pruned < 0 ||
      !limits({ rows: value.max_rows, bytes: value.max_bytes, captureBytes: value.max_capture_bytes })
    )
      return yield* new Error({ reason: "unsupported" })
    return value
  })

const tally = (sql: SqlClient) =>
  Effect.map(
    sql.unsafe<{ count: number; bytes: number; first: number | null; last: number | null }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, MIN(sequence) AS first, MAX(sequence) AS last FROM capture",
    ),
    ([value]) => ({
      count: value!.count,
      bytes: value!.bytes,
      ...(value!.first === null ? {} : { first: value!.first }),
      ...(value!.last === null ? {} : { last: value!.last }),
    }),
  )

const prepare = (filename: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(filename), { recursive: true })
      const handle = await open(filename, "wx", 0o600).catch((error) => {
        if (error?.code === "EEXIST") return undefined
        throw error
      })
      await handle?.close()
      const info = await lstat(filename)
      if (!info.isFile() || info.size > MAX_DATABASE_BYTES) throw new globalThis.Error("History target is unavailable")
    },
    catch: () => new Error({ reason: "unavailable" }),
  })

/** Creates no application tables or migrations. All SQL writes use a dedicated immediate transaction. */
export const append = (filename: string, report: Report, requested: Limits = LIMITS) =>
  Effect.gen(function* () {
    if (!limits(requested)) return yield* new Error({ reason: "invalid_query" })
    const capture = metadata(report)
    const payload = JSON.stringify(capture)
    const bytes = Buffer.byteLength(payload, "utf8")
    if (bytes > requested.captureBytes) return yield* new Error({ reason: "too_large" })
    if (!Schema.is(Report)(capture)) return yield* new Error({ reason: "invalid_capture" })
    yield* prepare(filename)
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql.unsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      const kind = yield* identity(sql)
      // Identity is checked before any persistent pragma or schema change.
      if (kind === "empty") yield* sql.unsafe("PRAGMA auto_vacuum = INCREMENTAL")
      const [vacuum] = yield* sql.unsafe<{ auto_vacuum: number }>("PRAGMA auto_vacuum")
      const [journal] = yield* sql.unsafe<{ journal_mode: string }>("PRAGMA journal_mode")
      if (vacuum?.auto_vacuum !== 2 || journal?.journal_mode !== "delete")
        return yield* new Error({ reason: "unsupported" })
      yield* sql.unsafe("PRAGMA synchronous = FULL")
      const [size] = yield* sql.unsafe<{ page_size: number }>("PRAGMA page_size")
      if (!size || !Number.isSafeInteger(size.page_size) || size.page_size <= 0)
        return yield* new Error({ reason: "unsupported" })
      const maxPages = Math.floor(MAX_DATABASE_BYTES / size.page_size)
      const [maximum] = yield* sql.unsafe<{ max_page_count: number }>(`PRAGMA max_page_count = ${maxPages}`)
      if (maximum?.max_page_count !== maxPages) return yield* new Error({ reason: "too_large" })
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* identity(sql)
          if (current === "empty") {
            yield* sql.unsafe(
              "CREATE TABLE history_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL, pruned INTEGER NOT NULL, max_rows INTEGER NOT NULL, max_bytes INTEGER NOT NULL, max_capture_bytes INTEGER NOT NULL)",
            )
            yield* sql.unsafe("INSERT INTO history_state VALUES (1, 1, 0, ?, ?, ?)", [
              requested.rows,
              requested.bytes,
              requested.captureBytes,
            ])
            yield* sql.unsafe(
              "CREATE TABLE capture (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes = length(CAST(payload AS BLOB))), payload TEXT NOT NULL)",
            )
            yield* sql.unsafe("CREATE INDEX capture_session_sequence ON capture(session_id, sequence)")
            yield* sql.unsafe(`PRAGMA application_id = ${APPLICATION_ID}`)
            yield* sql.unsafe("PRAGMA user_version = 1")
          }
          const settings = yield* state(sql)
          if (bytes > settings.max_capture_bytes || bytes > settings.max_bytes)
            return yield* new Error({ reason: "too_large" })
          const id = randomUUID()
          yield* sql.unsafe("INSERT INTO capture (id, session_id, bytes, payload) VALUES (?, ?, ?, ?)", [
            id,
            capture.sessionID,
            bytes,
            payload,
          ])
          const [inserted] = yield* sql.unsafe<{ sequence: number }>("SELECT last_insert_rowid() AS sequence")
          yield* sql.unsafe(
            "DELETE FROM capture WHERE sequence IN (SELECT sequence FROM (SELECT sequence, ROW_NUMBER() OVER (ORDER BY sequence DESC) AS ordinal, SUM(bytes) OVER (ORDER BY sequence DESC ROWS UNBOUNDED PRECEDING) AS total FROM capture) WHERE ordinal > ? OR total > ?)",
            [settings.max_rows, settings.max_bytes],
          )
          const [removed] = yield* sql.unsafe<{ count: number }>("SELECT changes() AS count")
          if (removed!.count > 0)
            yield* sql.unsafe("UPDATE history_state SET pruned = pruned + ? WHERE singleton = 1", [removed!.count])
          const retained = yield* tally(sql)
          if (retained.count > settings.max_rows || retained.bytes > settings.max_bytes)
            return yield* new Error({ reason: "too_large" })
          return { id, sequence: inserted!.sequence, retained, prunedNow: removed!.count }
        }),
      )
      // Bounded incremental reclamation is separate from committed capture success.
      const maintenance =
        result.prunedNow === 0
          ? true
          : yield* sql.unsafe("PRAGMA incremental_vacuum(32)").pipe(
              Effect.as(true),
              Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(false))),
            )
      return { ...result, maintenance }
    }).pipe(Effect.provide(layer({ filename, disableWAL: true, transactionMode: "immediate" })))
  }).pipe(Effect.timeout(OPERATION_TIMEOUT_MS))

export const read = (
  filename: string,
  query: { readonly sessionID?: string; readonly before?: number; readonly limit?: number } = {},
) =>
  Effect.gen(function* () {
    const limit = query.limit ?? MAX_PAGE_ROWS
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_ROWS ||
      (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1)) ||
      (query.sessionID !== undefined && (query.sessionID.length === 0 || query.sessionID.length > 512))
    )
      return yield* new Error({ reason: "invalid_query" })
    const exists = yield* Effect.tryPromise({
      try: async () => {
        const info = await lstat(filename).catch((error) => {
          if (error?.code === "ENOENT") return undefined
          throw error
        })
        if (info && (!info.isFile() || info.size > MAX_DATABASE_BYTES))
          throw new globalThis.Error("History target is unavailable")
        return !!info
      },
      catch: () => new Error({ reason: "unavailable" }),
    })
    if (!exists) return undefined
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql.unsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if ((yield* identity(sql)) !== "owned") return yield* new Error({ reason: "unsupported" })
          const settings = yield* state(sql)
          const retained = yield* tally(sql)
          if (
            !Number.isSafeInteger(retained.count) ||
            retained.count < 0 ||
            retained.count > settings.max_rows ||
            !Number.isSafeInteger(retained.bytes) ||
            retained.bytes < 0 ||
            retained.bytes > settings.max_bytes
          )
            return yield* new Error({ reason: "invalid_capture" })
          const rows = yield* sql.unsafe<{ sequence: number; id: string; payload: string; bytes: number }>(
            "SELECT sequence, id, payload, bytes FROM capture WHERE (? IS NULL OR session_id = ?) AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?",
            [query.sessionID ?? null, query.sessionID ?? null, query.before ?? null, query.before ?? null, limit + 1],
          )
          const entries: Entry[] = []
          let used = 0
          for (const row of rows.slice(0, limit)) {
            if (
              !Number.isSafeInteger(row.sequence) ||
              row.sequence < 1 ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id) ||
              !Number.isSafeInteger(row.bytes) ||
              row.bytes < 0 ||
              row.bytes > settings.max_capture_bytes ||
              Buffer.byteLength(row.payload, "utf8") !== row.bytes
            )
              return yield* new Error({ reason: "invalid_capture" })
            const capture = yield* Effect.try({
              try: () => metadata(Schema.decodeUnknownSync(Report)(JSON.parse(row.payload))),
              catch: () => new Error({ reason: "invalid_capture" }),
            })
            const entry = { sequence: row.sequence, id: row.id, capture }
            const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8")
            // Reserve space for page metadata and the CLI envelope, not just the row payloads.
            if (used + bytes > MAX_PAGE_BYTES - 4096) break
            entries.push(entry)
            used += bytes
          }
          const nextBefore = entries.length > 0 && rows.length > entries.length ? entries.at(-1)!.sequence : undefined
          return {
            entries,
            ...(nextBefore === undefined ? {} : { nextBefore }),
            retained,
            pruned: settings.pruned,
            limits: { rows: settings.max_rows, bytes: settings.max_bytes, captureBytes: settings.max_capture_bytes },
            coverage: "bounded successfully persisted prepared-request metadata; not a complete execution log" as const,
          } satisfies Page
        }),
      )
    }).pipe(
      Effect.provide(layer({ filename, readonly: true, create: false, readwrite: false, disableWAL: true })),
    )
  }).pipe(Effect.timeout(OPERATION_TIMEOUT_MS))
