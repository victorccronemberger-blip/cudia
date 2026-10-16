import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextManifest } from "@opencode-ai/core/harness/context-manifest"
import { ContextTrace } from "@opencode-ai/core/harness/trace"

const sample: ContextAudit.Input = {
  runtime: "v1-ai-sdk",
  sessionID: "ses_trace",
  agent: "build",
  model: { provider: "test", id: "test" },
  instructions: [],
  messages: [],
  tools: [],
}
const policy = { contextMode: "standard", auditMode: "summary" } as const

const messageSource = (text: string, messageIndex = 0) => ({
  source: "compaction-prompt",
  role: "user",
  messageIndex,
  partIndex: 0,
  text,
})

describe("ContextAudit message attribution", () => {
  test("separates user-message sources from instructions and hashes exact UTF-8 text", () => {
    const text = "Private synthetic history: ação 🌍"
    const input = {
      ...sample,
      purpose: "compaction" as const,
      compactionMessageID: "msg_attempt",
      messages: [{ role: "user" }],
      messageSources: [messageSource(text)],
    }
    const report = ContextAudit.report(input, policy, "now")
    expect(report).toMatchObject({
      purpose: "compaction",
      compactionMessageID: "msg_attempt",
      instructionCount: 0,
      messageSourceCount: 1,
      messageSourceBytes: Buffer.byteLength(text),
      messageRoles: { user: 1 },
    })
    expect(report.messageSources).toEqual([
      {
        source: "compaction-prompt",
        role: "user",
        messageIndex: 0,
        partIndex: 0,
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ])
    expect(JSON.stringify(report)).not.toContain(text)
    expect(Schema.decodeUnknownSync(ContextAudit.StoredReport)(report)).toEqual(report)
  })

  test("message text shares the exact content allowance with instructions, including Unicode", () => {
    const text = "🌍".repeat((ContextAudit.MAX_CONTENT_BYTES - 4) / 4)
    const report = ContextAudit.report(
      {
        ...sample,
        instructions: [{ source: "agent", text: "éé" }],
        messageSources: [messageSource(text), messageSource("no room", 1)],
      },
      { ...policy, auditMode: "content" },
      "now",
    )
    expect(report.instructions[0]?.content).toBe("éé")
    expect(report.messageSources?.[0]?.content).toBe(text)
    expect(report.messageSources?.[1]).toMatchObject({ contentOmitted: true })
    expect(report.messageSources?.[1]).not.toHaveProperty("content")
    expect(
      Buffer.byteLength(report.instructions[0]!.content!) + Buffer.byteLength(report.messageSources![0]!.content!),
    ).toBe(ContextAudit.MAX_CONTENT_BYTES)
    const oversized = ContextAudit.report(
      { ...sample, messageSources: [messageSource(text + "🌍🌍"), messageSource("small", 1)] },
      { ...policy, auditMode: "content" },
      "now",
    )
    expect(oversized.messageSources?.[0]).toMatchObject({ contentOmitted: true })
    expect(oversized.messageSources?.[1]?.content).toBe("small")
  })

  test("bounds attribution records and metadata, with explicit counts for omitted sources", () => {
    const sources = Array.from({ length: 130 }, (_, index) => messageSource("history " + index, index))
    const report = ContextAudit.report({ ...sample, messageSources: sources }, policy, "now")
    expect(report.messageSources).toHaveLength(128)
    expect(report.messageSourceCount).toBe(130)
    expect(report.omittedMessageSources).toBe(2)
    expect(report.messageSourceBytes).toBe(sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0))
    const bounded = ContextAudit.report(
      {
        ...sample,
        messageSources: [
          { ...messageSource("large metadata"), messageID: "x".repeat(ContextAudit.MAX_MANIFEST_BYTES) },
          messageSource("still fits", 1),
        ],
      },
      policy,
      "now",
    )
    expect(bounded.messageSources).toHaveLength(1)
    expect(bounded.messageSources?.[0]?.messageIndex).toBe(1)
    expect(bounded.omittedMessageSources).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(bounded.messageSources))).toBeLessThan(ContextAudit.MAX_MANIFEST_BYTES)
  })

  test("shares metadata with origin manifests and preserves older captures with unknown purpose", () => {
    const text = "instruction"
    const make = (id: string) =>
      ContextManifest.create([
        { producer: "agent", phase: "baseline", text, origins: [{ kind: "file", id, start: 0, end: text.length }] },
      ]).manifest
    const manifest = make(
      "x".repeat(ContextAudit.MAX_MANIFEST_BYTES - Buffer.byteLength(JSON.stringify(make("x"))) + 1),
    )
    const report = ContextAudit.report(
      { ...sample, instructions: [{ source: "agent", text, manifest }], messageSources: [messageSource("history")] },
      policy,
      "now",
    )
    expect(report.instructions[0]?.originState).toBe("valid")
    expect(report.messageSources).toEqual([])
    expect(report.omittedMessageSources).toBe(1)
    const { purpose, ...legacy } = ContextAudit.report({ ...sample, purpose: "main" }, policy, "now")
    const decode = Schema.decodeUnknownSync(ContextAudit.StoredReport)
    expect(decode(legacy)).not.toHaveProperty("purpose")
    expect(decode({ ...legacy, version: 1 })).not.toHaveProperty("purpose")
    expect(purpose).toBe("main")
    expect(ContextAudit.report(sample, policy, "now")).not.toHaveProperty("purpose")
    expect(() => decode({ ...legacy, purpose: "unsupported" })).toThrow()
  })
})

function capture() {
  const trace = ContextTrace.create()
  for (let ordinal = 0; ordinal < 64; ordinal++)
    trace.start(
      {
        stage: "plugin",
        projection: "system",
        source: { kind: "file", id: "file:///plugin.ts", ordinal },
      },
      () => ({ system: ["private prompt token"] }),
    )("success")
  return trace.capture()
}

describe("ContextAudit transformation trace", () => {
  test("message-source metadata also shares the allowance with instruction origins and trace", () => {
    const text = "instruction"
    const manifest = ContextManifest.create([
      {
        producer: "agent",
        phase: "baseline",
        text,
        origins: [{ kind: "file", id: "x".repeat(50_000), start: 0, end: text.length }],
      },
    ]).manifest
    const report = ContextAudit.report(
      {
        ...sample,
        instructions: [{ source: "agent", text, manifest }],
        messageSources: Array.from({ length: 50 }, (_, index) => messageSource("private history", index)),
        trace: capture(),
      },
      policy,
      "now",
    )
    expect(report.messageSources).toHaveLength(50)
    expect(report.trace!.records.length).toBeLessThan(64)
    const metadataBytes =
      Buffer.byteLength(JSON.stringify(report.instructions[0]!.contextManifest)) +
      report.messageSources!.reduce((sum, source) => sum + Buffer.byteLength(JSON.stringify(source)), 0) +
      Buffer.byteLength(JSON.stringify(report.trace))
    expect(metadataBytes).toBeLessThanOrEqual(ContextAudit.MAX_MANIFEST_BYTES)
    expect(JSON.stringify(report)).not.toContain("private history")
    expect(Schema.decodeUnknownSync(ContextAudit.StoredReport)(report)).toEqual(report)
  })

  test("persists metadata only and keeps pre-trace v1/v2 reports readable", () => {
    const report = ContextAudit.report({ ...sample, trace: capture() }, policy, "2026-10-16T00:00:00Z")
    expect(report.trace?.records).toHaveLength(64)
    expect(JSON.stringify(report)).not.toContain("private prompt token")
    expect(Schema.decodeUnknownSync(ContextAudit.StoredReport)(report)).toEqual(report)
    const old = ContextAudit.report(sample, policy, "2026-10-16T00:00:00Z")
    expect(old).not.toHaveProperty("trace")
    const decode = Schema.decodeUnknownSync(ContextAudit.StoredReport)
    expect(decode(old)).toEqual(old)
    expect(decode({ ...old, version: 1 })).toMatchObject({ version: 1 })
  })

  test("shares the manifest budget, preserving instruction hashes and explicit trace omissions", () => {
    const text = "small instruction"
    const manifest = ContextManifest.create([
      {
        producer: "agent",
        phase: "baseline",
        text,
        origins: [{ kind: "file", id: "x".repeat(50_000), start: 0, end: text.length }],
      },
    ]).manifest
    const report = ContextAudit.report(
      {
        ...sample,
        trace: capture(),
        instructions: [{ source: "agent", text, manifest }],
      },
      policy,
      "2026-10-16T00:00:00Z",
    )
    expect(report.instructions[0]!.originState).toBe("valid")
    expect(report.trace!.records.length).toBeLessThan(64)
    expect(report.trace!.omitted).toBe(64 - report.trace!.records.length)
    expect(report.traceOmission).toEqual({ reason: "byte_limit", records: report.trace!.omitted })
    const metadata =
      Buffer.byteLength(JSON.stringify(report.instructions[0]!.contextManifest)) +
      Buffer.byteLength(JSON.stringify(report.trace))
    expect(metadata).toBeLessThanOrEqual(ContextAudit.MAX_MANIFEST_BYTES)
    expect(Schema.decodeUnknownSync(ContextAudit.StoredReport)(report)).toEqual(report)
  })

  test("omits the entire trace explicitly when manifests consume the metadata allowance", () => {
    const text = "instruction"
    const make = (id: string) =>
      ContextManifest.create([
        {
          producer: "agent",
          phase: "baseline",
          text,
          origins: [{ kind: "file", id, start: 0, end: text.length }],
        },
      ]).manifest
    const manifest = make(
      "x".repeat(ContextAudit.MAX_MANIFEST_BYTES - Buffer.byteLength(JSON.stringify(make("x"))) + 1),
    )
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBe(ContextAudit.MAX_MANIFEST_BYTES)
    const report = ContextAudit.report(
      {
        ...sample,
        trace: capture(),
        instructions: [{ source: "agent", text, manifest }],
      },
      policy,
      "2026-10-16T00:00:00Z",
    )
    expect(report.instructions[0]!.originState).toBe("valid")
    expect(report.trace).toBeUndefined()
    expect(report.traceOmission).toEqual({ reason: "byte_limit", records: 64 })
    expect(Schema.decodeUnknownSync(ContextAudit.StoredReport)(report)).toEqual(report)
  })
})
