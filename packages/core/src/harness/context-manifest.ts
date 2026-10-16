export * as ContextManifest from "./context-manifest"

import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"

/** Renderer origins are relative to its own text until create assigns absolute offsets. */
export interface Rendered {
  readonly text: string
  readonly origins: ReadonlyArray<ContextManifestSchema.Origin>
}

export interface Input {
  readonly producer: string
  readonly phase: ContextManifestSchema.Part["phase"]
  readonly text: string
  readonly origins?: ReadonlyArray<ContextManifestSchema.Origin>
}

/** JSON encoding preserves lone UTF-16 code units rather than hashing their UTF-8 replacement characters. */
export function describe(text: string) {
  return {
    length: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(JSON.stringify(text), "utf8").digest("hex"),
  }
}

/** Join separators are framing owned by the following producer, keeping parts contiguous. */
export function create(input: ReadonlyArray<Input>): {
  readonly text: string
  readonly manifest: ContextManifestSchema.Manifest
} {
  const text = input.map((part) => part.text).join("\n\n")
  let cursor = 0
  const parts = input.map((part, index): ContextManifestSchema.Part => {
    for (const origin of part.origins ?? []) {
      if (
        origin.start < 0 ||
        origin.end < origin.start ||
        origin.end > part.text.length ||
        !boundary(part.text, origin.start) ||
        !boundary(part.text, origin.end)
      )
        throw new Error("Invalid relative system context origin span")
    }
    const start = cursor
    const body = start + (index === 0 ? 0 : 2)
    cursor = body + part.text.length
    return {
      producer: part.producer,
      phase: part.phase,
      start,
      end: cursor,
      origins: (part.origins ?? []).map((origin) => ({
        ...origin,
        start: body + origin.start,
        end: body + origin.end,
      })),
    }
  })
  const manifest: ContextManifestSchema.Manifest = { version: 1, hashEncoding: "json-utf8", ...describe(text), parts }
  if (verify(text, manifest) !== "valid") throw new Error("Invalid system context manifest rendering")
  return { text, manifest }
}

const decode = Schema.decodeUnknownOption(ContextManifestSchema.Manifest)

/** Legacy absence and malformed provenance are observable states, not application failures. */
export function verify(text: string, manifest: unknown): "valid" | "missing" | "invalid" {
  if (manifest === undefined || manifest === null) return "missing"
  const decoded = decode(manifest)
  if (Option.isNone(decoded)) return "invalid"
  const value = decoded.value
  const actual = describe(text)
  if (value.length !== actual.length || value.bytes !== actual.bytes || value.sha256 !== actual.sha256) return "invalid"
  let cursor = 0
  for (const part of value.parts) {
    if (part.start !== cursor || part.end < part.start || part.end > text.length) return "invalid"
    if (!boundary(text, part.start) || !boundary(text, part.end)) return "invalid"
    for (const origin of part.origins) {
      if (origin.start < part.start || origin.end < origin.start || origin.end > part.end) return "invalid"
      if (!boundary(text, origin.start) || !boundary(text, origin.end)) return "invalid"
    }
    cursor = part.end
  }
  return cursor === text.length ? "valid" : "invalid"
}

function boundary(text: string, offset: number) {
  if (offset === 0 || offset === text.length) return true
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}
