export * as ToolProvenance from "./provenance"

import type { ToolContextSource } from "@opencode-ai/schema/tool-context-source"
import { ToolSource } from "../harness/tool-source"

export const MAX_ENTRIES = 8
export const MAX_BYTES = 16_384
const attachments = new WeakMap<object, ToolContextSource.Bundle>()

/** Internal identity attachment, outside domain fields, tool contracts and provider payloads. */
export function attach<T extends object>(
  output: T,
  sources: ReadonlyArray<{ readonly contentIndex: number; readonly receipt: ToolSource.Receipt | undefined }>,
  omitted = 0,
): T {
  const entries: ToolContextSource.Entry[] = []
  let missing = omitted
  let remaining = MAX_BYTES - 128
  for (const source of sources) {
    const receipt = entries.length < MAX_ENTRIES ? ToolSource.read(source.receipt) : undefined
    if (
      !receipt ||
      !Number.isSafeInteger(source.contentIndex) ||
      source.contentIndex < 0 ||
      entries.some((entry) => entry.contentIndex === source.contentIndex)
    ) {
      missing += 1
      continue
    }
    const entry = { contentIndex: source.contentIndex, receipt }
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1
    if (bytes > remaining) {
      missing += 1
      continue
    }
    remaining -= bytes
    Object.freeze(receipt.output)
    Object.freeze(receipt.body)
    Object.freeze(receipt)
    entries.push(Object.freeze(entry))
  }
  attachments.set(
    output,
    Object.freeze({ version: 1, projection: "original", entries: Object.freeze(entries), omitted: missing }),
  )
  return output
}

/** Ownership moves once. Failed encoding/projection must not leave a receipt on reusable domain output. */
export function take(output: unknown): ToolContextSource.Bundle | undefined {
  if (typeof output !== "object" || output === null) return undefined
  const result = attachments.get(output)
  attachments.delete(output)
  return result
}
