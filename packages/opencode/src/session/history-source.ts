import { randomUUID } from "node:crypto"
import type { ContextAudit } from "@opencode-ai/core/harness/audit"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/** Observed IDs at conversion input, never an identity recovered by matching final text. */
export function capture(
  messages: ReadonlyArray<SessionV1.WithParts>,
): NonNullable<ContextAudit.Input["historySnapshot"]> {
  const sources: NonNullable<ContextAudit.Input["historySnapshot"]>["sources"][number][] = []
  let count = 0
  let bytes = 0
  for (const [messageIndex, message] of messages.entries()) {
    if (message.info.role !== "assistant" || !message.info.summary || !message.info.finish || message.info.error)
      continue
    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type !== "text") continue
      count += 1
      bytes += Buffer.byteLength(part.text, "utf8")
      if (sources.length >= 128) continue
      sources.push({ messageID: message.info.id, partID: part.id, messageIndex, partIndex, text: part.text })
    }
  }
  return { id: randomUUID(), count, bytes, sources }
}

export * as HistorySource from "./history-source"
