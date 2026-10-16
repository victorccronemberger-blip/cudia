import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextHistory } from "@opencode-ai/core/harness/audit-history"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { metadata } from "@opencode-ai/core/harness/audit-metadata"
import { tmpdir } from "./fixture/tmpdir"

const text = "Synthetic checkpoint ação 🌍"
const snapshot = {
  id: "snapshot_observed_input",
  count: 1,
  bytes: Buffer.byteLength(text),
  sources: [{ messageID: "msg_saved", partID: "prt_saved", messageIndex: 3, partIndex: 2, text }],
}
const sample: ContextAudit.Input = {
  runtime: "v1-ai-sdk",
  purpose: "main",
  sessionID: "ses_source",
  agent: "build",
  model: { provider: "fixture", id: "fixture" },
  instructions: [],
  messages: [],
  tools: [],
  historySnapshot: snapshot,
}
const policy = { contextMode: "lean", auditMode: "summary" } as const

test("persists source and capture correlation in SQLite without retaining checkpoint text", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, ContextHistory.FILE)
  const loaded = "PRIVATE_SYNTHETIC_LOADED_BODY"
  const receipt = ToolSource.create({
    kind: "skill",
    origin: "fixture/SKILL.md",
    output: loaded,
    start: 0,
    end: loaded.length,
  })!
  const captured = ContextAudit.report(
    {
      ...sample,
      historySnapshot: {
        ...snapshot,
        count: 2,
        bytes: snapshot.bytes + Buffer.byteLength(loaded),
        sources: [
          ...snapshot.sources,
          {
            source: "loaded-tool-result",
            messageID: "msg_loaded",
            partID: "prt_loaded",
            messageIndex: 1,
            partIndex: 0,
            text: loaded,
            tool: {
              name: "skill",
              callID: "call_loaded",
              observation: ToolSource.inspect(loaded, { contextSource: receipt }),
            },
          },
        ],
      },
    },
    { ...policy, auditMode: "content" },
    "now",
  )
  await Effect.runPromise(ContextHistory.append(filename, captured))
  const page = await Effect.runPromise(ContextHistory.read(filename))
  expect(page?.entries).toHaveLength(1)
  expect(page?.entries[0]?.capture.captureID).toBe(captured.captureID)
  expect(page?.entries[0]?.capture.historySnapshot).toMatchObject({
    id: snapshot.id,
    mapping: "unmapped-after-conversion",
    sources: [
      { messageID: "msg_saved", partID: "prt_saved" },
      { source: "loaded-tool-result", tool: { observation: { state: "matched", origin: "fixture/SKILL.md" } } },
    ],
  })
  expect(JSON.stringify(page)).not.toContain(text)
  expect(JSON.stringify(page)).not.toContain(loaded)
  expect(await Bun.file(filename).text()).not.toContain(text)
  expect(await Bun.file(filename).text()).not.toContain(loaded)
})

test("correlates source snapshots without claiming final part identities or retaining text in metadata", () => {
  const first = ContextAudit.report(sample, policy, "now")
  const retry = ContextAudit.report(sample, policy, "later")
  expect(first.captureID).toMatch(/^[a-f0-9-]{36}$/)
  expect(retry.captureID).not.toBe(first.captureID)
  expect(retry.historySnapshot?.id).toBe(first.historySnapshot?.id)
  expect(first.historySnapshot).toMatchObject({
    stage: "pre-model-conversion",
    mapping: "unmapped-after-conversion",
    sourceCount: 1,
    sourceBytes: Buffer.byteLength(text),
    sources: [
      {
        messageID: "msg_saved",
        partID: "prt_saved",
        messageIndex: 3,
        partIndex: 2,
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  })
  expect(JSON.stringify(first)).not.toContain(text)
  const content = ContextAudit.report(sample, { ...policy, auditMode: "content" }, "now")
  expect(content.historySnapshot?.sources[0]?.content).toBe(text)
  expect(JSON.stringify(metadata(content))).not.toContain(text)
  expect(ContextAudit.report({ ...sample, historySnapshot: undefined }, policy, "now")).not.toHaveProperty("captureID")
})

test("retains prepared-part mappings as bounded metadata and reads earlier unmapped reports", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, ContextHistory.FILE)
  const privateText = "PRIVATE_SYNTHETIC_MAPPED_OUTPUT"
  const expected = {
    state: "mapped" as const,
    messageIndex: 2,
    partIndex: 0,
    role: "tool" as const,
    resultType: "content" as const,
    resultContentIndex: 3,
  }
  const prepared = Object.defineProperty({ ...expected }, "unknownRawBody", {
    get: () => {
      throw new Error("Unknown prepared metadata getter must not execute")
    },
    enumerable: true,
  })
  const current = ContextAudit.report(
    {
      ...sample,
      runtime: "v2",
      historySnapshot: {
        ...snapshot,
        mapping: "observed-at-prepared-request",
        sources: [{ ...snapshot.sources[0]!, text: privateText, prepared }],
      },
    },
    { ...policy, auditMode: "content" },
    "now",
  )
  const earlier = ContextAudit.report(sample, policy, "earlier")
  expect(earlier.historySnapshot?.mapping).toBe("unmapped-after-conversion")
  expect(current.historySnapshot).toMatchObject({
    mapping: "observed-at-prepared-request",
    sources: [{ prepared: expected }],
  })
  expect(metadata(current).historySnapshot?.sources[0]?.prepared).toEqual(expected)
  await Effect.runPromise(ContextHistory.append(filename, earlier))
  await Effect.runPromise(ContextHistory.append(filename, current))
  const page = await Effect.runPromise(ContextHistory.read(filename))
  expect(page?.entries.map((entry) => entry.capture.historySnapshot?.mapping)).toEqual([
    "observed-at-prepared-request",
    "unmapped-after-conversion",
  ])
  expect(page?.entries[0]?.capture.historySnapshot?.sources[0]?.prepared).toEqual(expected)
  expect(JSON.stringify(page)).not.toContain(privateText)
  expect(await Bun.file(filename).text()).not.toContain(privateText)
  const exhausted = ContextAudit.report(
    {
      ...sample,
      historySnapshot: {
        ...snapshot,
        mapping: "observed-at-prepared-request",
        sources: [{ ...snapshot.sources[0]!, messageID: "x".repeat(ContextAudit.MAX_MANIFEST_BYTES), prepared }],
      },
    },
    policy,
    "now",
  )
  expect(exhausted.historySnapshot).toMatchObject({ omittedSources: 1, sources: [] })
})

test("SQLite retains resource source identities and omission metadata without the MCP body", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, ContextHistory.FILE)
  const loaded = "PRIVATE_SYNTHETIC_MCP_RESOURCE"
  const origin = JSON.stringify({ server: "fixture", requestedURI: "custom:request", uri: "custom:return" })
  const receipt = ToolSource.create({ kind: "mcp-resource", origin, output: loaded, start: 0, end: loaded.length })!
  const captured = ContextAudit.report(
    {
      ...sample,
      runtime: "v2",
      historySnapshot: {
        id: "resource-snapshot",
        count: 1,
        bytes: Buffer.byteLength(loaded),
        sources: [
          {
            source: "loaded-tool-result",
            messageID: "msg_resource",
            partID: "call_resource",
            messageIndex: 0,
            partIndex: 0,
            text: loaded,
            tool: {
              name: "mcp",
              callID: "call_resource",
              contentIndex: 2,
              receiptProjection: "original",
              omittedReceipts: 3,
              observation: ToolSource.inspect(loaded, { contextSource: receipt }),
            },
          },
        ],
      },
    },
    { ...policy, auditMode: "content" },
    "now",
  )
  await Effect.runPromise(ContextHistory.append(filename, captured))
  const page = await Effect.runPromise(ContextHistory.read(filename))
  expect(page?.entries[0]?.capture.historySnapshot?.sources[0]?.tool).toMatchObject({
    name: "mcp",
    contentIndex: 2,
    receiptProjection: "original",
    omittedReceipts: 3,
    observation: { state: "matched", kind: "mcp-resource", origin },
  })
  expect(JSON.stringify(page)).not.toContain(loaded)
  expect(await Bun.file(filename).text()).not.toContain(loaded)
})

test("bounds checkpoint source records and shares content and metadata allowances", () => {
  const many = Array.from({ length: 130 }, (_, index) => ({ ...snapshot.sources[0]!, partID: "prt_" + index }))
  const bounded = ContextAudit.report(
    { ...sample, historySnapshot: { ...snapshot, count: 130, bytes: snapshot.bytes * 130, sources: many } },
    policy,
    "now",
  )
  expect(bounded.historySnapshot?.sources).toHaveLength(128)
  expect(bounded.historySnapshot?.omittedSources).toBe(2)
  const exhausted = ContextAudit.report(
    { ...sample, instructions: [{ source: "agent", text: "a".repeat(ContextAudit.MAX_CONTENT_BYTES) }] },
    { ...policy, auditMode: "content" },
    "now",
  )
  expect(exhausted.historySnapshot?.sources[0]?.contentOmitted).toBe(true)
  expect(exhausted.historySnapshot?.sources[0]).not.toHaveProperty("content")
  const metadataBounded = ContextAudit.report(
    {
      ...sample,
      historySnapshot: {
        ...snapshot,
        count: 2,
        sources: [
          { ...snapshot.sources[0]!, messageID: "x".repeat(ContextAudit.MAX_MANIFEST_BYTES) },
          snapshot.sources[0]!,
        ],
      },
    },
    policy,
    "now",
  )
  expect(metadataBounded.historySnapshot?.sources).toHaveLength(1)
  expect(metadataBounded.historySnapshot?.omittedSources).toBe(1)
})
