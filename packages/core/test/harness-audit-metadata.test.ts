import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextManifest } from "@opencode-ai/core/harness/context-manifest"
import { ContextTrace } from "@opencode-ai/core/harness/trace"
import { metadata } from "@opencode-ai/core/harness/audit-metadata"

function sample() {
  const text = "SYNTHETIC_PRIVATE_INSTRUCTION ação 🌍"
  const manifest = ContextManifest.create([
    {
      producer: "agent",
      phase: "baseline",
      text,
      origins: [{ kind: "file", id: "fixture/AGENTS.md", start: 0, end: text.length }],
    },
  ]).manifest
  const trace = ContextTrace.create()
  const state = { text: "SYNTHETIC_PRIVATE_HOOK_INPUT" }
  const finish = trace.start(
    { stage: "fixture-hook", projection: "system", source: { kind: "runtime", id: "fixture", ordinal: 1 } },
    () => state,
  )
  state.text = "SYNTHETIC_PRIVATE_HOOK_OUTPUT"
  finish("success")
  return ContextAudit.report(
    {
      runtime: "v2",
      purpose: "compaction",
      compactionMessageID: "msg_attempt",
      historySnapshot: {
        id: "snapshot_fixture",
        count: 1,
        bytes: 34,
        sources: [
          {
            messageID: "msg_persisted",
            partID: "prt_persisted",
            messageIndex: 0,
            partIndex: 0,
            text: "SYNTHETIC_PRIVATE_CHECKPOINT_SOURCE",
          },
        ],
      },
      sessionID: "ses_fixture",
      agent: "compaction",
      model: { provider: "fixture", id: "fixture" },
      instructions: [{ source: "agent", text, manifest, messageID: "msg_instruction", baselineSeq: 4 }],
      messages: [{ role: "user" }],
      messageSources: [
        {
          source: "compaction-prompt",
          role: "user",
          messageIndex: 0,
          partIndex: 0,
          messageID: "msg_checkpoint",
          text: "SYNTHETIC_PRIVATE_HISTORY",
        },
      ],
      tools: [
        {
          name: "fixture",
          description: "SYNTHETIC_PRIVATE_DESCRIPTION",
          inputSchema: { token: "SYNTHETIC_PRIVATE_SCHEMA" },
        },
      ],
      trace: trace.capture(),
    },
    { contextMode: "lean", auditMode: "content" },
    "2026-10-16T17:00:00Z",
  )
}

describe("Context audit historical metadata", () => {
  test("keeps origin, attempt, checkpoint and transformation evidence without raw content", () => {
    const report = sample()
    const projected = metadata(report)
    expect(Schema.decodeUnknownSync(ContextAudit.Report)(projected)).toEqual(projected)
    expect(JSON.stringify(projected)).not.toContain("SYNTHETIC_PRIVATE")
    expect(projected.contentIncluded).toBe(false)
    expect(projected.instructions[0]?.contextManifest).toEqual(report.instructions[0]?.contextManifest)
    expect(projected.instructions[0]?.sha256).toBe(report.instructions[0]?.sha256)
    expect(projected.instructions[0]).toMatchObject({ messageID: "msg_instruction", baselineSeq: 4 })
    expect(projected).toMatchObject({
      purpose: "compaction",
      compactionMessageID: "msg_attempt",
      messageSources: [{ messageID: "msg_checkpoint" }],
    })
    expect(projected.trace).toEqual(report.trace)
    expect(projected.captureID).toBe(report.captureID)
    expect(projected.historySnapshot).toMatchObject({
      id: "snapshot_fixture",
      mapping: "unmapped-after-conversion",
      sources: [{ messageID: "msg_persisted", partID: "prt_persisted" }],
    })
    expect(projected.historySnapshot?.sources[0]).not.toHaveProperty("content")
    expect(report.instructions[0]?.content).toContain("SYNTHETIC_PRIVATE_INSTRUCTION")
    expect(report.messageSources?.[0]?.content).toBe("SYNTHETIC_PRIVATE_HISTORY")
  })

  test("ignores unknown fields and raw-content getters at every retained object boundary", () => {
    const report = structuredClone(sample())
    const manifest = report.instructions[0]!.contextManifest!
    const objects = [
      report,
      report.model,
      report.instructions[0]!,
      manifest,
      manifest.parts[0]!,
      manifest.parts[0]!.origins[0]!,
      report.messageSources![0]!,
      report.tools[0]!,
      report.historySnapshot!,
      report.historySnapshot!.sources[0]!,
      report.trace!,
      report.trace!.records[0]!,
      report.trace!.records[0]!.source,
      report.trace!.records[0]!.before,
      report.trace!.records[0]!.after!,
    ]
    for (const value of objects)
      Object.defineProperty(value, "futureRawText", {
        enumerable: true,
        get() {
          throw new Error("Unknown fields must not be inspected")
        },
      })
    for (const value of [report.instructions[0]!, report.messageSources![0]!, report.historySnapshot!.sources[0]!])
      Object.defineProperty(value, "content", {
        enumerable: true,
        get() {
          throw new Error("Raw content must not be inspected")
        },
      })
    const projected = metadata(report)
    expect(JSON.stringify(projected)).not.toContain("futureRawText")
    expect(projected.instructions[0]).not.toHaveProperty("content")
    expect(projected.messageSources?.[0]).not.toHaveProperty("content")
  })

  test("owns nested metadata so subsequent changes to the live report do not rewrite retained evidence", () => {
    const report = sample()
    const before = JSON.stringify(report)
    const projected = metadata(report)
    expect(JSON.stringify(report)).toBe(before)
    const retained = JSON.stringify(projected)
    const changed = report as unknown as {
      model: { id: string }
      messageRoles: Record<string, number>
      instructions: { contextManifest: { parts: { origins: { id: string }[] }[] } }[]
    }
    changed.model.id = "changed"
    changed.messageRoles.user = 999
    changed.instructions[0]!.contextManifest.parts[0]!.origins[0]!.id = "changed"
    expect(JSON.stringify(projected)).toBe(retained)
  })

  test("preserves unclassified V1 and omission indicators without inferring a completed compaction", () => {
    const { purpose, compactionMessageID, ...report } = sample()
    const projected = metadata({
      ...report,
      runtime: "v1-ai-sdk",
      omittedInstructions: 2,
      omittedMessageSources: 3,
      omittedTools: 4,
      traceOmission: { reason: "byte_limit", records: 5 },
      instructions: report.instructions.map((item) => ({
        ...item,
        originState: "omitted",
        contextManifest: undefined,
        originOmission: { reason: "byte_limit", bytes: 65537 },
      })),
    })
    expect(projected).not.toHaveProperty("purpose")
    expect(projected).not.toHaveProperty("compactionMessageID")
    expect(projected).toMatchObject({
      runtime: "v1-ai-sdk",
      omittedInstructions: 2,
      omittedMessageSources: 3,
      omittedTools: 4,
      traceOmission: { records: 5 },
    })
    expect(projected.instructions[0]).toMatchObject({ originState: "omitted", originOmission: { bytes: 65537 } })
  })
})
