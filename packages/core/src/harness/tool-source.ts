export * as ToolSource from "./tool-source"

import { createHash } from "node:crypto"
import type { ToolContextSource } from "@opencode-ai/schema/tool-context-source"

export const MAX_RECEIPT_BYTES = 4096
export const MAX_ORIGIN_BYTES = 1024
export const MAX_VERIFY_BYTES = 2 * 1024 * 1024

type Digest = { readonly bytes: number; readonly sha256: string }
export type Body = ToolContextSource.Body
export type Receipt = ToolContextSource.Receipt
export type Observation =
  | { readonly state: "missing" | "invalid" | "changed" | "unavailable" }
  | {
      readonly state: "matched"
      readonly hashEncoding: "json-utf8"
      readonly kind: Receipt["kind"]
      readonly origin: string
      readonly body: Body
    }

const digest = (text: string): Digest => ({
  bytes: Buffer.byteLength(text, "utf8"),
  // JSON encoding distinguishes unpaired UTF-16 surrogates that UTF-8 replaces.
  sha256: createHash("sha256").update(JSON.stringify(text)).digest("hex"),
})
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const hash = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
const small = (text: string, maximum: number) => text.length <= maximum && Buffer.byteLength(text, "utf8") <= maximum

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) throw new Error("Invalid receipt object")
  const property = Object.getOwnPropertyDescriptor(value, key)
  if (!property) return undefined
  if (!("value" in property)) throw new Error("Receipt accessors are unsupported")
  return property.value
}

function boundary(text: string, index: number) {
  return !(index > 0 && /[\uD800-\uDBFF]/.test(text.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(index)))
}

function bodyText(
  output: string,
  kind: Receipt["kind"],
  origin: string,
  body: Pick<Body, "type"> & { start?: number; end?: number },
) {
  if (body.type === "utf16-span") {
    if (
      kind !== "skill" ||
      !integer(body.start) ||
      !integer(body.end) ||
      body.start > body.end ||
      body.end > output.length ||
      !boundary(output, body.start) ||
      !boundary(output, body.end)
    )
      return undefined
    return output.slice(body.start, body.end)
  }
  if (kind !== "mcp-guidance") return undefined
  const parsed: unknown = JSON.parse(output)
  const text = own(parsed, "instructions")
  return own(parsed, "server") === origin && typeof text === "string" ? text : undefined
}

/** Receipts describe observed loader output, not authenticated file/server identity. */
export function create(
  input:
    | {
        readonly kind: "skill"
        readonly origin: string
        readonly output: string
        readonly start: number
        readonly end: number
      }
    | {
        readonly kind: "mcp-guidance"
        readonly origin: string
        readonly output: string
      },
): Receipt | undefined {
  try {
    if (!input.origin || !small(input.origin, MAX_ORIGIN_BYTES) || !small(input.output, MAX_VERIFY_BYTES))
      return undefined
    const locator =
      input.kind === "skill"
        ? { type: "utf16-span" as const, start: input.start, end: input.end }
        : { type: "json-member" as const, member: "instructions" as const }
    const text = bodyText(input.output, input.kind, input.origin, locator)
    if (text === undefined) return undefined
    const receipt: Receipt = {
      version: 1,
      hashEncoding: "json-utf8",
      kind: input.kind,
      origin: input.origin,
      output: { length: input.output.length, ...digest(input.output) },
      body: { ...locator, ...digest(text) },
    }
    return Buffer.byteLength(JSON.stringify(receipt), "utf8") <= MAX_RECEIPT_BYTES ? receipt : undefined
  } catch {
    return undefined
  }
}

function parse(value: unknown): Receipt | undefined {
  if (own(value, "version") !== 1 || own(value, "hashEncoding") !== "json-utf8") return undefined
  const kind = own(value, "kind")
  const origin = own(value, "origin")
  if (
    (kind !== "skill" && kind !== "mcp-guidance") ||
    typeof origin !== "string" ||
    !origin ||
    !small(origin, MAX_ORIGIN_BYTES)
  )
    return undefined
  const output = own(value, "output")
  const length = own(output, "length")
  const bytes = own(output, "bytes")
  const sha256 = own(output, "sha256")
  const body = own(value, "body")
  const type = own(body, "type")
  const bodyBytes = own(body, "bytes")
  const bodyHash = own(body, "sha256")
  if (!integer(length) || !integer(bytes) || !hash(sha256) || !integer(bodyBytes) || !hash(bodyHash)) return undefined
  const locator =
    kind === "skill" && type === "utf16-span"
      ? { type: "utf16-span" as const, start: own(body, "start"), end: own(body, "end") }
      : kind === "mcp-guidance" && type === "json-member" && own(body, "member") === "instructions"
        ? { type: "json-member" as const, member: "instructions" as const }
        : undefined
  if (!locator) return undefined
  if (
    locator.type === "utf16-span" &&
    (!integer(locator.start) || !integer(locator.end) || locator.start > locator.end || locator.end > length)
  )
    return undefined
  const receipt: Receipt = {
    version: 1,
    hashEncoding: "json-utf8",
    kind,
    origin,
    output: { length, bytes, sha256 },
    body:
      locator.type === "utf16-span"
        ? {
            type: locator.type,
            start: Number(locator.start),
            end: Number(locator.end),
            bytes: bodyBytes,
            sha256: bodyHash,
          }
        : { ...locator, bytes: bodyBytes, sha256: bodyHash },
  }
  return Buffer.byteLength(JSON.stringify(receipt), "utf8") <= MAX_RECEIPT_BYTES ? receipt : undefined
}

/** Bounded allowlisted copy for local receipt transport; never serializes unknown properties. */
export function read(value: unknown): Receipt | undefined {
  try {
    return parse(value)
  } catch {
    return undefined
  }
}

/** Reads a constant allowlist of own data properties; arbitrary metadata is never serialized. */
export function inspect(output: string, metadata: unknown): Observation {
  try {
    if (metadata === undefined) return { state: "missing" }
    const value = own(metadata, "contextSource")
    if (value === undefined) return { state: "missing" }
    const receipt = parse(value)
    if (!receipt) return { state: "invalid" }
    if (!small(output, MAX_VERIFY_BYTES)) return { state: "unavailable" }
    const observed = digest(output)
    if (
      output.length !== receipt.output.length ||
      observed.bytes !== receipt.output.bytes ||
      observed.sha256 !== receipt.output.sha256
    )
      return { state: "changed" }
    const text = bodyText(output, receipt.kind, receipt.origin, receipt.body)
    if (text === undefined) return { state: "invalid" }
    const body = digest(text)
    if (body.bytes !== receipt.body.bytes || body.sha256 !== receipt.body.sha256) return { state: "changed" }
    return {
      state: "matched",
      hashEncoding: "json-utf8",
      kind: receipt.kind,
      origin: receipt.origin,
      body: { ...receipt.body },
    }
  } catch {
    return { state: "invalid" }
  }
}

/** Explicit projection: changed/invalid receipts never retain a claimed body or origin. */
export function copy(value: Observation): Observation {
  if (value.state !== "matched") return { state: value.state }
  return {
    state: value.state,
    hashEncoding: value.hashEncoding,
    kind: value.kind,
    origin: value.origin,
    body:
      value.body.type === "utf16-span"
        ? {
            type: value.body.type,
            start: value.body.start,
            end: value.body.end,
            bytes: value.body.bytes,
            sha256: value.body.sha256,
          }
        : { type: value.body.type, member: value.body.member, bytes: value.body.bytes, sha256: value.body.sha256 },
  }
}

/** Classification uses observed invocation data; metadata alone cannot turn another tool into a loader. */
export function isLoader(name: string, input: unknown) {
  try {
    return (
      (name === "skill" && typeof own(input, "name") === "string") ||
      (name === "mcp" && own(input, "operation") === "instructions")
    )
  } catch {
    return false
  }
}
