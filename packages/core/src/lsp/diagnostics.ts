export * as LSPDiagnostics from "./diagnostics"

import { LSPFraming } from "./framing"

export const MAX_ITEMS = 256
export const MAX_REPORT_BYTES = 256 * 1024
export const MAX_CACHE_BYTES = 1024 * 1024
export type Position = { readonly line: number; readonly character: number }
export type Diagnostic = {
  readonly range: { readonly start: Position; readonly end: Position }
  readonly message: string
  readonly severity?: number
  readonly code?: number | string
  readonly source?: string
  readonly tags?: readonly number[]
}
export type Report = {
  readonly diagnostics: readonly Diagnostic[]
  readonly omitted: number
  readonly bytes: number
  readonly source: "pull" | "push"
  readonly freshness: "current" | "unversioned"
  readonly generation: number
  readonly version: number
  readonly resultId?: string
}
export type Result = {
  readonly server: string
  readonly filePath: string
  readonly version: number
  readonly generation: number
  readonly source: "pull" | "push" | "none"
  readonly freshness: "current" | "unversioned" | "pending"
  readonly diagnostics: readonly Diagnostic[]
  readonly omitted: number
}

/** Project only the negotiated read-only fields; unknown optional fields never reach clients. */
export function decode(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const diagnostics: Diagnostic[] = []
  let omitted = Math.max(0, value.length - MAX_ITEMS)
  let bytes = 2
  for (const item of value.slice(0, MAX_ITEMS)) {
    if (!LSPFraming.record(item) || !range(item.range) || typeof item.message !== "string") return undefined
    if (item.severity !== undefined && (typeof item.severity !== "number" || ![1, 2, 3, 4].includes(item.severity)))
      return undefined
    if (item.code !== undefined && typeof item.code !== "string" && !Number.isSafeInteger(item.code)) return undefined
    if (item.source !== undefined && typeof item.source !== "string") return undefined
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => !Number.isSafeInteger(tag))))
      return undefined
    const diagnostic: Diagnostic = {
      range: {
        start: { line: item.range.start.line, character: item.range.start.character },
        end: { line: item.range.end.line, character: item.range.end.character },
      },
      message: item.message,
      ...(item.severity === undefined ? {} : { severity: Number(item.severity) }),
      ...(item.code === undefined ? {} : { code: item.code as number | string }),
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.tags === undefined ? {} : { tags: (item.tags as number[]).filter((tag) => tag === 1 || tag === 2) }),
    }
    omitted += ["data", "codeDescription", "relatedInformation"].filter((key) => key in item).length
    if (Array.isArray(item.tags)) omitted += item.tags.filter((tag) => tag !== 1 && tag !== 2).length
    const size = Buffer.byteLength(JSON.stringify(diagnostic)) + 1
    if (bytes + size > MAX_REPORT_BYTES) {
      omitted++
      continue
    }
    diagnostics.push(diagnostic)
    bytes += size
  }
  return { diagnostics, omitted, bytes }
}

function position(value: unknown): value is Position {
  return (
    LSPFraming.record(value) &&
    typeof value.line === "number" &&
    Number.isSafeInteger(value.line) &&
    value.line >= 0 &&
    typeof value.character === "number" &&
    Number.isSafeInteger(value.character) &&
    value.character >= 0
  )
}
function range(value: unknown): value is Diagnostic["range"] {
  return (
    LSPFraming.record(value) &&
    position(value.start) &&
    position(value.end) &&
    (value.end.line > value.start.line ||
      (value.end.line === value.start.line && value.end.character >= value.start.character))
  )
}
