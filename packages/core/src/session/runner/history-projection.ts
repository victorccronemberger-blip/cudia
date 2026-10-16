export * as HistoryProjection from "./history-projection"

import type { ContentPart, Message, ToolResultPart } from "@opencode-ai/llm"
import type { SessionMessage } from "../message"
import type { ContextAudit } from "../../harness/audit"
import type { PreparedSource } from "../../harness/prepared-source"

type Snapshot = NonNullable<ContextAudit.Input["historySnapshot"]>
type Candidate = {
  readonly part: ToolResultPart
  readonly resultType: "text" | "content"
  readonly resultContentIndex?: number
}
export type Collector = {
  readonly toolResult: (
    messageIndex: number,
    partIndex: number,
    messageID: string,
    tool: SessionMessage.AssistantTool,
    result: ToolResultPart,
  ) => void
  /** Only for the immediately observed, order-preserving Message/LLMRequest constructors. */
  readonly copied: (
    before: ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<ContentPart> }>,
    after: ReadonlyArray<Message>,
  ) => void
  readonly capture: (messages: ReadonlyArray<Message>) => Snapshot
}

/** Request-local identity observations, never a provider field or a search by call ID/text. */
export function create(snapshot: Snapshot): Collector {
  const sources = snapshot.sources.slice(0, 128)
  const targets = new Map<string, number[]>()
  const outcomes = new Map<number, Candidate | PreparedSource.Mapping>()
  const parts = new WeakMap<object, number[]>()
  for (const [index, source] of sources.entries()) {
    const key = `${source.messageIndex}:${source.partIndex}`
    targets.set(key, [...(targets.get(key) ?? []), index])
  }
  const invalidate = (content: ReadonlyArray<ContentPart>) => {
    for (const part of content) {
      for (const index of parts.get(part) ?? []) {
        // This terminal state blocks every old alias, including aliases not enumerable in the WeakMap.
        outcomes.set(index, { state: "unmapped", reason: "copy-boundary-changed" })
      }
    }
  }
  return {
    toolResult(messageIndex, partIndex, messageID, tool, result) {
      for (const index of targets.get(`${messageIndex}:${partIndex}`) ?? []) {
        const source = sources[index]!
        if (outcomes.has(index)) {
          outcomes.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
          continue
        }
        const contentIndex = source.tool?.contentIndex
        if (
          source.messageID !== messageID ||
          source.partID !== tool.id ||
          source.tool?.callID !== tool.id ||
          source.tool.name !== tool.name
        ) {
          outcomes.set(index, { state: "unmapped", reason: "source-mismatch" })
          continue
        }
        if (tool.provider?.executed === true && tool.state.status === "completed" && tool.state.result !== undefined) {
          outcomes.set(index, { state: "unmapped", reason: "native-override" })
          continue
        }
        if (
          tool.state.status !== "completed" ||
          contentIndex === undefined ||
          !Number.isSafeInteger(contentIndex) ||
          contentIndex < 0
        ) {
          outcomes.set(index, { state: "unmapped", reason: "unsupported-result" })
          continue
        }
        const stored = tool.state.content[contentIndex]
        // Equality verifies an already identified source; it is never used to locate another source.
        if (stored?.type !== "text" || stored.text !== source.text) {
          outcomes.set(index, { state: "unmapped", reason: "source-mismatch" })
          continue
        }
        const candidate =
          result.result.type === "text" && contentIndex === 0 && tool.state.content.length === 1
            ? { part: result, resultType: "text" as const }
            : result.result.type === "content"
              ? { part: result, resultType: "content" as const, resultContentIndex: contentIndex }
              : undefined
        if (!candidate) {
          outcomes.set(index, { state: "unmapped", reason: "unsupported-result" })
          continue
        }
        outcomes.set(index, candidate)
        parts.set(result, [...(parts.get(result) ?? []), index])
      }
    },
    copied(before, after) {
      if (sources.length === 0) return
      if (before.length !== after.length) {
        for (const message of before) invalidate(message.content)
        for (const message of after) invalidate(message.content)
        return
      }
      for (const [messageIndex, original] of before.entries()) {
        const copied = after[messageIndex]!
        if (original.role !== copied.role || original.content.length !== copied.content.length) {
          invalidate(original.content)
          invalidate(copied.content)
          continue
        }
        for (const [partIndex, part] of original.content.entries()) {
          const indices = parts.get(part)
          if (!indices) continue
          const next = copied.content[partIndex]!
          if (
            part.type !== "tool-result" ||
            next.type !== "tool-result" ||
            part.id !== next.id ||
            part.name !== next.name ||
            part.result.type !== next.result.type
          ) {
            invalidate([part, next])
            continue
          }
          parts.set(next, [...new Set([...(parts.get(next) ?? []), ...indices])])
        }
      }
    },
    capture(messages) {
      const locations = new Map<number, PreparedSource.Mapping>()
      for (const [messageIndex, message] of (sources.length > 0 ? messages : []).entries()) {
        for (const [partIndex, part] of message.content.entries()) {
          if (part.type !== "tool-result") continue
          for (const index of parts.get(part) ?? []) {
            if (locations.has(index)) {
              locations.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
              continue
            }
            const candidate = outcomes.get(index)
            if (!candidate || "state" in candidate) continue
            const source = sources[index]!
            const nested =
              part.result.type === "content" ? part.result.value[candidate.resultContentIndex ?? -1] : undefined
            const text =
              candidate.resultType === "text" && part.result.type === "text"
                ? part.result.value
                : candidate.resultType === "content" && nested?.type === "text"
                  ? nested.text
                  : undefined
            if (text !== source.text || (message.role !== "assistant" && message.role !== "tool")) {
              locations.set(index, { state: "unmapped", reason: "prepared-value-changed" })
              continue
            }
            locations.set(index, {
              state: "mapped",
              messageIndex,
              partIndex,
              role: message.role,
              resultType: candidate.resultType,
              ...(candidate.resultContentIndex === undefined
                ? {}
                : { resultContentIndex: candidate.resultContentIndex }),
            })
          }
        }
      }
      return {
        ...snapshot,
        mapping: "observed-at-prepared-request",
        sources: sources.map((source, index) => {
          const outcome = outcomes.get(index)
          const prepared =
            outcome && "state" in outcome
              ? outcome
              : (locations.get(index) ?? { state: "unmapped" as const, reason: "not-observed" as const })
          return { ...source, prepared }
        }),
      }
    },
  }
}
