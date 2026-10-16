import { expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { LLM, Model } from "@opencode-ai/llm"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { HistorySource } from "@opencode-ai/core/harness/history-source"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { metadata } from "@opencode-ai/core/harness/audit-metadata"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import type { ToolContextSource } from "@opencode-ai/schema/tool-context-source"

const created = DateTime.makeUnsafe(0)
const server = 'fixture,"server"'
const requestedURI = "custom:requested?query=*"
const body = "PRIVATE_SYNTHETIC_RESOURCE ação 🌍"
const contents = [
  { uri: "custom:returned/one", mimeType: "text/plain", text: body },
  { uri: "custom:returned/blob", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
  { uri: "custom:returned/two", mimeType: "text/plain", text: body },
]
const parts = contents.map((item) => {
  const { text, ...rest } = item
  return { type: "text" as const, text: text === undefined ? JSON.stringify(item) : JSON.stringify(rest) + "\n" + text }
})
const entries = [0, 2].map((contentIndex) => ({
  contentIndex,
  receipt: ToolSource.create({
    kind: "mcp-resource",
    origin: JSON.stringify({ server, requestedURI, uri: contents[contentIndex]!.uri }),
    output: parts[contentIndex]!.text,
    start: parts[contentIndex]!.text.length - body.length,
    end: parts[contentIndex]!.text.length,
  })!,
}))
const bundle: ToolContextSource.Bundle = { version: 1, projection: "original", entries, omitted: 0 }
const assistant = (
  sources: ToolContextSource.Bundle | undefined = bundle,
  structured: Record<string, unknown> = { contents },
  content = parts,
): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make("msg_mcp_source"),
  type: "assistant",
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  time: { created, completed: created },
  content: [
    {
      type: "tool",
      id: "call_mcp_source",
      name: "mcp",
      time: { created },
      state: {
        status: "completed",
        input: { operation: "read", server, uri: requestedURI },
        structured,
        content,
        contextSources: sources,
      },
    },
  ],
})

test("MCP text sources retain actual indices and distinct observed URIs while excluding blob wrappers", () => {
  const snapshot = HistorySource.capture([assistant()])
  expect(snapshot.count).toBe(2)
  expect(snapshot.sources.map((source) => source.tool?.contentIndex)).toEqual([0, 2])
  expect(snapshot.sources.map((source) => source.tool?.observation)).toMatchObject(
    entries.map((entry) => ({
      state: "matched",
      kind: "mcp-resource",
      origin: entry.receipt.origin,
      body: { bytes: Buffer.byteLength(body), type: "utf16-span" },
    })),
  )
  expect(entries[0]!.receipt.origin).not.toBe(entries[1]!.receipt.origin)
  expect(JSON.parse(entries[0]!.receipt.origin)).toEqual({ server, requestedURI, uri: contents[0]!.uri })
  const binary = assistant({ ...bundle, entries: [] }, { contents: [contents[1]!] }, [parts[1]!])
  expect(HistorySource.capture([binary])).toMatchObject({ count: 0, bytes: 0, sources: [] })
  expect(HistorySource.capture([assistant({ ...bundle, entries: [] }, { contents: [] }, [])])).toMatchObject({
    count: 0,
    sources: [],
  })
})

test("malformed or missing structured contents and replaced projections never verify resource origins", () => {
  for (const structured of [
    {},
    { contents: "invalid" },
    { contents: [contents[0]] },
    { contents: [{ ...contents[0], blob: "ambiguous" }, contents[1], contents[2]] },
  ]) {
    const snapshot = HistorySource.capture([assistant(bundle, structured)])
    expect(snapshot.sources).toHaveLength(3)
    expect(snapshot.sources.every((source) => source.tool?.observation.state === "unavailable")).toBe(true)
    expect(snapshot.sources.every((source) => !Object.hasOwn(source.tool!.observation, "origin"))).toBe(true)
  }
  const noReceipt = assistant()
  const tool = noReceipt.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected tool")
  const { contextSources, ...state } = tool.state
  const legacy = { ...noReceipt, content: [{ ...tool, state }] }
  expect(
    HistorySource.capture([legacy]).sources.every((source) => source.tool?.observation.state === "unavailable"),
  ).toBe(true)
  expect(
    HistorySource.capture([assistant({ ...bundle, projection: "replaced" })]).sources.every(
      (source) => source.tool?.observation.state === "unavailable",
    ),
  ).toBe(true)
  expect(
    HistorySource.capture([{ ...noReceipt, content: [{ ...tool, time: { created, pruned: created } }] }]).sources.every(
      (source) => source.tool?.observation.state === "unavailable",
    ),
  ).toBe(true)
})

test("all omitted receipts stay visible, mutations lose attribution, and discovery is not a body read", () => {
  const omitted = HistorySource.capture([assistant({ ...bundle, entries: [], omitted: 2 })])
  expect(omitted.sources).toHaveLength(2)
  expect(
    omitted.sources.every(
      (source) => source.tool?.omittedReceipts === 2 && source.tool.observation.state === "unavailable",
    ),
  ).toBe(true)
  const edited = HistorySource.capture([
    assistant(bundle, { contents }, [{ type: "text", text: "edited" }, ...parts.slice(1)]),
  ])
  expect(edited.sources[0]?.tool?.observation).toEqual({ state: "changed" })
  const mismatched = HistorySource.capture([
    assistant({ ...bundle, entries: [{ ...entries[0]!, receipt: entries[1]!.receipt }] }),
  ])
  expect(mismatched.sources[0]?.tool?.observation).not.toHaveProperty("origin")
  const wrongOrigin = ToolSource.create({
    kind: "mcp-resource",
    origin: JSON.stringify({ server: "other", requestedURI, uri: contents[0]!.uri }),
    output: parts[0]!.text,
    start: parts[0]!.text.length - body.length,
    end: parts[0]!.text.length,
  })!
  expect(
    HistorySource.capture([assistant({ ...bundle, entries: [{ contentIndex: 0, receipt: wrongOrigin }] })]).sources[0]
      ?.tool?.observation,
  ).toEqual({ state: "invalid" })
  const loaded = assistant()
  const tool = loaded.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected tool")
  for (const operation of ["connect", "resources", "templates", "search", "instructions"]) {
    expect(
      HistorySource.capture([
        { ...loaded, content: [{ ...tool, state: { ...tool.state, input: { operation, server } } }] },
      ]).sources,
    ).toEqual([])
  }
})

test("resource receipts stay outside encoded Responses bodies and metadata history excludes raw text", async () => {
  const loaded = assistant()
  const tool = loaded.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected tool")
  const { contextSources, ...state } = tool.state
  const plain = { ...loaded, content: [{ ...tool, state }] }
  const model = Model.make({ id: "model", provider: "provider", route: OpenAIResponses.route })
  const encoded = await Promise.all(
    [loaded, plain].map((message) =>
      Effect.runPromise(
        OpenAIResponses.protocol.body
          .from(LLM.request({ model, system: [], messages: toLLMMessages([message], model), tools: [] }))
          .pipe(Effect.flatMap(Schema.encodeEffect(OpenAIResponses.protocol.body.schema))),
      ),
    ),
  )
  expect(JSON.stringify(encoded[0])).toBe(JSON.stringify(encoded[1]))
  expect(JSON.stringify(encoded[0])).not.toContain("contextSources")
  expect(JSON.stringify(encoded[0])).not.toContain("hashEncoding")
  expect(JSON.stringify(encoded[0])).toContain(body)
  const report = ContextAudit.report(
    {
      runtime: "v2",
      sessionID: "ses_mcp",
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
  expect(report.historySnapshot?.sources[0]?.content).toBe(parts[0]!.text)
  expect(metadata(report).historySnapshot?.sources[0]?.tool?.observation).toMatchObject({
    state: "matched",
    kind: "mcp-resource",
  })
  expect(JSON.stringify(metadata(report))).not.toContain(body)
})
