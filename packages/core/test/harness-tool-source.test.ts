import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"

const body = "Loaded body ação 🌍"
const prefix = "Local wrapper\n"
const output = prefix + body + "\nLocal suffix"
const receipt = () =>
  ToolSource.create({
    kind: "skill",
    origin: "fixture/SKILL.md",
    output,
    start: prefix.length,
    end: prefix.length + body.length,
  })!

test("pairs a bounded observed skill body separately from the generated wrapper", () => {
  const observed = ToolSource.inspect(output, { contextSource: receipt() })
  expect(observed).toMatchObject({
    state: "matched",
    kind: "skill",
    origin: "fixture/SKILL.md",
    hashEncoding: "json-utf8",
    body: {
      type: "utf16-span",
      start: prefix.length,
      end: prefix.length + body.length,
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    },
  })
  expect(Buffer.byteLength(JSON.stringify(receipt()))).toBeLessThanOrEqual(ToolSource.MAX_RECEIPT_BYTES)
  expect(JSON.stringify(observed)).not.toContain(body)
  expect(JSON.stringify(receipt())).not.toContain(body)
})

test("reports body, wrapper and truncation changes without retaining claimed origins", () => {
  for (const changed of [
    output.replace("Loaded body", "Replaced body"),
    output.replace("Local wrapper", "Other wrapper"),
    output.slice(0, -4),
  ]) {
    expect(ToolSource.inspect(changed, { contextSource: receipt() })).toEqual({ state: "changed" })
  }
  expect(
    ToolSource.inspect(output, {
      contextSource: { ...receipt(), body: { ...receipt().body, sha256: "0".repeat(64) } },
    }),
  ).toEqual({ state: "changed" })
  const replacement = ToolSource.create({
    kind: "skill",
    origin: "another/declared/source",
    output,
    start: 0,
    end: output.length,
  })!
  expect(ToolSource.inspect(output, { contextSource: replacement })).toMatchObject({
    state: "matched",
    origin: "another/declared/source",
  })
})

test("rejects malformed known properties without invoking accessors or inspecting unknown metadata", () => {
  let invoked = 0
  const getter = {
    enumerable: true,
    get() {
      invoked++
      throw new Error("Must not invoke")
    },
  }
  const meta = Object.defineProperty({}, "contextSource", getter)
  expect(ToolSource.inspect(output, meta)).toEqual({ state: "invalid" })
  const value = receipt()
  Object.defineProperty(value.body, "sha256", getter)
  expect(ToolSource.inspect(output, { contextSource: value })).toEqual({ state: "invalid" })
  const safe = receipt()
  Object.defineProperty(safe, "unknownFutureRawText", getter)
  const safeMeta = Object.defineProperty({ contextSource: safe }, "largeUnknownMetadata", getter)
  expect(ToolSource.inspect(output, safeMeta).state).toBe("matched")
  expect(invoked).toBe(0)
  expect(
    ToolSource.inspect(output, {
      contextSource: { ...receipt(), origin: "x".repeat(ToolSource.MAX_ORIGIN_BYTES + 1) },
    }),
  ).toEqual({ state: "invalid" })
  expect(
    ToolSource.inspect(output, {
      contextSource: { ...receipt(), output: { length: NaN, bytes: 0, sha256: "0".repeat(64) } },
    }),
  ).toEqual({ state: "invalid" })
  expect(ToolSource.inspect(output, {})).toEqual({ state: "missing" })
})

test("validates UTF-16 span boundaries and distinguishes unpaired surrogates", () => {
  expect(ToolSource.create({ kind: "skill", origin: "source", output: "🌍", start: 0, end: 1 })).toBeUndefined()
  expect(ToolSource.create({ kind: "skill", origin: "source", output: "🌍", start: 1, end: 2 })).toBeUndefined()
  const invalid = receipt()
  const pairOutput = "🌍"
  const pair = ToolSource.create({ kind: "skill", origin: "source", output: pairOutput, start: 0, end: 2 })!
  expect(ToolSource.inspect(pairOutput, { contextSource: { ...pair, body: { ...pair.body, end: 1 } } })).toEqual({
    state: "invalid",
  })
  expect(ToolSource.inspect(output, { contextSource: { ...invalid, body: { ...invalid.body, start: -1 } } })).toEqual({
    state: "invalid",
  })
  const surrogate = ToolSource.create({ kind: "skill", origin: "source", output: "\uD800", start: 0, end: 1 })!
  expect(ToolSource.inspect("\uD801", { contextSource: surrogate })).toEqual({ state: "changed" })
})

test("pairs decoded MCP guidance with the exact escaped JSON output and server", () => {
  const guidance = 'Guidance "quoted"\n ação 🌍 \\ literal'
  const json = JSON.stringify({ server: "guide", instructions: guidance })
  const mcp = ToolSource.create({ kind: "mcp-guidance", origin: "guide", output: json })!
  expect(ToolSource.inspect(json, { contextSource: mcp })).toMatchObject({
    state: "matched",
    kind: "mcp-guidance",
    origin: "guide",
    body: {
      type: "json-member",
      member: "instructions",
      bytes: Buffer.byteLength(guidance),
      sha256: createHash("sha256").update(JSON.stringify(guidance)).digest("hex"),
    },
  })
  expect(ToolSource.create({ kind: "mcp-guidance", origin: "other", output: json })).toBeUndefined()
  expect(
    ToolSource.create({ kind: "mcp-guidance", origin: "guide", output: JSON.stringify({ server: "guide" }) }),
  ).toBeUndefined()
  expect(ToolSource.create({ kind: "mcp-guidance", origin: "guide", output: "invalid JSON" })).toBeUndefined()
})

test("verification limits affect attribution only, and invocation data distinguishes loaders from discovery", () => {
  const huge = "x".repeat(ToolSource.MAX_VERIFY_BYTES + 1)
  expect(ToolSource.create({ kind: "skill", origin: "source", output: huge, start: 0, end: 1 })).toBeUndefined()
  expect(ToolSource.inspect(huge, { contextSource: receipt() })).toEqual({ state: "unavailable" })
  expect(ToolSource.isLoader("skill", { name: "guide" })).toBe(true)
  expect(ToolSource.isLoader("skill", { query: "guide" })).toBe(false)
  expect(ToolSource.isLoader("mcp", { operation: "instructions" })).toBe(true)
  expect(ToolSource.isLoader("mcp", { operation: "servers" })).toBe(false)
  expect(ToolSource.isLoader("unrelated", { name: "guide", operation: "instructions" })).toBe(false)
})
