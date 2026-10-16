import { SessionV1 } from "@opencode-ai/core/v1/session"

/** Context projections never replace the recorded result or replay its tool. */
export function project(
  part: Pick<SessionV1.ToolPart, "messageID" | "id"> & { state: SessionV1.ToolStateCompleted },
  maxChars?: number,
  attachmentNotes?: string,
) {
  const text = [part.state.output, attachmentNotes].filter((item) => item !== undefined && item !== "").join("\n")
  const compacted = part.state.time.compacted !== undefined
  if (!compacted && (!maxChars || text.length <= maxChars)) return text

  const end = compacted ? 0 : Math.max(0, Math.floor(maxChars ?? 0))
  // A UTF-16 limit must not split a supplementary character between projections.
  const safeEnd =
    end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end)) ? end - 1 : end
  const reference = JSON.stringify({ messageID: part.messageID, partID: part.id })
  const marker = `[Recorded tool output ${compacted ? "omitted" : "excerpted"} from context. Recover stored text with tool_result(${reference}); attachments are excluded. Availability follows session retention and tool permissions.]`
  return [text.slice(0, safeEnd), marker].filter(Boolean).join("\n")
}

export * as ToolOutput from "./tool-output"
