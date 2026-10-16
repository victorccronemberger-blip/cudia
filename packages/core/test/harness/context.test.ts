import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextManifest } from "@opencode-ai/core/harness/context-manifest"
import { HarnessPolicy } from "@opencode-ai/core/harness/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { tmpdir } from "../fixture/tmpdir"
import { it, testEffect } from "../lib/effect"

const policyLayer = (input: Record<string, unknown>) =>
  AppNodeBuilder.build(HarnessPolicy.node).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))
const readPolicy = HarnessPolicy.Service.useSync((policy) => policy)

const instructionText = "private instruction api_key=sk-test-secret"
const instructionManifest = ContextManifest.create([
  {
    producer: "agent",
    phase: "baseline",
    text: instructionText,
    origins: [{ kind: "file", id: "/private/project/AGENTS.md", start: 0, end: instructionText.length }],
  },
]).manifest

const sample = {
  runtime: "v1-ai-sdk" as const,
  sessionID: "ses_harness_context_test",
  agent: "build",
  model: { provider: "test-provider", id: "test-model" },
  instructions: [
    { source: "agent", text: instructionText, manifest: instructionManifest, messageID: "msg_context", baselineSeq: 7 },
  ],
  messages: [{ role: "system" }, { role: "user" }, { role: "assistant" }],
  tools: [
    {
      name: "bash",
      description: "do not persist this description",
      inputSchema: { properties: { token: { const: "schema-secret-value" } } },
    },
  ],
}

const auditLayer = (
  tmp: string,
  config: Record<string, unknown>,
  filesystem = LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem])),
) =>
  AppNodeBuilder.build(ContextAudit.node, [
    [Global.node, Global.layerWith({ state: tmp })],
    [FSUtil.node, filesystem],
  ]).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))))

const skill = SkillV2.Info.make({
  name: "effect",
  description: "Build applications with Effect",
  location: AbsolutePath.make("/skills/effect/SKILL.md"),
  content: "Effect skill body",
})
const build = AgentV2.ID.make("build")
const guidanceLayer = (contextMode: HarnessPolicy.Interface["contextMode"]) =>
  AppNodeBuilder.build(SkillGuidance.node, [
    [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed([skill]) })],
    [
      HarnessPolicy.node,
      Layer.succeed(HarnessPolicy.Service, HarnessPolicy.Service.of({ contextMode, auditMode: "off" })),
    ],
  ])

const failingRenameFS = (filesystem: FSUtil.Interface) =>
  Layer.succeed(
    FSUtil.Service,
    FSUtil.Service.of({
      ...filesystem,
      rename: (source, destination) =>
        destination.endsWith(ContextAudit.FILE)
          ? filesystem.rename(`${source}.missing`, destination)
          : filesystem.rename(source, destination),
    }),
  )

describe("HarnessPolicy", () => {
  it.effect("defaults to standard context and audit off", () =>
    Effect.gen(function* () {
      expect(yield* readPolicy.pipe(Effect.provide(policyLayer({})))).toEqual({
        contextMode: "standard",
        auditMode: "off",
      })
    }),
  )

  it.effect("accepts configured modes and rejects unsupported values", () =>
    Effect.gen(function* () {
      expect(
        yield* readPolicy.pipe(
          Effect.provide(policyLayer({ CUDIA_CONTEXT_MODE: "lean", CUDIA_CONTEXT_AUDIT: "summary" })),
        ),
      ).toEqual({ contextMode: "lean", auditMode: "summary" })

      const invalid = yield* Effect.exit(
        readPolicy.pipe(Effect.provide(policyLayer({ CUDIA_CONTEXT_MODE: "compact" }))),
      )
      expect(invalid._tag).toBe("Failure")
      const invalidAudit = yield* Effect.exit(
        readPolicy.pipe(Effect.provide(policyLayer({ CUDIA_CONTEXT_AUDIT: "full" }))),
      )
      expect(invalidAudit._tag).toBe("Failure")
    }),
  )
})

describe("SkillGuidance harness context", () => {
  const standard = testEffect(guidanceLayer("standard"))
  const lean = testEffect(guidanceLayer("lean"))

  standard.effect("keeps skill metadata in standard mode", () =>
    Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance
          .load({ id: build, info: AgentV2.Info.empty(build) })
          .pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toContain("- effect: Build applications with Effect")
    }),
  )

  lean.effect("omits the catalog in lean mode", () =>
    Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance
          .load({ id: build, info: AgentV2.Info.empty(build) })
          .pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({ baseline: "", snapshot: {}, manifest: ContextManifest.create([]).manifest })
    }),
  )
})

describe("ContextAudit", () => {
  test("decodes stored v1 reports without fabricating origins and rejects unknown versions", () => {
    const legacy = {
      version: 1,
      boundary: "prepared request before provider adapter; not a wire capture",
      runtime: "v1-ai-sdk",
      time: "2026-10-15T00:00:00.000Z",
      sessionID: "ses_legacy_audit",
      agent: "build",
      model: { provider: "test-provider", id: "test-model" },
      contextMode: "standard",
      contentIncluded: true,
      instructions: [
        {
          source: "agent",
          bytes: Buffer.byteLength("legacy instruction"),
          sha256: "0".repeat(64),
          content: "legacy instruction",
        },
        { source: "old-omission", bytes: 65_537, sha256: "1".repeat(64), contentOmitted: true },
      ],
      instructionCount: 2,
      instructionBytes: Buffer.byteLength("legacy instruction") + 65_537,
      messageCount: 1,
      messageRoles: { system: 1 },
      toolCount: 0,
      toolDefinitionBytes: 0,
      tools: [],
    }
    const decode = Schema.decodeUnknownSync(ContextAudit.StoredReport)
    const decoded = decode(legacy)

    expect(decoded).toMatchObject({ version: 1, instructions: legacy.instructions })
    expect(decoded.instructions[0]).not.toHaveProperty("originState")
    expect(decoded.instructions[0]).not.toHaveProperty("contextManifest")
    expect(() => decode({ ...legacy, version: 3 })).toThrow()
  })

  test("summary reports counts, roles, sizes, and hashes without storing instructions or tool details", () => {
    const report = ContextAudit.report(
      sample,
      { contextMode: "standard", auditMode: "summary" },
      "2026-10-15T00:00:00.000Z",
    )
    const serialized = JSON.stringify(report)

    expect(report).toMatchObject({
      version: 2,
      runtime: "v1-ai-sdk",
      contextMode: "standard",
      contentIncluded: false,
      instructionBytes: Buffer.byteLength(sample.instructions[0]!.text),
      messageCount: 3,
      messageRoles: { system: 1, user: 1, assistant: 1 },
      toolCount: 1,
      tools: [{ name: "bash", bytes: expect.any(Number) }],
    })
    expect(report.instructions[0]).toMatchObject({
      source: "agent",
      bytes: expect.any(Number),
      sha256: expect.any(String),
      originState: "valid",
      contextManifest: instructionManifest,
      messageID: "msg_context",
      baselineSeq: 7,
    })
    expect(serialized).not.toContain("private instruction")
    expect(serialized).not.toContain("sk-test-secret")
    expect(serialized).toContain("/private/project/AGENTS.md")
    expect(serialized).not.toContain("do not persist this description")
    expect(serialized).not.toContain("schema-secret-value")
  })

  test("marks missing and mismatched origins explicitly without inferring provenance", () => {
    const invalid = ContextAudit.report(
      {
        ...sample,
        instructions: [
          { source: "legacy", text: "legacy text" },
          { source: "mismatch", text: "changed text", manifest: instructionManifest },
        ],
      },
      { contextMode: "standard", auditMode: "summary" },
      "2026-10-15T00:00:00.000Z",
    )

    expect(invalid.instructions).toMatchObject([{ originState: "missing" }, { originState: "invalid" }])
    expect(invalid.instructions[0]?.contextManifest).toBeUndefined()
    expect(invalid.instructions[1]?.contextManifest).toBeUndefined()
  })

  test("bounds serialized origin metadata while preserving instruction counts and hashes", () => {
    const oversized = ContextManifest.create([
      {
        producer: "agent",
        phase: "baseline",
        text: "small admitted text",
        origins: [{ kind: "file", id: "/private/" + "x".repeat(ContextAudit.MAX_MANIFEST_BYTES), start: 0, end: 5 }],
      },
    ]).manifest
    const value = ContextAudit.report(
      { ...sample, instructions: [{ source: "agent", text: "small admitted text", manifest: oversized }] },
      { contextMode: "standard", auditMode: "summary" },
      "2026-10-15T00:00:00.000Z",
    )

    expect(value.instructionCount).toBe(1)
    expect(value.instructionBytes).toBe(Buffer.byteLength("small admitted text"))
    expect(value.instructions[0]).toMatchObject({
      bytes: Buffer.byteLength("small admitted text"),
      sha256: expect.any(String),
      originState: "omitted",
      originOmission: { reason: "byte_limit", bytes: expect.any(Number) },
    })
    expect(value.instructions[0]?.contextManifest).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(value.instructions[0]?.originOmission))).toBeLessThan(
      ContextAudit.MAX_MANIFEST_BYTES,
    )
  })

  test("budgets origin metadata across records and continues with a later small manifest", () => {
    const makeManifest = (text: string, id: string) =>
      ContextManifest.create([
        {
          producer: "agent",
          phase: "baseline",
          text,
          origins: [{ kind: "file", id, start: 0, end: text.length }],
        },
      ]).manifest
    const texts = ["first instruction", "second instruction", "third instruction"]
    const ids = ["first_" + "a".repeat(39_000), "second_" + "b".repeat(39_000), "/small/origin"]
    const manifests = texts.map((text, index) => makeManifest(text, ids[index]!))
    expect(
      manifests
        .slice(0, 2)
        .every((manifest) => Buffer.byteLength(JSON.stringify(manifest), "utf8") < ContextAudit.MAX_MANIFEST_BYTES),
    ).toBe(true)
    const report = ContextAudit.report(
      {
        ...sample,
        instructions: texts.map((text, index) => ({
          source: `instruction-${index}`,
          text,
          manifest: manifests[index],
        })),
      },
      { contextMode: "standard", auditMode: "summary" },
      "2026-10-15T00:00:00.000Z",
    )
    const includedBytes = report.instructions.reduce(
      (sum, item) => sum + (item.contextManifest ? Buffer.byteLength(JSON.stringify(item.contextManifest), "utf8") : 0),
      0,
    )

    expect(report.instructionCount).toBe(texts.length)
    expect(report.instructionBytes).toBe(texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0))
    expect(report.instructions.map((item) => item.sha256)).toEqual(
      texts.map((text) => createHash("sha256").update(text).digest("hex")),
    )
    expect(report.instructions.map((item) => item.originState)).toEqual(["valid", "omitted", "valid"])
    expect(report.instructions[1]?.originOmission).toMatchObject({ reason: "byte_limit", bytes: expect.any(Number) })
    expect(Object.keys(report.instructions[1]?.originOmission ?? {}).sort()).toEqual(["bytes", "reason"])
    expect(report.instructions[0]?.contextManifest?.parts[0]?.origins[0]?.id).toBe(ids[0])
    expect(report.instructions[2]?.contextManifest?.parts[0]?.origins[0]?.id).toBe(ids[2])
    expect(includedBytes).toBeLessThanOrEqual(ContextAudit.MAX_MANIFEST_BYTES)
    expect(JSON.stringify(report)).not.toContain(ids[1])
  })

  test("content mode enforces its byte cap for multibyte instructions", () => {
    const boundary = "界".repeat(21_845) + "a"
    expect(boundary.length).toBeLessThan(ContextAudit.MAX_CONTENT_BYTES)
    expect(Buffer.byteLength(boundary, "utf8")).toBe(ContextAudit.MAX_CONTENT_BYTES)

    const report = ContextAudit.report(
      { ...sample, instructions: [{ source: "boundary", text: boundary }] },
      { contextMode: "lean", auditMode: "content" },
      "2026-10-15T00:00:00.000Z",
    )
    const oversized = ContextAudit.report(
      { ...sample, instructions: [{ source: "oversized", text: "界".repeat(21_846) }] },
      { contextMode: "lean", auditMode: "content" },
      "2026-10-15T00:00:00.000Z",
    )

    expect(report.instructions[0]).toMatchObject({ content: boundary })
    expect(oversized.instructions[0]).toMatchObject({ contentOmitted: true })
    expect(
      report.instructions.reduce(
        (bytes, item) => bytes + (typeof item.content === "string" ? Buffer.byteLength(item.content) : 0),
        0,
      ),
    ).toBeLessThanOrEqual(ContextAudit.MAX_CONTENT_BYTES)
  })

  it.live("does not persist while disabled, and keeps only the latest explicitly enabled capture", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const disabled = ContextAudit.Service.useSync((service) => service)
          const offLayer = auditLayer(tmp.path, { CUDIA_CONTEXT_AUDIT: "off" })
          const off = yield* disabled.pipe(Effect.provide(offLayer))
          yield* off.record(sample)
          yield* off.record({
            ...sample,
            get messageSources(): ContextAudit.Input["messageSources"] {
              throw new Error("Disabled auditing must not inspect message sources")
            },
          })
          expect(off.enabled).toBe(false)
          expect(yield* off.latest()).toBeUndefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, ContextAudit.FILE)).catch(() => undefined)),
          ).toBeUndefined()

          const enabled = yield* disabled.pipe(Effect.provide(auditLayer(tmp.path, { CUDIA_CONTEXT_AUDIT: "content" })))
          yield* enabled.record(sample)
          yield* enabled.record({ ...sample, instructions: [{ source: "agent", text: "latest capture" }] })
          yield* enabled.record({ ...sample, agent: "x".repeat(ContextAudit.MAX_REPORT_BYTES) })
          expect(enabled.enabled).toBe(true)
          expect(yield* enabled.latest()).toMatchObject({ instructions: [{ content: "latest capture" }] })
          const saved = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, ContextAudit.FILE), "utf8"))
          expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(ContextAudit.MAX_REPORT_BYTES)
          expect(JSON.parse(saved)).toMatchObject({ instructions: [{ content: "latest capture" }] })
          expect(saved).not.toContain("private instruction")
        }),
      ),
    ),
  )

  it.live("serializes concurrent captures into one complete latest report and removes temporary files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const audit = yield* ContextAudit.Service.pipe(
            Effect.provide(auditLayer(temporaryDirectory.path, { CUDIA_CONTEXT_AUDIT: "summary" })),
          )
          const captures = Array.from({ length: 12 }, (_, index) => ({
            ...sample,
            sessionID: `ses_concurrent_${index}`,
            instructions: [{ source: "agent", text: `concurrent instruction ${index}` }],
          }))
          yield* Effect.forEach(captures, (capture) => audit.record(capture), { concurrency: "unbounded" })

          const latest = yield* audit.latest()
          const serialized = yield* Effect.promise(() =>
            fs.readFile(path.join(temporaryDirectory.path, ContextAudit.FILE), "utf8"),
          )
          const saved = JSON.parse(serialized) as ContextAudit.Report
          if (latest === undefined) throw new Error("Concurrent captures did not produce a latest report")
          expect(saved).toEqual(latest)
          expect(captures.map((capture) => capture.sessionID)).toContain(saved.sessionID)
          expect(saved.instructions[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
          expect(yield* Effect.promise(() => fs.readdir(temporaryDirectory.path))).toEqual([ContextAudit.FILE])
        }),
      ),
    ),
  )

  it.live("keeps the previous capture intact and removes the temp file when rename fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const realFilesystem = yield* FSUtil.Service.pipe(
            Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))),
          )
          const normalAudit = yield* ContextAudit.Service.pipe(
            Effect.provide(auditLayer(temporaryDirectory.path, { CUDIA_CONTEXT_AUDIT: "summary" })),
          )
          yield* normalAudit.record(sample)
          const file = path.join(temporaryDirectory.path, ContextAudit.FILE)
          const before = yield* Effect.promise(() => fs.readFile(file, "utf8"))

          const failingAudit = yield* ContextAudit.Service.pipe(
            Effect.provide(
              auditLayer(
                temporaryDirectory.path,
                { CUDIA_CONTEXT_AUDIT: "content" },
                Layer.merge(failingRenameFS(realFilesystem), LayerNode.compile(LayerNodePlatform.filesystem)),
              ),
            ),
          )
          yield* failingAudit.record({
            ...sample,
            instructions: [{ source: "agent", text: "replacement whose rename fails" }],
          })

          expect(failingAudit.enabled).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
          expect(JSON.parse(before)).toMatchObject({ sessionID: sample.sessionID, contentIncluded: false })
          expect(yield* Effect.promise(() => fs.readdir(temporaryDirectory.path))).toEqual([ContextAudit.FILE])
        }),
      ),
    ),
  )
})
