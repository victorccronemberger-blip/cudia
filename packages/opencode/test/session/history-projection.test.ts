import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLMRequest } from "@opencode-ai/llm"
import type { ModelMessage } from "ai"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { HistoryProjection } from "../../src/session/history-projection"
import { HistorySource } from "../../src/session/history-source"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { LLMNative } from "../../src/session/llm/native-request"

const sessionID = SessionID.make("ses_history_projection")
const providerID = ProviderV2.ID.make("fixture")
const model: Provider.Model = {
  id: ModelV2.ID.make("fixture-model"),
  providerID,
  api: { id: "fixture-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Fixture",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const userInfo = (id: string): SessionV1.User =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: model.id },
    tools: {},
    mode: "",
  }) as unknown as SessionV1.User

const assistantInfo = (id: string, parentID = "msg_parent"): SessionV1.Assistant =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID,
    modelID: model.api.id,
    providerID: model.providerID,
    mode: "",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as SessionV1.Assistant

const basePart = (messageID: string, partID: string) => ({
  id: PartID.make(partID),
  sessionID,
  messageID: MessageID.make(messageID),
})

const skillReceipt = (origin: string, output: string) =>
  ToolSource.create({ kind: "skill", origin, output, start: 0, end: output.length })

const guidanceReceipt = (server: string, output: string) =>
  ToolSource.create({ kind: "mcp-guidance", origin: server, output })

const loader = (input: {
  readonly messageID: string
  readonly partID: string
  readonly callID: string
  readonly tool?: "skill" | "mcp"
  readonly input: Record<string, unknown>
  readonly output: string
  readonly receipt?: ToolSource.Receipt
  readonly attachments?: ReadonlyArray<{ mime: string; filename?: string; url: string }>
  readonly compacted?: boolean
}): SessionV1.WithParts => ({
  info: assistantInfo(input.messageID),
  parts: [
    {
      ...basePart(input.messageID, input.partID),
      type: "tool",
      tool: input.tool ?? "skill",
      callID: input.callID,
      state: {
        status: "completed",
        input: input.input,
        output: input.output,
        title: input.tool ?? "skill",
        metadata: input.receipt === undefined ? {} : { contextSource: input.receipt },
        time: { start: 1, end: 2, ...(input.compacted ? { compacted: 3 } : {}) },
        ...(input.attachments ? { attachments: input.attachments } : {}),
      },
    } as SessionV1.ToolPart,
  ],
})

describe("V1 history projection", () => {
  test("observes actual rendered skill and MCP guidance results without changing provider messages", async () => {
    const repeatedOutput = "same loaded text"
    const nestedOutput = "nested media text"
    const server = "guidance-fixture"
    const guidance = JSON.stringify({ server, instructions: "cached guidance body" })
    const messages: SessionV1.WithParts[] = [
      { info: userInfo("msg_empty"), parts: [] },
      loader({
        messageID: "msg_skill_one",
        partID: "prt_skill_one",
        callID: "call-reused",
        input: { name: "one" },
        output: repeatedOutput,
        receipt: skillReceipt("one/SKILL.md", repeatedOutput),
      }),
      loader({
        messageID: "msg_skill_two",
        partID: "prt_skill_two",
        callID: "call-reused",
        input: { name: "two" },
        output: repeatedOutput,
        receipt: skillReceipt("two/SKILL.md", repeatedOutput),
      }),
      loader({
        messageID: "msg_skill_media",
        partID: "prt_skill_media",
        callID: "call-media",
        input: { name: "media" },
        output: nestedOutput,
        receipt: skillReceipt("media/SKILL.md", nestedOutput),
        attachments: [{ mime: "image/png", filename: "fixture.png", url: "data:image/png;base64,aGVsbG8=" }],
      }),
      loader({
        messageID: "msg_guidance",
        partID: "prt_guidance",
        callID: "call-guidance",
        tool: "mcp",
        input: { operation: "instructions", server },
        output: guidance,
        receipt: guidanceReceipt(server, guidance),
      }),
    ]
    const original = structuredClone(messages)
    const snapshot = HistorySource.capture(messages)
    const baseline = await MessageV2.toModelMessages(structuredClone(messages), model)
    const collector = HistoryProjection.create(snapshot)
    const converted = await MessageV2.toModelMessages(messages, model, { historyProjection: collector })

    expect(messages).toEqual(original)
    expect(converted).toEqual(baseline)
    const captured = collector.capture(converted)
    expect(captured.mapping).toBe("observed-at-prepared-request")
    expect(
      captured.sources.map((source) => [source.messageID, source.partID, source.messageIndex, source.partIndex]),
    ).toEqual([
      ["msg_skill_one", "prt_skill_one", 1, 0],
      ["msg_skill_two", "prt_skill_two", 2, 0],
      ["msg_skill_media", "prt_skill_media", 3, 0],
      ["msg_guidance", "prt_guidance", 4, 0],
    ])
    expect(captured.sources.map((source) => source.prepared)).toEqual([
      { state: "mapped", messageIndex: 1, partIndex: 0, role: "tool", resultType: "text" },
      { state: "mapped", messageIndex: 3, partIndex: 0, role: "tool", resultType: "text" },
      { state: "mapped", messageIndex: 5, partIndex: 0, role: "tool", resultType: "content", resultContentIndex: 0 },
      { state: "mapped", messageIndex: 7, partIndex: 0, role: "tool", resultType: "text" },
    ])
    expect(
      captured.sources.map((source) => (source.prepared?.state === "mapped" ? source.prepared.resultType : undefined)),
    ).toEqual(["text", "text", "content", "text"])
    expect(captured.sources[2]?.prepared).toMatchObject({ resultContentIndex: 0 })
    const serialized = JSON.stringify(converted)
    expect(serialized).toContain(repeatedOutput)
    expect(serialized).toContain(nestedOutput)
    expect(serialized).toContain("cached guidance body")
    expect(serialized).not.toContain("contextSource")
    expect(serialized).not.toContain("one/SKILL.md")
    expect(serialized).not.toContain('"origin"')

    const repeated = converted[1]!
    expect(collector.capture([...converted, repeated]).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "ambiguous-occurrence",
    })
  })

  test("marks a tracked loader ambiguous when an untracked tool reuses its input object", async () => {
    const sharedInput = { name: "shared" }
    const output = "shared identity result"
    const tracked = loader({
      messageID: "msg_tracked",
      partID: "prt_tracked",
      callID: "call-tracked",
      input: sharedInput,
      output,
      receipt: skillReceipt("shared/SKILL.md", output),
    })
    const untracked = {
      info: assistantInfo("msg_untracked"),
      parts: [
        {
          ...basePart("msg_untracked", "prt_untracked"),
          type: "tool",
          tool: "read",
          callID: "call-untracked",
          state: {
            status: "completed",
            input: sharedInput,
            output,
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        } as SessionV1.ToolPart,
      ],
    } satisfies SessionV1.WithParts
    const messages = [tracked, untracked]
    const snapshot = HistorySource.capture(messages)
    expect(snapshot.sources).toHaveLength(1)
    const collector = HistoryProjection.create(snapshot)
    const converted = await MessageV2.toModelMessages(messages, model, { historyProjection: collector })
    expect(collector.capture(converted).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "ambiguous-occurrence",
    })
  })

  test("keeps excerpts, compacted output, and changed final leaves from claiming the stored body", async () => {
    const output = "The complete stored result with action details."
    const excerpts = loader({
      messageID: "msg_excerpt",
      partID: "prt_excerpt",
      callID: "call-excerpt",
      input: { name: "excerpt" },
      output,
      receipt: skillReceipt("excerpt/SKILL.md", output),
    })
    const compacted = loader({
      messageID: "msg_compacted",
      partID: "prt_compacted",
      callID: "call-compacted",
      input: { name: "compacted" },
      output,
      receipt: skillReceipt("compacted/SKILL.md", output),
      compacted: true,
    })
    const snapshot = HistorySource.capture([excerpts, compacted])
    const collector = HistoryProjection.create(snapshot)
    const converted = await MessageV2.toModelMessages([excerpts, compacted], model, {
      toolOutputMaxChars: 8,
      historyProjection: collector,
    })
    expect(collector.capture(converted).sources.map((source) => source.prepared)).toEqual([
      { state: "unmapped", reason: "prepared-value-changed" },
      { state: "unmapped", reason: "prepared-value-changed" },
    ])

    const surrogate = "observed \uD800"
    const surrogateMessage = loader({
      messageID: "msg_surrogate",
      partID: "prt_surrogate",
      callID: "call-surrogate",
      input: { name: "surrogate" },
      output: surrogate,
      receipt: skillReceipt("surrogate/SKILL.md", surrogate),
    })
    const surrogateCollector = HistoryProjection.create(HistorySource.capture([surrogateMessage]))
    const surrogateOutput = await MessageV2.toModelMessages([surrogateMessage], model, {
      historyProjection: surrogateCollector,
    })
    const normalized = ProviderTransform.message(surrogateOutput, model, {})
    expect(JSON.stringify(normalized)).toContain("observed �")
    expect(surrogateCollector.capture(normalized).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "prepared-value-changed",
    })
  })

  test("observes provider-executed results inline without moving them to a tool message", async () => {
    const message = loader({
      messageID: "msg_inline",
      partID: "prt_inline",
      callID: "call-inline",
      input: { name: "inline" },
      output: "inline body",
    })
    const part = message.parts[0]
    if (part?.type !== "tool") throw new Error("Expected tool part")
    part.metadata = { providerExecuted: true }
    const collector = HistoryProjection.create(HistorySource.capture([message]))
    const converted = await MessageV2.toModelMessages([message], model, { historyProjection: collector })
    expect(converted.map((message) => message.role)).toEqual(["assistant"])
    expect(collector.capture(converted).sources[0]?.prepared).toEqual({
      state: "mapped",
      messageIndex: 0,
      partIndex: 1,
      role: "assistant",
      resultType: "text",
    })
  })

  test("reports source mismatches, primitive inputs, and unobserved copies without invoking accessors", async () => {
    const output = "verified loader output"
    const message = loader({
      messageID: "msg_verified",
      partID: "prt_verified",
      callID: "call-verified",
      input: { name: "verified" },
      output,
      receipt: skillReceipt("verified/SKILL.md", output),
    })
    const snapshot = HistorySource.capture([message])
    const mismatch = HistoryProjection.create({
      ...snapshot,
      sources: snapshot.sources.map((source) => ({ ...source, messageID: "msg_other" })),
    })
    const mismatchOutput = await MessageV2.toModelMessages([message], model, { historyProjection: mismatch })
    expect(mismatch.capture(mismatchOutput).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "source-mismatch",
    })

    const unobserved = HistoryProjection.create(snapshot)
    const unobservedOutput = await MessageV2.toModelMessages([message], model, { historyProjection: unobserved })
    expect(unobserved.capture(structuredClone(unobservedOutput)).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "not-observed",
    })

    const calls = { count: 0 }
    const outputWithGetter = {
      get content() {
        calls.count += 1
        throw new Error("getter invoked")
      },
    }
    const getterCollector = HistoryProjection.create(snapshot)
    expect(getterCollector.capture([outputWithGetter]).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "not-observed",
    })
    expect(calls.count).toBe(0)

    const primitiveSnapshot = {
      ...snapshot,
      sources: snapshot.sources.map((source) => ({ ...source })),
    }
    const primitiveCollector = HistoryProjection.create(primitiveSnapshot)
    const primitiveInputMessage = structuredClone(message)
    const part = primitiveInputMessage.parts[0]
    if (part.type !== "tool") throw new Error("Expected tool part")
    part.state.input = "primitive" as unknown as Record<string, unknown>
    const primitiveOutput = await MessageV2.toModelMessages([primitiveInputMessage], model, {
      historyProjection: primitiveCollector,
    })
    expect(primitiveCollector.capture(primitiveOutput).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "unsupported-result",
    })
  })

  test("tracks native request copies through system filtering, update, and ambiguous final aliases", async () => {
    const output = "native loaded skill text"
    const stored = loader({
      messageID: "msg_native",
      partID: "prt_native",
      callID: "call_native",
      input: { name: "native" },
      output,
      receipt: skillReceipt("native/SKILL.md", output),
    })
    const collector = HistoryProjection.create(HistorySource.capture([stored]))
    const prepared = await MessageV2.toModelMessages([stored], model, { historyProjection: collector })
    const nativeInput: ModelMessage[] = [
      { role: "system", content: "system before" },
      ...prepared.slice(0, 1),
      { role: "system", content: "system between" },
      ...prepared.slice(1),
    ]
    const request = LLMNative.request({ model, messages: nativeInput, historyProjection: collector })
    const baseline = LLMNative.request({ model, messages: nativeInput })

    expect(request.system).toEqual(baseline.system)
    expect(request.messages).toEqual(baseline.messages)
    expect(request.messages.map((message) => message.role)).toEqual(["assistant", "tool"])
    expect(collector.capture(request.messages).sources[0]?.prepared).toEqual({
      state: "mapped",
      messageIndex: 1,
      partIndex: 0,
      role: "tool",
      resultType: "text",
    })
    const updated = LLMRequest.update(request, { system: [...request.system] })
    expect(collector.capture(updated.messages).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "not-observed",
    })
    collector.nativeCopied(request.messages, updated.messages)
    expect(collector.capture(updated.messages).sources[0]?.prepared).toEqual({
      state: "mapped",
      messageIndex: 1,
      partIndex: 0,
      role: "tool",
      resultType: "text",
    })
    expect(JSON.stringify(request)).not.toContain("contextSource")
    expect(JSON.stringify(request)).not.toContain("native/SKILL.md")
    expect(collector.capture([...request.messages, request.messages[1]!]).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "ambiguous-occurrence",
    })
    expect(collector.capture(structuredClone(request.messages)).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "not-observed",
    })
  })

  test("keeps native copy-boundary failures sticky and reports a changed result value", async () => {
    const output = "native result before adapter mutation"
    const stored = loader({
      messageID: "msg_native_changed",
      partID: "prt_native_changed",
      callID: "call_native_changed",
      input: { name: "native-changed" },
      output,
      receipt: skillReceipt("native-changed/SKILL.md", output),
    })
    const collector = HistoryProjection.create(HistorySource.capture([stored]))
    const prepared = await MessageV2.toModelMessages([stored], model, { historyProjection: collector })
    const toolMessage = prepared.find((message) => message.role === "tool")
    if (!toolMessage) throw new Error("Expected tool result message")
    const resultParts = toolMessage.content as unknown as Array<{
      type: string
      output: { type: string; value: unknown }
    }>
    const resultPart = resultParts.find((part) => part.type === "tool-result")
    if (!resultPart) throw new Error("Expected tool result part")
    Object.defineProperty(resultPart.output, "value", { value: "native result changed" })
    const request = LLMNative.request({ model, messages: prepared, historyProjection: collector })
    expect(collector.capture(request.messages).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "prepared-value-changed",
    })

    for (const boundary of ["arity", "role", "id", "name", "result-kind"] as const) {
      const rejectedCollector = HistoryProjection.create(HistorySource.capture([stored]))
      const rejectedPrepared = await MessageV2.toModelMessages([stored], model, {
        historyProjection: rejectedCollector,
      })
      const rejected = LLMNative.request({ model, messages: rejectedPrepared, historyProjection: rejectedCollector })
      const changed = LLMRequest.update(rejected, { tools: [...rejected.tools] })
      const toolMessage = changed.messages[1]!
      const toolPart = toolMessage.content[0]!
      if (boundary === "role") Object.defineProperty(toolMessage, "role", { value: "assistant" })
      if (boundary === "id") Object.defineProperty(toolPart, "id", { value: "different-call" })
      if (boundary === "name") Object.defineProperty(toolPart, "name", { value: "different-tool" })
      if (boundary === "result-kind") Object.defineProperty(toolPart, "result", { value: { type: "json", value: {} } })
      rejectedCollector.nativeCopied(rejected.messages, boundary === "arity" ? [] : changed.messages)
      const later = LLMRequest.update(rejected, { tools: [...rejected.tools] })
      rejectedCollector.nativeCopied(rejected.messages, later.messages)
      expect(rejectedCollector.capture(later.messages).sources[0]?.prepared).toEqual({
        state: "unmapped",
        reason: "copy-boundary-changed",
      })
    }
  })

  test("does not claim nested content that the native adapter renders as JSON", async () => {
    const output = "native nested text"
    const stored = loader({
      messageID: "msg_native_nested",
      partID: "prt_native_nested",
      callID: "call_native_nested",
      input: { name: "native-nested" },
      output,
      receipt: skillReceipt("native-nested/SKILL.md", output),
      attachments: [{ mime: "image/png", filename: "nested.png", url: "data:image/png;base64,aGVsbG8=" }],
    })
    const collector = HistoryProjection.create(HistorySource.capture([stored]))
    const prepared = await MessageV2.toModelMessages([stored], model, { historyProjection: collector })
    const request = LLMNative.request({ model, messages: prepared, historyProjection: collector })
    const baseline = LLMNative.request({ model, messages: prepared })
    expect(request.messages).toEqual(baseline.messages)
    expect(collector.capture(request.messages).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "unsupported-result",
    })
    expect(JSON.stringify(request)).toContain(output)
    expect(JSON.stringify(request)).not.toContain("native-nested/SKILL.md")
  })
})
