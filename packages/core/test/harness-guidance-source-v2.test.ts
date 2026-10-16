import { expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { LLM, Model } from "@opencode-ai/llm"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { HistorySource } from "@opencode-ai/core/harness/history-source"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import type { ToolContextSource } from "@opencode-ai/schema/tool-context-source"

const created = DateTime.makeUnsafe(0)
const server = "guidance-fixture"
const body = 'PRIVATE_SYNTHETIC_GUIDANCE "quoted"\n ação 🌍 \\ literal'
const result = { server, instructions: body }
const rendered = JSON.stringify(result)
const receipt = ToolSource.create({ kind: "mcp-guidance", origin: server, output: rendered })!
const bundle: ToolContextSource.Bundle = {
  version: 1,
  projection: "original",
  entries: [{ contentIndex: 0, receipt }],
  omitted: 0,
}
const message = (
  structured: Record<string, unknown> = result,
  text = rendered,
  contextSources: ToolContextSource.Bundle | undefined = bundle,
  pruned = false,
): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make("msg_guidance"),
  type: "assistant",
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  time: { created, completed: created },
  content: [
    {
      type: "tool",
      id: "call_guidance",
      name: "mcp",
      time: { created, ...(pruned ? { pruned: created } : {}) },
      state: {
        status: "completed",
        input: { operation: "instructions", server },
        structured,
        content: [{ type: "text", text }],
        contextSources,
      },
    },
  ],
})

test("cached guidance observes decoded JSON bodies and distinguishes empty from absent", () => {
  const observed = HistorySource.capture([message()]).sources[0]
  expect(observed).toMatchObject({
    messageID: "msg_guidance",
    partID: "call_guidance",
    tool: {
      contentIndex: 0,
      observation: {
        state: "matched",
        kind: "mcp-guidance",
        origin: server,
        body: { type: "json-member", member: "instructions", bytes: Buffer.byteLength(body) },
      },
    },
  })
  for (const instructions of ["", "  \n ", body]) {
    const output = { server, instructions }
    const text = JSON.stringify(output)
    const source = ToolSource.create({ kind: "mcp-guidance", origin: server, output: text })!
    expect(
      HistorySource.capture([message(output, text, { ...bundle, entries: [{ contentIndex: 0, receipt: source }] })])
        .sources[0]?.tool?.observation,
    ).toMatchObject({ state: "matched", body: { bytes: Buffer.byteLength(instructions) } })
  }
  for (const sources of [bundle, { ...bundle, projection: "replaced" as const }]) {
    expect(HistorySource.capture([message({ server }, JSON.stringify({ server }), sources, true)])).toMatchObject({
      count: 0,
      bytes: 0,
      sources: [],
    })
  }
})

test("malformed, replaced, pruned and edited guidance cannot retain a verified origin", () => {
  for (const structured of [
    {},
    { instructions: body },
    { server: "other", instructions: body },
    { server, instructions: 1 },
  ]) {
    expect(HistorySource.capture([message(structured)]).sources[0]?.tool?.observation).toEqual({ state: "unavailable" })
  }
  expect(HistorySource.capture([message(result, rendered + "changed")]).sources[0]?.tool?.observation).toEqual({
    state: "changed",
  })
  expect(
    HistorySource.capture([message(result, rendered, { ...bundle, projection: "replaced" })]).sources[0]?.tool
      ?.observation,
  ).toEqual({ state: "unavailable" })
  expect(HistorySource.capture([message(result, rendered, bundle, true)]).sources[0]?.tool?.observation).toEqual({
    state: "unavailable",
  })
  expect(
    HistorySource.capture([message(result, rendered, { ...bundle, entries: [], omitted: 1 })]).sources[0]?.tool,
  ).toMatchObject({ omittedReceipts: 1, observation: { state: "unavailable" } })
  const legacy = message()
  const tool = legacy.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected tool")
  const { contextSources, ...state } = tool.state
  expect(HistorySource.capture([{ ...legacy, content: [{ ...tool, state }] }]).sources[0]?.tool?.observation).toEqual({
    state: "missing",
  })
  const otherText = JSON.stringify({ server: "other", instructions: body })
  const other = ToolSource.create({ kind: "mcp-guidance", origin: "other", output: otherText })!
  expect(
    HistorySource.capture([message(result, otherText, { ...bundle, entries: [{ contentIndex: 0, receipt: other }] })])
      .sources[0]?.tool?.observation,
  ).toEqual({ state: "invalid" })
})

test("guidance receipt metadata does not alter the encoded Responses body or add system instructions", async () => {
  const loaded = message()
  const tool = loaded.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected tool")
  const { contextSources, ...state } = tool.state
  const plain = { ...loaded, content: [{ ...tool, state }] }
  const model = Model.make({ id: "model", provider: "provider", route: OpenAIResponses.route })
  const encoded = await Promise.all(
    [loaded, plain].map((item) =>
      Effect.runPromise(
        OpenAIResponses.protocol.body
          .from(LLM.request({ model, system: [], messages: toLLMMessages([item], model), tools: [] }))
          .pipe(Effect.flatMap(Schema.encodeEffect(OpenAIResponses.protocol.body.schema))),
      ),
    ),
  )
  expect(JSON.stringify(encoded[0])).toBe(JSON.stringify(encoded[1]))
  expect(JSON.stringify(encoded[0])).not.toContain("contextSources")
  expect(JSON.stringify(encoded[0])).not.toContain("hashEncoding")
  expect(JSON.stringify(encoded[0])).toContain("PRIVATE_SYNTHETIC_GUIDANCE")
})
