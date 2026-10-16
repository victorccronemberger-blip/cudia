import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"
import { ContextManifest } from "@opencode-ai/core/harness/context-manifest"
import { SkillCatalog } from "@opencode-ai/core/skill/catalog"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Reference } from "@opencode-ai/core/reference"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { it } from "./lib/effect"

describe("ContextManifest", () => {
  test("hashes exact UTF-16 content through JSON and measures actual UTF-8 bytes", () => {
    const text = '\uFEFF😀 "quoted"\n\u0000\ud800'
    expect(ContextManifest.describe(text)).toEqual({
      length: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(JSON.stringify(text), "utf8").digest("hex"),
    })
    expect(ContextManifest.describe("\ud800").sha256).not.toBe(ContextManifest.describe("\ud801").sha256)
    expect(ContextManifest.describe("\ud800").bytes).toBe(ContextManifest.describe("\ud801").bytes)
  })

  test("attributes repeated text to explicit origins and assigns join framing to the following producer", () => {
    const input = [
      {
        producer: "core/first",
        phase: "baseline" as const,
        text: "same😀",
        origins: [{ kind: "file" as const, id: "/first", start: 0, end: 6 }],
      },
      {
        producer: "core/second",
        phase: "update" as const,
        text: "Header\nsame😀",
        origins: [{ kind: "file" as const, id: "/second", start: 7, end: 13 }],
      },
    ]
    const result = ContextManifest.create(input)
    expect(result.text).toBe("same😀\n\nHeader\nsame😀")
    expect(result.manifest.parts).toEqual([
      {
        producer: "core/first",
        phase: "baseline",
        start: 0,
        end: 6,
        origins: [{ kind: "file", id: "/first", start: 0, end: 6 }],
      },
      {
        producer: "core/second",
        phase: "update",
        start: 6,
        end: 21,
        origins: [{ kind: "file", id: "/second", start: 15, end: 21 }],
      },
    ])
    expect(input[1].origins[0].start).toBe(7)
    expect(ContextManifest.verify(result.text, result.manifest)).toBe("valid")
  })

  test("reports legacy absence separately and rejects mismatched hashes, bytes, lengths and spans", () => {
    const result = ContextManifest.create([{ producer: "core/test", phase: "baseline", text: "A😀Z" }])
    expect(ContextManifest.verify(result.text, undefined)).toBe("missing")
    expect(ContextManifest.verify(result.text, null)).toBe("missing")
    for (const manifest of [
      {},
      "legacy",
      { ...result.manifest, version: 2 },
      { ...result.manifest, hashEncoding: "utf8" },
      { ...result.manifest, bytes: 4 },
      { ...result.manifest, length: 5 },
      { ...result.manifest, sha256: "0".repeat(64) },
      { ...result.manifest, parts: [] },
      { ...result.manifest, parts: [{ producer: "core/test", phase: "baseline", start: 1, end: 4, origins: [] }] },
      {
        ...result.manifest,
        parts: [
          {
            producer: "core/test",
            phase: "baseline",
            start: 0,
            end: 4,
            origins: [{ kind: "file", id: "/bad", start: 0, end: 5 }],
          },
        ],
      },
      {
        ...result.manifest,
        parts: [
          {
            producer: "core/test",
            phase: "baseline",
            start: 0,
            end: 4,
            origins: [{ kind: "file", id: "/split", start: 2, end: 3 }],
          },
        ],
      },
    ])
      expect(ContextManifest.verify(result.text, manifest)).toBe("invalid")
    expect(ContextManifest.verify("B😀Z", result.manifest)).toBe("invalid")
  })

  test("rejects relative origins that escape into producer join framing", () => {
    expect(() =>
      ContextManifest.create([
        { producer: "a/first", phase: "baseline", text: "first" },
        {
          producer: "a/second",
          phase: "baseline",
          text: "second",
          origins: [{ kind: "file", id: "/bad", start: -1, end: 1 }],
        },
      ]),
    ).toThrow("Invalid relative")
    expect(() =>
      ContextManifest.create([
        {
          producer: "a/test",
          phase: "baseline",
          text: "😀",
          origins: [{ kind: "file", id: "/split", start: 0, end: 1 }],
        },
      ]),
    ).toThrow("Invalid relative")
  })

  test("omits undefined optional origin properties from schema encoding", () => {
    const encoded = Schema.encodeSync(ContextManifestSchema.Origin)({
      kind: "runtime",
      id: "test",
      start: 0,
      end: 0,
      sha256: undefined,
      bytes: undefined,
    })
    expect(Object.keys(encoded).toSorted()).toEqual(["end", "id", "kind", "start"])
  })

  test("origin digests describe observed input rather than assuming rendering is lossless", () => {
    const observed = ContextManifest.describe("Original\n metadata")
    const result = ContextManifest.create([
      {
        producer: "core/metadata",
        phase: "baseline",
        text: "Original metadata",
        origins: [{ kind: "skill", id: "metadata", start: 0, end: 17, sha256: observed.sha256, bytes: observed.bytes }],
      },
    ])
    expect(ContextManifest.verify(result.text, result.manifest)).toBe("valid")
    expect(result.manifest.parts[0].origins[0].sha256).not.toBe(result.manifest.sha256)
  })

  test("skill catalog origins cover included rows and never imply omitted skill bodies or files", () => {
    const skills = [
      { name: "zeta", description: "Zeta\n workflow" },
      { name: "alpha", description: "Alpha 😀" },
      { name: "hidden" },
    ]
    const result = SkillCatalog.renderWithOrigins(skills)
    expect(result.text).toBe(SkillCatalog.render(skills))
    expect(result.origins.map((origin) => origin.id)).toEqual(["alpha", "zeta"])
    expect(result.origins.map((origin) => result.text.slice(origin.start, origin.end))).toEqual([
      "- alpha: Alpha 😀",
      "- zeta: Zeta workflow",
    ])
    expect(result.origins.every((origin) => origin.kind === "skill")).toBe(true)
    const observed = ContextManifest.describe(JSON.stringify(skills[0]))
    expect(result.origins[1]).toMatchObject({ sha256: observed.sha256, bytes: observed.bytes })
    const omitted = SkillCatalog.renderWithOrigins(
      Array.from({ length: 50 }, (_, index) => ({ name: `skill-${index}`, description: "x".repeat(100) })),
    )
    expect(omitted.text).toContain("catalog is omitted")
    expect(omitted.origins).toEqual([])
    expect(SkillCatalog.renderWithOrigins([]).origins).toEqual([])
  })

  it.effect("reference metadata origins cover exact records without claiming their directory contents", () =>
    Effect.gen(function* () {
      const guidance = yield* ReferenceGuidance.Service
      const initialized = yield* SystemContext.initialize(yield* guidance.load())
      expect(ContextManifest.verify(initialized.baseline, initialized.manifest)).toBe("valid")
      const origins = initialized.manifest.parts[0].origins
      expect(origins).toHaveLength(1)
      expect(origins[0]).toMatchObject({ kind: "reference", id: "/docs" })
      expect(initialized.baseline.slice(origins[0].start, origins[0].end)).toBe(
        "  <reference>\n    <name>docs</name>\n    <path>/docs</path>\n    <description>Docs 😀</description>\n  </reference>",
      )
      const observed = ContextManifest.describe(JSON.stringify({ name: "docs", path: "/docs", description: "Docs 😀" }))
      expect(origins[0]).toMatchObject({ sha256: observed.sha256, bytes: observed.bytes })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(ReferenceGuidance.node, [
          [
            Reference.node,
            Layer.mock(Reference.Service, {
              list: () =>
                Effect.succeed([
                  new Reference.Info({
                    name: "docs",
                    path: AbsolutePath.make("/docs"),
                    description: "Docs 😀",
                    source: Reference.LocalSource.make({
                      type: "local",
                      path: AbsolutePath.make("/docs"),
                      description: "Docs 😀",
                    }),
                  }),
                ]),
            }),
          ],
        ]),
      ),
    ),
  )
})
