import { expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { LLM, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { HistorySource } from "@opencode-ai/core/harness/history-source"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { metadata } from "@opencode-ai/core/harness/audit-metadata"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import type { ToolContextSource } from "@opencode-ai/schema/tool-context-source"

const body = "PRIVATE_SYNTHETIC_BODY ação 🌍"
const origin = "fixture/SKILL.md"
const receipt = ToolSource.create({ kind: "skill", origin, output: body, start: 0, end: body.length })!
const bundle: ToolContextSource.Bundle = {
  version: 1,
  projection: "original",
  entries: [{ contentIndex: 0, receipt }],
  omitted: 0,
}
const created = DateTime.makeUnsafe(0)
const assistant = (sources: ToolContextSource.Bundle | null = bundle, text = body, pruned = false) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_loaded"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    time: { created, completed: created },
    content: [
      {
        type: "tool",
        id: "call_skill",
        name: "skill",
        time: { created, ...(pruned ? { pruned: created } : {}) },
        state: {
          status: "completed",
          input: { name: "fixture" },
          content: [{ type: "text", text }],
          structured: {},
          ...(sources ? { contextSources: sources } : {}),
        },
      },
    ],
  })

test("V2 source observation verifies stored text and strips origins after edits, pruning or replacement", () => {
  expect(HistorySource.capture([assistant()]).sources[0]).toMatchObject({
    messageID: "msg_loaded",
    partID: "call_skill",
    partIndex: 0,
    tool: {
      contentIndex: 0,
      receiptProjection: "original",
      omittedReceipts: 0,
      observation: { state: "matched", origin },
    },
  })
  for (const [message, state] of [
    [assistant(bundle, "edited"), "changed"],
    [assistant({ ...bundle, projection: "replaced" }), "unavailable"],
    [assistant(bundle, body, true), "unavailable"],
    [assistant({ ...bundle, entries: [], omitted: 1 }), "unavailable"],
    [assistant(null), "missing"],
  ] as const) {
    const observed = HistorySource.capture([message]).sources[0]?.tool?.observation
    expect(observed).toEqual({ state })
    expect(observed).not.toHaveProperty("origin")
  }
})

test("V2 source capture preserves positions, omits removed text, and ignores search and error results", () => {
  const loaded = assistant()
  const tool = loaded.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed tool")
  const search = { ...loaded, content: [{ ...tool, state: { ...tool.state, input: { query: "" } } }] }
  expect(HistorySource.capture([search]).sources).toEqual([])
  const empty = { ...loaded, content: [{ ...tool, state: { ...tool.state, content: [] } }] }
  expect(HistorySource.capture([empty])).toMatchObject({ count: 1, bytes: 0, sources: [] })
  const report = ContextAudit.report(
    {
      runtime: "v2",
      sessionID: "ses_source",
      agent: "build",
      model: { provider: "fixture", id: "fixture" },
      instructions: [],
      messages: [],
      tools: [],
      historySnapshot: HistorySource.capture([empty]),
    },
    { contextMode: "lean", auditMode: "summary" },
    "now",
  )
  expect(report.historySnapshot).toMatchObject({ sourceCount: 1, omittedSources: 1 })
  const error: SessionMessage.Assistant = {
    ...loaded,
    content: [
      {
        ...tool,
        state: {
          status: "error",
          input: { name: "fixture" },
          content: [],
          structured: {},
          error: { type: "unknown", message: "failed" },
        },
      },
    ],
  }
  expect(HistorySource.capture([error]).sources).toEqual([])
})

test("persisted source fields do not change lowered messages or encoded OpenAI request body", async () => {
  const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
  const loaded = assistant()
  const plain = assistant(null)
  const source = loaded.content[0]!
  if (source.type !== "tool" || source.state.status !== "completed") throw new Error("Expected tool")
  // Remove optional metadata rather than serialize undefined through a convenience default.
  const { contextSources, ...state } = source.state
  const without: SessionMessage.Assistant = { ...plain, content: [{ ...source, state }] }
  const encoded = await Promise.all(
    [loaded, without].map((message) =>
      Effect.runPromise(
        OpenAIChat.protocol.body
          .from(LLM.request({ model, system: [], messages: toLLMMessages([message], model), tools: [] }))
          .pipe(Effect.flatMap(Schema.encodeEffect(OpenAIChat.protocol.body.schema))),
      ),
    ),
  )
  expect(JSON.stringify(encoded[0])).toBe(JSON.stringify(encoded[1]))
  expect(JSON.stringify(encoded[0])).not.toContain(origin)
  expect(JSON.stringify(encoded[0])).not.toContain("contextSources")
  expect(JSON.stringify(encoded[0])).toContain(body)
  const report = ContextAudit.report(
    {
      runtime: "v2",
      sessionID: "ses_source",
      agent: "build",
      model: { provider: "fixture", id: "fixture" },
      instructions: [],
      messages: [],
      tools: [],
      historySnapshot: HistorySource.capture([loaded]),
    },
    { contextMode: "lean", auditMode: "content" },
    "now",
  )
  expect(report.historySnapshot?.sources[0]?.content).toBe(body)
  expect(metadata(report).historySnapshot?.sources[0]?.tool).toMatchObject({
    contentIndex: 0,
    receiptProjection: "original",
    omittedReceipts: 0,
  })
  expect(JSON.stringify(metadata(report))).not.toContain(body)
})
