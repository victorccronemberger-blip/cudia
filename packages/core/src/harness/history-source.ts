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
        !(
          (part.name === "skill" && ToolSource.isLoader(part.name, part.state.input)) ||
          (part.name === "mcp" &&
            typeof part.state.input.server === "string" &&
            (part.state.input.operation === "instructions" ||
              (part.state.input.operation === "read" && typeof part.state.input.uri === "string")))
        )
      )
        continue
      const bundle = part.state.contextSources
      const resource = part.name === "mcp" && part.state.input.operation === "read"
      const guidance = part.name === "mcp" && part.state.input.operation === "instructions"
      if (
        guidance &&
        part.state.structured.server === part.state.input.server &&
        !Object.hasOwn(part.state.structured, "instructions")
      )
        continue
      const validGuidance =
        !guidance ||
        (part.state.structured.server === part.state.input.server &&
          typeof part.state.structured.instructions === "string" &&
          part.state.content.length === 1 &&
          part.state.content[0]?.type === "text")
      const kinds =
        resource && bundle?.projection === "original" && part.time.pruned === undefined
          ? resourceKinds(part.state.structured, part.state.content)
          : undefined
      const textParts = part.state.content.flatMap((item, contentIndex) =>
        item.type === "text" && kinds?.[contentIndex]?.type !== "blob" ? [{ text: item.text, contentIndex }] : [],
      )
      // A loader with no remaining text is observable as an omitted source, not a fabricated empty body.
      // Confirmed binary-only/empty resources contain no text-body sources to omit.
      count += resource && kinds ? textParts.length : Math.max(1, textParts.length)
      for (const item of textParts) {
        bytes += Buffer.byteLength(item.text, "utf8")
        if (sources.length >= 128) continue
        const entry = bundle?.entries.find((entry) => entry.contentIndex === item.contentIndex)
        const observed =
          part.time.pruned !== undefined ||
          bundle?.projection === "replaced" ||
          !validGuidance ||
          (resource && kinds === undefined) ||
          (!entry && bundle && bundle.omitted > 0)
            ? { state: "unavailable" as const }
            : ToolSource.inspect(item.text, entry ? { contextSource: entry.receipt } : undefined)
        const observation =
          observed.state === "matched" &&
          (observed.kind !== (resource ? "mcp-resource" : guidance ? "mcp-guidance" : "skill") ||
            (guidance && observed.origin !== part.state.input.server) ||
            (resource &&
              observed.origin !==
                JSON.stringify({
                  server: part.state.input.server,
                  requestedURI: part.state.input.uri,
                  uri: kinds?.[item.contentIndex]?.uri,
                })))
            ? { state: "invalid" as const }
            : observed
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

/** Classify known structured contents, never by recognizing serialized blob/text wrappers. */
function resourceKinds(
  structured: Record<string, unknown>,
  content: ReadonlyArray<{ readonly type: string }>,
): ReadonlyArray<{ readonly type: "text" | "blob"; readonly uri: string }> | undefined {
  const contents = structured.contents
  if (!Array.isArray(contents) || contents.length !== content.length || content.some((part) => part.type !== "text"))
    return undefined
  const kinds: Array<{ readonly type: "text" | "blob"; readonly uri: string }> = []
  for (const item of contents as ReadonlyArray<unknown>) {
    if (typeof item !== "object" || item === null || !("uri" in item) || typeof item.uri !== "string") return undefined
    if ("text" in item && typeof item.text === "string" && !("blob" in item)) {
      kinds.push({ type: "text", uri: item.uri })
      continue
    }
    if ("blob" in item && typeof item.blob === "string" && !("text" in item)) {
      kinds.push({ type: "blob", uri: item.uri })
      continue
    }
    return undefined
  }
  return kinds
}
