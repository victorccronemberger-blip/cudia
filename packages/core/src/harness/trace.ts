export * as ContextTrace from "./trace"

import { createHash } from "node:crypto"
import { Schema } from "effect"

export const MAX_RECORDS = 64
export const MAX_BYTES = 65_536
export const MAX_NODES = 4096
export const MAX_DEPTH = 24

export type Origin = {
  readonly kind: "builtin" | "file" | "npm" | "runtime"
  readonly id: string
  readonly ordinal: number
  readonly entry?: string
}
export type Outcome = "success" | "failure" | "interrupted"

const Snapshot = Schema.Union([
  Schema.Struct({ status: Schema.Literal("complete"), bytes: Schema.Number, sha256: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("incomplete"),
    reason: Schema.Literals(["unsupported", "byte_limit", "node_limit", "depth_limit", "cycle", "read_error"]),
  }),
])
export type Snapshot = typeof Snapshot.Type

export const CaptureSchema = Schema.Struct({
  version: Schema.Literal(1),
  coverage: Schema.Literal("observed prepared-request projections; not complete runtime or wire coverage"),
  records: Schema.Array(
    Schema.Struct({
      ordinal: Schema.Number,
      stage: Schema.String,
      projection: Schema.String,
      source: Schema.Struct({
        kind: Schema.Literals(["builtin", "file", "npm", "runtime"]),
        id: Schema.String,
        ordinal: Schema.Number,
        entry: Schema.optional(Schema.String),
      }),
      status: Schema.Literals(["pending", "success", "failure", "interrupted"]),
      before: Snapshot,
      after: Schema.optional(Snapshot),
      change: Schema.Literals(["changed", "unchanged", "unknown"]),
    }),
  ),
  omitted: Schema.Number,
})
export type Capture = typeof CaptureSchema.Type
export type Collector = {
  readonly start: (
    input: { readonly stage: string; readonly projection: string; readonly source: Origin },
    read: () => unknown,
  ) => (outcome: Outcome) => void
  readonly capture: () => Capture
}

class Unsupported extends Error {
  constructor(readonly reason: Extract<Snapshot, { status: "incomplete" }>["reason"]) {
    super(reason)
  }
}

/** Reads own data only. Missing properties are represented as undefined; accessors are never invoked. */
export function data(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) throw new Unsupported("unsupported")
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) throw new Unsupported("unsupported")
  return descriptor.value
}

/** Request-local observations. Hashes describe only complete projections, never plugin identity or wire bytes. */
export function create(): Collector {
  const records: Array<Capture["records"][number]> = []
  let ordinal = 0
  let omitted = 0
  let bytes = 0
  return {
    start(input, read) {
      ordinal += 1
      if (records.length >= MAX_RECORDS) {
        omitted += 1
        return () => {}
      }
      const record = {
        ordinal,
        stage: input.stage.slice(0, 256),
        projection: input.projection.slice(0, 256),
        source: {
          kind: input.source.kind,
          id: input.source.id.slice(0, 256),
          ordinal: input.source.ordinal,
          ...(input.source.entry === undefined ? {} : { entry: input.source.entry.slice(0, 512) }),
        },
        status: "pending" as Capture["records"][number]["status"],
        before: { status: "incomplete", reason: "read_error" } as Snapshot,
        change: "unknown" as Capture["records"][number]["change"],
        after: undefined as Snapshot | undefined,
      }
      // Reserve room for both complete snapshots and completion status before doing projection work.
      const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 512
      if (bytes + size > MAX_BYTES - 256) {
        omitted += 1
        return () => {}
      }
      bytes += size
      record.before = snapshot(read)
      records.push(record)
      return (outcome) => {
        if (record.status !== "pending") return
        record.after = snapshot(read)
        record.status = outcome
        record.change =
          record.before.status === "complete" && record.after.status === "complete"
            ? record.before.sha256 === record.after.sha256
              ? "unchanged"
              : "changed"
            : "unknown"
      }
    },
    capture() {
      return Object.freeze({
        version: 1,
        coverage: "observed prepared-request projections; not complete runtime or wire coverage",
        records: Object.freeze(
          records.map((record) =>
            Object.freeze({
              ...record,
              source: Object.freeze({ ...record.source }),
              before: Object.freeze({ ...record.before }),
              ...(record.after ? { after: Object.freeze({ ...record.after }) } : {}),
            }),
          ),
        ),
        omitted,
      })
    },
  }
}

function snapshot(read: () => unknown): Snapshot {
  let value: unknown
  try {
    value = read()
  } catch (error) {
    return { status: "incomplete", reason: error instanceof Unsupported ? error.reason : "read_error" }
  }
  const chunks: string[] = []
  const active = new Set<object>()
  let bytes = 0
  let nodes = 0
  function append(value: string) {
    if (value.length > MAX_BYTES - bytes) throw new Unsupported("byte_limit")
    const size = Buffer.byteLength(value, "utf8")
    if (size > MAX_BYTES - bytes) throw new Unsupported("byte_limit")
    bytes += size
    chunks.push(value)
  }
  function string(value: string) {
    // JSON escaping can expand a string, so check before allocating and again after encoding.
    if (value.length > MAX_BYTES - bytes) throw new Unsupported("byte_limit")
    append(JSON.stringify(value))
  }
  function walk(value: unknown, depth: number): void {
    if (++nodes > MAX_NODES) throw new Unsupported("node_limit")
    if (depth > MAX_DEPTH) throw new Unsupported("depth_limit")
    // Type tags retain undefined, holes, and lone surrogates without colliding with user data.
    // Byte counts describe this bounded encoding, rather than the provider's request encoding.
    if (value === undefined) return append('["undefined"]')
    if (value === null) return append("null")
    if (typeof value === "string") {
      append('["string",')
      string(value)
      return append("]")
    }
    if (typeof value === "boolean") return append(String(value))
    if (typeof value === "number" && Number.isFinite(value))
      return append(Object.is(value, -0) ? '["-0"]' : String(value))
    if (typeof value !== "object") throw new Unsupported("unsupported")
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Unsupported("unsupported")
    if (active.has(value)) throw new Unsupported("cycle")
    active.add(value)
    const toJSON = Object.getOwnPropertyDescriptor(value, "toJSON")
    if (toJSON && (!("value" in toJSON) || typeof toJSON.value === "function")) throw new Unsupported("unsupported")
    append(array ? '["array",[' : '["record",[')
    if (array) {
      const length = data(value, "length")
      if (typeof length !== "number") throw new Unsupported("unsupported")
      if (length > MAX_NODES - nodes) throw new Unsupported("node_limit")
      for (let index = 0; index < length; index++) {
        if (index) append(",")
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor) {
          nodes += 1
          append('["hole"]')
          continue
        }
        if (!("value" in descriptor)) throw new Unsupported("unsupported")
        walk(descriptor.value, depth + 1)
      }
    }
    let count = 0
    let inspected = 0
    // Avoid Object.keys/ownKeys allocating an unbounded list. Proxies can still run arbitrary traps;
    // this is a bounded data inspection, not a sandbox or a hard execution-time guarantee.
    // Non-enumerable and symbol properties are outside the JSON-visible projection.
    for (const key in value) {
      if (++inspected > MAX_NODES) throw new Unsupported("node_limit")
      if (key.length > MAX_BYTES) throw new Unsupported("byte_limit")
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable) continue
      if (array) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (data(value, "length") as number))
          throw new Unsupported("unsupported")
        continue
      }
      if (++nodes > MAX_NODES) throw new Unsupported("node_limit")
      if (!("value" in descriptor)) throw new Unsupported("unsupported")
      if (count++) append(",")
      append("[")
      string(key)
      append(",")
      walk(descriptor.value, depth + 1)
      append("]")
    }
    append("]]")
    active.delete(value)
  }
  try {
    walk(value, 0)
    return { status: "complete", bytes, sha256: createHash("sha256").update(chunks.join("")).digest("hex") }
  } catch (error) {
    return { status: "incomplete", reason: error instanceof Unsupported ? error.reason : "unsupported" }
  }
}
