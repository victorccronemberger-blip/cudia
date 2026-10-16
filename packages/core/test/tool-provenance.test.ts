import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolProvenance } from "@opencode-ai/core/tool/provenance"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { SessionV2 } from "@opencode-ai/core/session"
import { toolIdentity } from "./lib/tool"

const context = { ...toolIdentity, sessionID: SessionV2.ID.make("ses_provenance"), toolCallID: "call_source" }
const call = { type: "tool-call" as const, id: context.toolCallID, name: "skill", input: { name: "fixture" } }
const receipt = (text: string, origin = "fixture/SKILL.md") =>
  ToolSource.create({ kind: "skill", origin, output: text, start: 0, end: text.length })!
const outputSchema = Schema.Struct({ text: Schema.String })

test("canonical settlement preserves definitions/output bytes and isolates concurrent identical bodies", async () => {
  const make = (origin?: string) =>
    Tool.make({
      description: "Synthetic loader",
      input: Schema.Struct({ name: Schema.String }),
      output: outputSchema,
      execute: () =>
        Effect.sync(() => {
          const output = { text: "identical body" }
          return origin
            ? ToolProvenance.attach(output, [{ contentIndex: 0, receipt: receipt(output.text, origin) }])
            : output
        }),
      toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    })
  const plain = make()
  const first = make("first/SKILL.md")
  const second = make("second/SKILL.md")
  expect(JSON.stringify(Tool.definition("skill", first))).toBe(JSON.stringify(Tool.definition("skill", plain)))
  const results = await Promise.all(
    [plain, first, second].map((tool) => Effect.runPromise(Tool.settle(tool, call, context))),
  )
  expect(JSON.stringify(results[1])).toBe(JSON.stringify(results[0]))
  expect(JSON.stringify(results[2])).toBe(JSON.stringify(results[0]))
  expect(ToolProvenance.take(results[0])).toBeUndefined()
  expect(ToolProvenance.take(results[1])?.entries[0]?.receipt.origin).toBe("first/SKILL.md")
  expect(ToolProvenance.take(results[2])?.entries[0]?.receipt.origin).toBe("second/SKILL.md")
  expect(ToolProvenance.take(results[1])).toBeUndefined()
})

test("reused domain objects cannot transfer a receipt twice", async () => {
  const domain = ToolProvenance.attach({ text: "body" }, [{ contentIndex: 0, receipt: receipt("body") }])
  const tool = Tool.make({
    description: "reuse",
    input: Schema.Unknown,
    output: outputSchema,
    execute: () => Effect.succeed(domain),
  })
  const first = await Effect.runPromise(Tool.settle(tool, call, context))
  const second = await Effect.runPromise(Tool.settle(tool, call, context))
  expect(ToolProvenance.take(domain)).toBeUndefined()
  expect(ToolProvenance.take(first)?.entries).toHaveLength(1)
  expect(ToolProvenance.take(second)).toBeUndefined()
})

test("encoding and projection failures consume domain attachments without a successful transfer", async () => {
  for (const projectionFailure of [false, true]) {
    const domain = ToolProvenance.attach({ text: "body" }, [{ contentIndex: 0, receipt: receipt("body") }])
    const tool = Tool.make({
      description: "failure",
      input: Schema.Unknown,
      output: projectionFailure ? outputSchema : Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(1)) }),
      execute: () => Effect.succeed(domain),
      toModelOutput: () => {
        throw new Error("projection failed")
      },
    })
    expect(Exit.isFailure(await Effect.runPromiseExit(Tool.settle(tool, call, context)))).toBe(true)
    expect(ToolProvenance.take(domain)).toBeUndefined()
  }
})

test("cancellation while executing has no completed output or successful receipt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const tool = Tool.make({
        description: "cancel",
        input: Schema.Unknown,
        output: outputSchema,
        execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const fiber = yield* Tool.settle(tool, call, context).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.scoped),
  )
})

test("sidecar copies only allowlisted receipt data and bounds count and bytes with omissions", () => {
  const source = receipt("body", "a".repeat(1024))
  const domain = {}
  let getterCalls = 0
  Object.defineProperty(source, "privateContent", {
    get: () => {
      getterCalls += 1
      return "SECRET"
    },
  })
  ToolProvenance.attach(
    domain,
    Array.from({ length: 20 }, (_, contentIndex) => ({ contentIndex, receipt: source })),
  )
  const bundle = ToolProvenance.take(domain)!
  expect(bundle.entries).toHaveLength(8)
  expect(bundle.omitted).toBe(12)
  expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(ToolProvenance.MAX_BYTES)
  expect(JSON.stringify(bundle)).not.toContain("SECRET")
  expect(getterCalls).toBe(0)
  expect(Object.isFrozen(bundle.entries[0]?.receipt.body)).toBe(true)
  expect(Object.isFrozen(source)).toBe(false)
  ToolProvenance.attach(domain, [
    { contentIndex: 0, receipt: undefined },
    { contentIndex: -1, receipt: source },
  ])
  expect(ToolProvenance.take(domain)).toMatchObject({ entries: [], omitted: 2 })
})
