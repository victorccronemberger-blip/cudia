import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ContextTrace } from "@opencode-ai/core/harness/trace"

const source = { kind: "file", id: "file:///plugin.ts", ordinal: 1 } as const
const input = { stage: "plugin", projection: "system", source }

function observe(value: unknown) {
  const trace = ContextTrace.create()
  trace.start(input, () => value)("success")
  return trace.capture().records[0]!
}

describe("ContextTrace", () => {
  test("observes each invocation, including changes later restored by a duplicate plugin", () => {
    const trace = ContextTrace.create()
    const system = ["original secret"]
    const first = trace.start(input, () => ({ system }))
    system[0] = "replacement secret"
    first("success")
    const second = trace.start({ ...input, source: { ...source, ordinal: 2 } }, () => ({ system }))
    system[0] = "original secret"
    second("success")
    const capture = trace.capture()
    expect(capture.records.map((item) => [item.ordinal, item.source.ordinal, item.change])).toEqual([
      [1, 1, "changed"],
      [2, 2, "changed"],
    ])
    expect(capture.records[0]!.before).toEqual(capture.records[1]!.after!)
    expect(JSON.stringify(capture)).not.toContain("secret")
    expect(Schema.decodeUnknownSync(ContextTrace.CaptureSchema)(capture)).toEqual(capture)
  })

  test("snapshots are fresh frozen copies, keep pending status and complete only once", () => {
    const trace = ContextTrace.create()
    let calls = 0
    const complete = trace.start(input, () => ++calls)
    const pending = trace.capture()
    complete("failure")
    complete("success")
    const finished = trace.capture()
    expect(calls).toBe(2)
    expect(pending.records[0]!.status).toBe("pending")
    expect(finished.records[0]!.status).toBe("failure")
    expect(finished.records[0]!.change).toBe("changed")
    expect(finished).not.toBe(trace.capture())
    expect(finished.records).not.toBe(trace.capture().records)
    for (const value of [
      finished,
      finished.records,
      finished.records[0],
      finished.records[0]!.source,
      finished.records[0]!.before,
    ])
      expect(Object.isFrozen(value)).toBe(true)
  })

  test("keeps collectors isolated across interleaved requests and explicit retries", async () => {
    const traces = await Promise.all(
      ["success", "interrupted"].map(async (outcome) => {
        const trace = ContextTrace.create()
        const first = trace.start(input, () => [outcome])
        await Promise.resolve()
        first(outcome as ContextTrace.Outcome)
        trace.start({ ...input, stage: "provider-transform" }, () => outcome)("success")
        return trace.capture()
      }),
    )
    expect(traces.map((trace) => trace.records.map((record) => record.ordinal))).toEqual([
      [1, 2],
      [1, 2],
    ])
    expect(traces[0]!.records[0]!.status).toBe("success")
    expect(traces[1]!.records[0]!.status).toBe("interrupted")
    expect(traces[0]!.records[0]!.before).not.toEqual(traces[1]!.records[0]!.before)
  })

  test("never executes accessors, toJSON or custom prototypes", () => {
    let calls = 0
    const accessor = Object.defineProperty({}, "system", { enumerable: true, get: () => ++calls })
    const toJSON = { toJSON: () => ++calls }
    const inherited = Object.create({
      get system() {
        return ++calls
      },
    })
    for (const value of [accessor, toJSON, inherited, new Date(), new URL("https://example.com"), () => 1]) {
      const record = observe(value)
      expect(record.before).toEqual({ status: "incomplete", reason: "unsupported" })
      expect(record.change).toBe("unknown")
      expect(record.before).not.toHaveProperty("sha256")
    }
    const trace = ContextTrace.create()
    trace.start(input, () => ContextTrace.data(accessor, "system"))("success")
    expect(trace.capture().records[0]!.before).toEqual({ status: "incomplete", reason: "unsupported" })
    expect(calls).toBe(0)
    expect(observe(Object.assign(Object.create(null), { system: ["plain"] })).change).toBe("unchanged")
  })

  test("preserves undefined, sparse arrays, null and lone surrogates without false equality", () => {
    const values = [undefined, null, [], Array(1), [undefined], "\ud800", "\ud801", -0, 0]
    const hashes = values
      .map((value) => observe(value).before)
      .map((snapshot) => {
        expect(snapshot.status).toBe("complete")
        return snapshot.status === "complete" ? snapshot.sha256 : ""
      })
    expect(new Set(hashes).size).toBe(values.length)
    const array = Object.defineProperty([], "0", {
      get: () => {
        throw new Error("must not run")
      },
    })
    expect(observe(array).before).toEqual({ status: "incomplete", reason: "unsupported" })
  })

  test("incomplete completion is unknown even when the original prefix remains", () => {
    const trace = ContextTrace.create()
    const system = ["prefix"]
    const complete = trace.start(input, () => ({ system }))
    system.push("x".repeat(ContextTrace.MAX_BYTES + 1))
    complete("success")
    expect(trace.capture().records[0]).toMatchObject({
      before: { status: "complete" },
      after: { status: "incomplete", reason: "byte_limit" },
      change: "unknown",
    })
    expect(trace.capture().records[0]!.after).not.toHaveProperty("sha256")
    expect(ContextTrace.data({}, "missing")).toBeUndefined()
  })

  test("bounds cycles, strings, keys, depth and wide objects before producing a digest", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    let deep: unknown = "leaf"
    for (let index = 0; index <= ContextTrace.MAX_DEPTH; index++) deep = { deep }
    const cases = [
      [cycle, "cycle"],
      ["x".repeat(ContextTrace.MAX_BYTES + 1), "byte_limit"],
      ["界".repeat(ContextTrace.MAX_BYTES / 2), "byte_limit"],
      [{ ["x".repeat(ContextTrace.MAX_BYTES + 1)]: 1 }, "byte_limit"],
      [deep, "depth_limit"],
      [Array(ContextTrace.MAX_NODES + 1), "node_limit"],
      [Object.fromEntries(Array.from({ length: ContextTrace.MAX_NODES + 1 }, (_, index) => [index, 1])), "node_limit"],
    ] as const
    for (const [value, reason] of cases) {
      const record = observe(value)
      expect(record.before).toEqual({ status: "incomplete", reason })
      expect(record.after).toEqual(record.before)
      expect(record.change).toBe("unknown")
    }
  })

  test("does bounded descriptor work for wide values and catches throwing metadata reads", () => {
    let inspected = 0
    const value = new Proxy(Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [index, 1])), {
      getOwnPropertyDescriptor(target, key) {
        inspected += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expect(observe(value).change).toBe("unknown")
    expect(inspected).toBeLessThan(ContextTrace.MAX_NODES * 3)
    const trace = ContextTrace.create()
    expect(() =>
      trace.start(input, () => {
        throw new Error("secret error")
      })("interrupted"),
    ).not.toThrow()
    expect(trace.capture().records[0]!.before).toEqual({ status: "incomplete", reason: "read_error" })
    expect(JSON.stringify(trace.capture())).not.toContain("secret error")
  })

  test("caps records and metadata, counts omissions and skips omitted projection work", () => {
    const trace = ContextTrace.create()
    let calls = 0
    for (let index = 0; index < ContextTrace.MAX_RECORDS + 10; index++) trace.start(input, () => ++calls)("success")
    expect(trace.capture().records).toHaveLength(ContextTrace.MAX_RECORDS)
    expect(trace.capture().omitted).toBe(10)
    expect(calls).toBe(ContextTrace.MAX_RECORDS * 2)
    const large = ContextTrace.create()
    for (let index = 0; index < 100; index++)
      large.start(
        {
          stage: "\u0000".repeat(10_000),
          projection: "\u0000".repeat(10_000),
          source: { kind: "npm", id: "\u0000".repeat(10_000), entry: "\u0000".repeat(10_000), ordinal: index },
        },
        () => "small",
      )("success")
    const capture = large.capture()
    expect(capture.omitted).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThanOrEqual(ContextTrace.MAX_BYTES)
    expect(capture.records[0]!.stage).toHaveLength(256)
    expect(capture.records[0]!.source.entry).toHaveLength(512)
  })
})
