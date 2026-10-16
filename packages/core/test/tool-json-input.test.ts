import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Exit, JsonSchema, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const context: Tool.Context = {
  sessionID: SessionV2.ID.make("ses_json_input"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_json_input"),
  toolCallID: "call-json-input",
}

const makeTool = (input: Schema.Codec<Record<string, unknown>>, execute: (input: Record<string, unknown>) => void) =>
  Tool.make({
    description: "Validate JSON input",
    input,
    output: Schema.Unknown,
    execute: (value) =>
      Effect.sync(() => {
        execute(value)
        return value
      }),
  })

const settle = (tool: Tool.AnyTool, input: unknown) =>
  Tool.settle(tool, { type: "tool-call", id: context.toolCallID, name: "json_input", input }, context)

describe("Tool.jsonInput", () => {
  it.effect("uses one frozen schema snapshot for validation and advertised definitions", () =>
    Effect.gen(function* () {
      const raw: JsonSchema.JsonSchema = {
        type: "object",
        properties: { count: { type: "integer", minimum: 2 } },
        required: ["count"],
        additionalProperties: false,
      }
      const codec = yield* Tool.jsonInput(raw)
      let executions = 0
      const tool = makeTool(codec, () => executions++)
      const mutable = raw.properties as Record<string, Record<string, unknown>>
      mutable.count.minimum = 0
      const definition = Tool.definition("json_input", tool)

      expect(definition.inputSchema).toEqual({
        type: "object",
        properties: { count: { type: "integer", minimum: 2 } },
        required: ["count"],
        additionalProperties: false,
      })
      expect(Object.isFrozen(definition.inputSchema)).toBeTrue()
      expect(Object.isFrozen((definition.inputSchema as JsonSchema.JsonSchema).properties)).toBeTrue()

      const invalid = yield* settle(tool, { count: 1 }).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBeTrue()
      expect(executions).toBe(0)
      yield* settle(tool, { count: 2 })
      expect(executions).toBe(1)
    }),
  )

  it.effect("preserves additional properties and rejects them when the schema forbids them", () =>
    Effect.gen(function* () {
      const allowed = yield* Tool.jsonInput({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: true,
      })
      let received: Record<string, unknown> | undefined
      const accepting = makeTool(allowed, (input) => (received = input))
      const input = { value: "kept", extra: 42 }
      yield* settle(accepting, input)
      expect(received).toEqual(input)
      expect(input).toEqual({ value: "kept", extra: 42 })

      const rejected = yield* Tool.jsonInput({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      })
      let executions = 0
      const rejecting = makeTool(rejected, () => executions++)
      expect(Exit.isFailure(yield* settle(rejecting, input).pipe(Effect.exit))).toBeTrue()
      expect(executions).toBe(0)
    }),
  )

  it.effect("preserves default annotations without applying them", () =>
    Effect.gen(function* () {
      const codec = yield* Tool.jsonInput({
        type: "object",
        properties: { enabled: { type: "boolean", default: true } },
      })
      let received: Record<string, unknown> | undefined
      const tool = makeTool(codec, (input) => (received = input))

      yield* settle(tool, {})

      expect(Tool.definition("defaults", tool).inputSchema).toMatchObject({
        properties: { enabled: { default: true } },
      })
      expect(received).toEqual({})
    }),
  )

  it.effect("treats ref-named properties and const data as ordinary schema data", () =>
    Effect.gen(function* () {
      const codec = yield* Tool.jsonInput({
        type: "object",
        properties: {
          $ref: { type: "string" },
          literal: { const: { $ref: "literal" } },
        },
        required: ["$ref", "literal"],
      })
      let executions = 0
      const tool = makeTool(codec, () => executions++)

      yield* settle(tool, { $ref: "value", literal: { $ref: "literal" } })

      expect(executions).toBe(1)
    }),
  )

  it.effect("validates local recursive references, unions, and conditional branches", () =>
    Effect.gen(function* () {
      const codec = yield* Tool.jsonInput({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          tree: { $ref: "#/$defs/node" },
          kind: { enum: ["named", "anonymous"] },
          payload: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          name: { type: "string" },
          id: { type: "integer" },
        },
        required: ["tree", "kind", "payload"],
        if: { properties: { kind: { const: "named" } }, required: ["kind"] },
        then: { required: ["name"] },
        else: { required: ["id"] },
        additionalProperties: false,
        $defs: {
          node: {
            type: "object",
            properties: {
              value: { type: "string" },
              children: { type: "array", items: { $ref: "#/$defs/node" } },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      })
      let executions = 0
      const tool = makeTool(codec, () => executions++)

      yield* settle(tool, {
        tree: { value: "root", children: [{ value: "leaf" }] },
        kind: "named",
        payload: null,
        name: "root",
      })
      expect(
        Exit.isFailure(
          yield* settle(tool, {
            tree: { value: "root", children: [{ children: [] }] },
            kind: "anonymous",
            payload: "value",
            id: 1,
          }).pipe(Effect.exit),
        ),
      ).toBeTrue()
      expect(executions).toBe(1)
    }),
  )

  it.effect("supports Draft-07 and Draft 2019-09 dialect features", () =>
    Effect.gen(function* () {
      const draft7 = yield* Tool.jsonInput({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "integer" }],
            additionalItems: false,
          },
        },
        required: ["pair"],
      })
      const draft2019 = yield* Tool.jsonInput({
        $schema: "https://json-schema.org/draft/2019-09/schema",
        type: "object",
        allOf: [{ properties: { value: { type: "string" } }, required: ["value"] }],
        unevaluatedProperties: false,
      })
      let executions = 0
      const seven = makeTool(draft7, () => executions++)
      const nineteen = makeTool(draft2019, () => executions++)

      yield* settle(seven, { pair: ["ok", 1] })
      expect(Exit.isFailure(yield* settle(seven, { pair: ["ok", 1, false] }).pipe(Effect.exit))).toBeTrue()
      yield* settle(nineteen, { value: "ok" })
      expect(Exit.isFailure(yield* settle(nineteen, { value: "ok", extra: true }).pipe(Effect.exit))).toBeTrue()
      expect(executions).toBe(2)
    }),
  )

  it.effect("validates standard formats without coercion", () =>
    Effect.gen(function* () {
      const codec = yield* Tool.jsonInput({
        type: "object",
        properties: { email: { type: "string", format: "email" }, count: { type: "integer" } },
        required: ["email", "count"],
      })
      let executions = 0
      const tool = makeTool(codec, () => executions++)

      yield* settle(tool, { email: "person@example.com", count: 2 })
      expect(Exit.isFailure(yield* settle(tool, { email: "not-an-email", count: 2 }).pipe(Effect.exit))).toBeTrue()
      expect(
        Exit.isFailure(yield* settle(tool, { email: "person@example.com", count: "2" }).pipe(Effect.exit)),
      ).toBeTrue()
      expect(executions).toBe(1)
    }),
  )

  it.effect("rejects unsupported dialects, remote references, unknown assertions, and oversized schemas", () =>
    Effect.gen(function* () {
      const invalidSchemas: ReadonlyArray<JsonSchema.JsonSchema> = [
        { $schema: "https://json-schema.org/draft/next/schema", type: "object" },
        { $schema: "http://json-schema.org/draft/2020-12/schema", type: "object" },
        { $schema: "http://json-schema.org/draft/2019-09/schema", type: "object" },
        { type: "object", properties: { value: { $ref: "https://example.com/schema.json" } } },
        { type: "object", properties: { value: { $ref: "#/$defs/missing" } } },
        { type: "object", unknownAssertion: true },
        { type: "object", $vocabulary: { "https://example.com/vocab": true } },
        { type: "object", description: "x".repeat(33 * 1024) },
        {
          type: "object",
          definitions: Object.fromEntries(Array.from({ length: 4100 }, (_, index) => [`d${index}`, true])),
        },
        Array.from({ length: 66 }).reduce<JsonSchema.JsonSchema>((nested) => ({ allOf: [nested] }), {
          type: "object",
        }),
      ]

      for (const raw of invalidSchemas) {
        const exit = yield* Tool.jsonInput(raw).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBeTrue()
        expect(Exit.isFailure(exit) && exit.cause).toBeDefined()
      }

      const withVendorAnnotation = yield* Tool.jsonInput({ type: "object", "x-provider-note": "kept" })
      expect(
        Tool.definition(
          "annotated",
          makeTool(withVendorAnnotation, () => undefined),
        ).inputSchema,
      ).toEqual({
        type: "object",
        "x-provider-note": "kept",
      })
    }),
  )

  it.effect("keeps ordinary Effect tool codecs on their existing schema path", () =>
    Effect.gen(function* () {
      let executions = 0
      const tool = Tool.make({
        description: "Ordinary Effect input",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Unknown,
        execute: ({ text }) =>
          Effect.sync(() => {
            executions++
            return text
          }),
      })
      const definition = Tool.definition("ordinary", tool)

      expect(definition.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } })
      yield* settle(tool, { text: "accepted" })
      expect(Exit.isFailure(yield* settle(tool, { text: 1 }).pipe(Effect.exit))).toBeTrue()
      expect(executions).toBe(1)
    }),
  )
})
