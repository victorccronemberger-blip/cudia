import { describe, expect, test } from "bun:test"
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
