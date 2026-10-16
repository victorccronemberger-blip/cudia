import { randomUUID } from "node:crypto"
import type { ContextAudit } from "@opencode-ai/core/harness/audit"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"

/** Observed IDs at conversion input, never an identity recovered by matching final text. */
export function capture(
  messages: ReadonlyArray<SessionV1.WithParts>,
): NonNullable<ContextAudit.Input["historySnapshot"]> {
  const sources: NonNullable<ContextAudit.Input["historySnapshot"]>["sources"][number][] = []
  let count = 0
  let bytes = 0
  for (const [messageIndex, message] of messages.entries()) {
    if (message.info.role !== "assistant") continue
    for (const [partIndex, part] of message.parts.entries()) {
      if (
        part.type === "tool" &&
        part.state.status === "completed" &&
        ToolSource.isLoader(part.tool, part.state.input)
      ) {
        count += 1
        bytes += Buffer.byteLength(part.state.output, "utf8")
        if (sources.length >= 128) continue
        const observed = ToolSource.inspect(part.state.output, part.state.metadata)
        const observation =
          observed.state === "matched" && observed.kind !== (part.tool === "skill" ? "skill" : "mcp-guidance")
            ? { state: "invalid" as const }
            : observed
        sources.push({
          source: "loaded-tool-result",
          messageID: message.info.id,
          partID: part.id,
          messageIndex,
          partIndex,
          text: part.state.output,
          tool: { name: part.tool, callID: part.callID, observation },
        })
        continue
      }
      if (part.type !== "text" || !message.info.summary || !message.info.finish || message.info.error) continue
      count += 1
      bytes += Buffer.byteLength(part.text, "utf8")
      if (sources.length >= 128) continue
      sources.push({ messageID: message.info.id, partID: part.id, messageIndex, partIndex, text: part.text })
    }
  }
  return { id: randomUUID(), count, bytes, sources }
}

export * as HistorySource from "./history-source"
