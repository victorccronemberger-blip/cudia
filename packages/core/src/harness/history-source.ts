export * as HistorySource from "./history-source"

import { randomUUID } from "node:crypto"
import type { SessionMessage } from "../session/message"
import type { ContextAudit } from "./audit"
import { ToolSource } from "./tool-source"

/** Selected stored V2 output before lowering; this does not claim final provider-part identity. */
export function capture(
  messages: ReadonlyArray<SessionMessage.Message>,
): NonNullable<ContextAudit.Input["historySnapshot"]> {
  const sources: NonNullable<ContextAudit.Input["historySnapshot"]>["sources"][number][] = []
  let count = 0
  let bytes = 0
  for (const [messageIndex, message] of messages.entries()) {
    if (message.type !== "assistant") continue
    for (const [partIndex, part] of message.content.entries()) {
      if (
        part.type !== "tool" ||
        part.state.status !== "completed" ||
        part.name !== "skill" ||
        !ToolSource.isLoader(part.name, part.state.input)
      )
        continue
      const bundle = part.state.contextSources
      const textParts = part.state.content.flatMap((item, contentIndex) =>
        item.type === "text" ? [{ text: item.text, contentIndex }] : [],
      )
      // A loader with no remaining text is observable as an omitted source, not a fabricated empty body.
      count += Math.max(1, textParts.length)
      for (const item of textParts) {
        bytes += Buffer.byteLength(item.text, "utf8")
        if (sources.length >= 128) continue
        const entry = bundle?.entries.find((entry) => entry.contentIndex === item.contentIndex)
        const observed =
          part.time.pruned !== undefined ||
          bundle?.projection === "replaced" ||
          (!entry && bundle && bundle.omitted > 0)
            ? { state: "unavailable" as const }
            : ToolSource.inspect(item.text, entry ? { contextSource: entry.receipt } : undefined)
        const observation =
          observed.state === "matched" && observed.kind !== "skill" ? { state: "invalid" as const } : observed
        sources.push({
          source: "loaded-tool-result",
          messageID: message.id,
          partID: part.id,
          messageIndex,
          partIndex,
          text: item.text,
          tool: {
            name: part.name,
            callID: part.id,
            contentIndex: item.contentIndex,
            ...(bundle ? { receiptProjection: bundle.projection, omittedReceipts: bundle.omitted } : {}),
            observation,
          },
        })
      }
    }
  }
  return { id: randomUUID(), count, bytes, sources }
}
