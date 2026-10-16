import { describe, expect, test } from "bun:test"
import { LLMRequest, Message, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { HistoryProjection } from "@opencode-ai/core/session/runner/history-projection"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { DateTime } from "effect"

const created = DateTime.makeUnsafe(0)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: messageID(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })
const completedTool = (
  id: string,
  content: SessionMessage.ToolStateCompleted["content"],
  provider?: SessionMessage.AssistantTool["provider"],
  result?: unknown,
) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name: "skill",
    ...(provider === undefined ? {} : { provider }),
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: { name: "fixture" },
      content,
      structured: {},
      ...(result === undefined ? {} : { result }),
    }),
    time: { created, completed: created },
  })

const source = (input: {
  messageID: string
  partID: string
  messageIndex: number
  partIndex: number
  contentIndex: number
  origin: string
  text: string
}) => {
  const receipt = ToolSource.create({
    kind: "skill",
    origin: input.origin,
    output: input.text,
    start: 0,
    end: input.text.length,
  })
  return {
    source: "loaded-tool-result" as const,
    messageID: input.messageID,
    partID: input.partID,
    messageIndex: input.messageIndex,
    partIndex: input.partIndex,
    text: input.text,
    tool: {
      name: "skill",
      callID: input.partID,
      contentIndex: input.contentIndex,
      observation: ToolSource.inspect(input.text, { contextSource: receipt }),
    },
  }
}

const snapshot = (sources: ReturnType<typeof source>[]) => ({
  id: "history_fixture",
  count: sources.length,
  bytes: sources.reduce((total, item) => total + Buffer.byteLength(item.text), 0),
  sources,
})

describe("HistoryProjection", () => {
  test("maps original part positions to exact prepared tool-result objects without changing conversion", () => {
    const firstMessageID = messageID("first")
    const secondMessageID = messageID("second")
    const first = "duplicate body"
    const second = "nested body"
    const inline = "inline body"
    const native = "native body"
    const file = FileAttachment.make({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "image.png" })
    const messages = [
      SessionMessage.User.make({ id: messageID("user"), type: "user", text: "Question", time: { created } }),
      assistant("first", [
        SessionMessage.AssistantText.make({ type: "text", id: "empty", text: "" }),
        completedTool("reused-call", [{ type: "text", text: first }]),
        completedTool("mixed-call", [
          { type: "file", uri: file.uri, mime: file.mime, name: file.name },
          { type: "text", text: second },
        ]),
        completedTool("inline-call", [{ type: "text", text: inline }], { executed: true }),
        completedTool(
          "native-call",
          [{ type: "text", text: native }],
          { executed: true },
          { type: "text", value: native },
        ),
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "pending-call",
          name: "skill",
          state: SessionMessage.ToolStatePending.make({
            status: "pending",
            input: JSON.stringify({ name: "fixture" }),
          }),
          time: { created },
        }),
      ]),
      assistant("second", [completedTool("reused-call", [{ type: "text", text: first }])]),
    ]
    const collector = HistoryProjection.create(
      snapshot([
        source({
          messageID: firstMessageID,
          partID: "reused-call",
          messageIndex: 1,
          partIndex: 1,
          contentIndex: 0,
          origin: "first/SKILL.md",
          text: first,
        }),
        source({
          messageID: firstMessageID,
          partID: "mixed-call",
          messageIndex: 1,
          partIndex: 2,
          contentIndex: 1,
          origin: "mixed/SKILL.md",
          text: second,
        }),
        source({
          messageID: firstMessageID,
          partID: "inline-call",
          messageIndex: 1,
          partIndex: 3,
          contentIndex: 0,
          origin: "inline/SKILL.md",
          text: inline,
        }),
        source({
          messageID: firstMessageID,
          partID: "native-call",
          messageIndex: 1,
          partIndex: 4,
          contentIndex: 0,
          origin: "native/SKILL.md",
          text: native,
        }),
        source({
          messageID: firstMessageID,
          partID: "pending-call",
          messageIndex: 1,
          partIndex: 5,
          contentIndex: 0,
          origin: "pending/SKILL.md",
          text: "pending body",
        }),
        source({
          messageID: secondMessageID,
          partID: "reused-call",
          messageIndex: 2,
          partIndex: 0,
          contentIndex: 0,
          origin: "second/SKILL.md",
          text: first,
        }),
      ]),
    )

    const untraced = toLLMMessages(messages, model)
    const traced = toLLMMessages(messages, model, collector)
    expect(traced).toEqual(untraced)
    expect(traced.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "tool"])
    const request = new LLMRequest({ model, system: [], messages: traced, tools: [] })
    collector.copied(
      traced.map((message) => ({ role: message.role, content: message.content })),
      request.messages,
    )
    const captured = collector.capture(request.messages)
    expect(captured.mapping).toBe("observed-at-prepared-request")
    expect(captured.sources.map((item) => item.prepared)).toEqual([
      { state: "mapped", messageIndex: 2, partIndex: 0, role: "tool", resultType: "text" },
      { state: "mapped", messageIndex: 3, partIndex: 0, role: "tool", resultType: "content", resultContentIndex: 1 },
      { state: "mapped", messageIndex: 1, partIndex: 3, role: "assistant", resultType: "text" },
      { state: "unmapped", reason: "native-override" },
      { state: "unmapped", reason: "not-observed" },
      { state: "mapped", messageIndex: 5, partIndex: 0, role: "tool", resultType: "text" },
    ])
  })

  test("keeps duplicate text distinct and reports identity mismatches or repeated occurrences", () => {
    const body = "same words"
    const first = completedTool("same-call", [{ type: "text", text: body }])
    const second = completedTool("same-call", [{ type: "text", text: body }])
    const messages = [assistant("one", [first]), assistant("two", [second])]
    const collector = HistoryProjection.create(
      snapshot([
        source({
          messageID: messageID("two"),
          partID: "same-call",
          messageIndex: 1,
          partIndex: 0,
          contentIndex: 0,
          origin: "second/SKILL.md",
          text: body,
        }),
        source({
          messageID: messageID("one"),
          partID: "wrong-call",
          messageIndex: 0,
          partIndex: 0,
          contentIndex: 0,
          origin: "wrong/SKILL.md",
          text: body,
        }),
      ]),
    )
    const messagesOut = toLLMMessages(messages, model, collector)
    expect(messagesOut.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"])
    expect(messagesOut[2]?.id).toBe(messageID("two"))
    expect(collector.capture(messagesOut).sources.map((item) => item.prepared)).toEqual([
      { state: "mapped", messageIndex: 3, partIndex: 0, role: "tool", resultType: "text" },
      { state: "unmapped", reason: "source-mismatch" },
    ])

    const repeated = HistoryProjection.create(
      snapshot([
        source({
          messageID: messageID("one"),
          partID: "same-call",
          messageIndex: 0,
          partIndex: 0,
          contentIndex: 0,
          origin: "one/SKILL.md",
          text: body,
        }),
      ]),
    )
    const samePreparedResult = toLLMMessages([assistant("one", [first])], model, repeated)
    const resultPart = samePreparedResult[1]!.content[0]!
    const duplicated = Message.make({ id: messageID("duplicate"), role: "tool", content: [resultPart, resultPart] })
    repeated.copied([{ role: "tool", content: [resultPart, resultPart] }], [duplicated])
    samePreparedResult.push(duplicated)
    expect(repeated.capture(samePreparedResult).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "ambiguous-occurrence",
    })
  })

  test("marks copied or changed prepared results as unmapped", () => {
    const body = "verified body"
    const original = completedTool("verified-call", [{ type: "text", text: body }])
    const collector = HistoryProjection.create(
      snapshot([
        source({
          messageID: messageID("verified"),
          partID: "verified-call",
          messageIndex: 0,
          partIndex: 0,
          contentIndex: 0,
          origin: "verified/SKILL.md",
          text: body,
        }),
      ]),
    )
    const converted = toLLMMessages([assistant("verified", [original])], model, collector)
    const resultPart = converted[1]!.content[0]!
    converted[1] = Message.make({ ...converted[1]!, content: [{ ...resultPart }] })
    expect(collector.capture(converted).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "not-observed",
    })

    const changed = HistoryProjection.create(
      snapshot([
        source({
          messageID: messageID("verified"),
          partID: "verified-call",
          messageIndex: 0,
          partIndex: 0,
          contentIndex: 0,
          origin: "verified/SKILL.md",
          text: body,
        }),
      ]),
    )
    const changedMessages = toLLMMessages([assistant("verified", [original])], model, changed)
    const changedPart = changedMessages[1]!.content[0]!
    if (changedPart.type !== "tool-result" || changedPart.result.type !== "text")
      throw new Error("Expected text tool result")
    Object.defineProperty(changedPart.result, "value", { value: "prepared-value-changed" })
    expect(changed.capture(changedMessages).sources[0]?.prepared).toEqual({
      state: "unmapped",
      reason: "prepared-value-changed",
    })
  })

  for (const boundary of ["arity", "role", "id", "result kind"] as const) {
    test(`does not recover a source after a rejected ${boundary} copy boundary`, () => {
      const body = "boundary body"
      const collector = HistoryProjection.create(
        snapshot([
          source({
            messageID: messageID("boundary"),
            partID: "boundary-call",
            messageIndex: 0,
            partIndex: 0,
            contentIndex: 0,
            origin: "boundary/SKILL.md",
            text: body,
          }),
        ]),
      )
      const converted = toLLMMessages(
        [assistant("boundary", [completedTool("boundary-call", [{ type: "text", text: body }])])],
        model,
        collector,
      )
      const resultPart = converted[1]!.content[0]!
      if (resultPart.type !== "tool-result") throw new Error("Expected tool result")
      const before = [{ role: "tool", content: [resultPart] }]
      const rejected = Message.make({
        role: boundary === "role" ? "assistant" : "tool",
        content: boundary === "arity" ? [resultPart, resultPart] : [resultPart],
      })
      if (boundary === "id") Object.defineProperty(rejected.content[0]!, "id", { value: "changed-id" })
      if (boundary === "result kind") {
        Object.defineProperty(rejected.content[0]!, "result", { value: { type: "json", value: {} } })
      }
      collector.copied(before, [rejected])

      const laterValidCopy = Message.make({ role: "tool", content: [resultPart] })
      collector.copied(before, [laterValidCopy])
      expect(collector.capture([laterValidCopy]).sources[0]?.prepared).toEqual({
        state: "unmapped",
        reason: "copy-boundary-changed",
      })
    })
  }
})
