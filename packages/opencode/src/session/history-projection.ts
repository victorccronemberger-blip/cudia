import type { UIMessage } from "ai"
import type { ContextAudit } from "@opencode-ai/core/harness/audit"
import type { PreparedSource } from "@opencode-ai/core/harness/prepared-source"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Message, ToolResultPart } from "@opencode-ai/llm"

type Snapshot = NonNullable<ContextAudit.Input["historySnapshot"]>
type Candidate = { readonly output: unknown; rendered: boolean }
/** Narrow observation contract for the owned native adapter; no Session services. */
export type Native = {
  readonly nativeResult: (output: unknown, result: ToolResultPart) => void
  readonly nativeCopied: (
    before: ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<unknown> }>,
    after: ReadonlyArray<Message>,
  ) => void
}
export type Collector = Native & {
  readonly register: (input: {
    readonly messageIndex: number
    readonly partIndex: number
    readonly messageID: string
    readonly part: SessionV1.ToolPart
    readonly input: unknown
    readonly output: unknown
  }) => void
  readonly seal: (messages: ReadonlyArray<UIMessage>) => void
  readonly render: (
    toolName: string,
    call: { toolCallId: string; input: unknown; output: unknown },
    result: unknown,
  ) => void
  readonly capture: (messages: ReadonlyArray<unknown>) => Snapshot
}

const object = (value: unknown): value is object => typeof value === "object" && value !== null

/** Read only own data; audit observations must not invoke plugin-provided accessors. */
function data(value: unknown, key: string): unknown {
  if (!object(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** Request-local observations at the SDK's actual toModelOutput callback, never a text/ID search. */
export function create(snapshot: Snapshot): Collector {
  const sources = snapshot.sources.slice(0, 128)
  const targets = new Map<string, number[]>()
  const inputs = new WeakMap<object, number[]>()
  const leaves = new WeakMap<object, number[]>()
  const nativeParts = new WeakMap<object, number[]>()
  const outcomes = new Map<number, Candidate | PreparedSource.Mapping>()
  for (const [index, source] of sources.entries()) {
    const key = `${source.messageIndex}:${source.partIndex}`
    targets.set(key, [...(targets.get(key) ?? []), index])
  }
  let sealed = false
  const invalidate = (parts: ReadonlyArray<unknown>) => {
    for (const part of parts) {
      if (!object(part)) continue
      for (const index of nativeParts.get(part) ?? []) {
        outcomes.set(index, { state: "unmapped", reason: "copy-boundary-changed" })
      }
    }
  }
  return {
    register(input) {
      for (const index of targets.get(`${input.messageIndex}:${input.partIndex}`) ?? []) {
        const source = sources[index]!
        if (outcomes.has(index)) {
          outcomes.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
          continue
        }
        if (
          source.messageID !== input.messageID ||
          source.partID !== input.part.id ||
          source.tool?.callID !== input.part.callID ||
          source.tool.name !== input.part.tool
        ) {
          outcomes.set(index, { state: "unmapped", reason: "source-mismatch" })
          continue
        }
        if (input.part.state.status !== "completed" || !object(input.input)) {
          outcomes.set(index, { state: "unmapped", reason: "unsupported-result" })
          continue
        }
        const projected = typeof input.output === "string" ? input.output : data(input.output, "text")
        if (input.part.state.output !== source.text) {
          outcomes.set(index, { state: "unmapped", reason: "source-mismatch" })
          continue
        }
        if (projected !== source.text) {
          outcomes.set(index, { state: "unmapped", reason: "prepared-value-changed" })
          continue
        }
        outcomes.set(index, { output: input.output, rendered: false })
        inputs.set(input.input, [...(inputs.get(input.input) ?? []), index])
      }
    },
    seal(messages) {
      const occurrences = new Map<number, number>()
      // Scan the canonical UI inputs, including untracked tools sharing an input object.
      // Only the existing tracked keys allocate counters, keeping this sidecar bounded.
      for (const message of messages) {
        for (const part of message.parts) {
          if (!part.type.startsWith("tool-") || data(part, "state") !== "output-available") continue
          const input = data(part, "input")
          if (!object(input)) continue
          for (const index of inputs.get(input) ?? []) occurrences.set(index, (occurrences.get(index) ?? 0) + 1)
        }
      }
      for (const [index, count] of occurrences) {
        if (count !== 1) outcomes.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
      }
      sealed = true
    },
    render(toolName, call, result) {
      if (!sealed || !object(call.input)) return
      for (const index of inputs.get(call.input) ?? []) {
        const candidate = outcomes.get(index)
        if (!candidate || "state" in candidate) continue
        const source = sources[index]!
        if (candidate.rendered) {
          outcomes.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
          continue
        }
        if (
          source.tool?.name !== toolName ||
          source.tool.callID !== call.toolCallId ||
          candidate.output !== call.output
        ) {
          outcomes.set(index, { state: "unmapped", reason: "source-mismatch" })
          continue
        }
        candidate.rendered = true
        const value = data(result, "value")
        const leaf =
          data(result, "type") === "text"
            ? result
            : data(result, "type") === "content" && Array.isArray(value)
              ? value.find((item) => data(item, "type") === "text")
              : undefined
        if (!object(leaf)) {
          outcomes.set(index, { state: "unmapped", reason: "unsupported-result" })
          continue
        }
        leaves.set(leaf, [...(leaves.get(leaf) ?? []), index])
      }
    },
    nativeResult(output, result) {
      const value = data(output, "value")
      const parts =
        data(output, "type") === "text"
          ? [output]
          : data(output, "type") === "content" && Array.isArray(value)
            ? value
            : []
      for (const part of parts) {
        if (!object(part)) continue
        for (const index of leaves.get(part) ?? []) {
          const candidate = outcomes.get(index)
          if (!candidate || "state" in candidate) continue
          if (data(output, "type") !== "text" || result.result.type !== "text") {
            outcomes.set(index, { state: "unmapped", reason: "unsupported-result" })
            continue
          }
          const source = sources[index]!
          if (
            result.id !== source.tool?.callID ||
            result.name !== source.tool?.name ||
            result.result.value !== source.text
          ) {
            outcomes.set(index, { state: "unmapped", reason: "prepared-value-changed" })
            continue
          }
          nativeParts.set(result, [...(nativeParts.get(result) ?? []), index])
        }
      }
    },
    nativeCopied(before, after) {
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
          if (!object(part)) continue
          const indices = nativeParts.get(part)
          if (!indices) continue
          const next = copied.content[partIndex]!
          if (
            data(part, "type") !== "tool-result" ||
            next.type !== "tool-result" ||
            data(part, "id") !== next.id ||
            data(part, "name") !== next.name ||
            data(data(part, "result"), "type") !== next.result.type
          ) {
            invalidate([part, next])
            continue
          }
          nativeParts.set(next, [...new Set([...(nativeParts.get(next) ?? []), ...indices])])
        }
      }
    },
    capture(messages) {
      const locations = new Map<number, PreparedSource.Mapping>()
      for (const [messageIndex, message] of (sources.length > 0 ? messages : []).entries()) {
        const content = data(message, "content")
        if (!Array.isArray(content)) continue
        for (const [partIndex, part] of content.entries()) {
          if (data(part, "type") !== "tool-result") continue
          for (const index of object(part) ? (nativeParts.get(part) ?? []) : []) {
            if (locations.has(index)) {
              locations.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
              continue
            }
            const source = sources[index]!
            const role = data(message, "role")
            const result = data(part, "result")
            if (
              data(result, "type") !== "text" ||
              data(result, "value") !== source.text ||
              data(part, "id") !== source.tool?.callID ||
              data(part, "name") !== source.tool?.name ||
              (role !== "assistant" && role !== "tool")
            ) {
              locations.set(index, { state: "unmapped", reason: "prepared-value-changed" })
              continue
            }
            locations.set(index, { state: "mapped", messageIndex, partIndex, role, resultType: "text" })
          }
          const output = data(part, "output")
          const resultType = data(output, "type")
          const value = data(output, "value")
          const parts = resultType === "text" ? [output] : resultType === "content" && Array.isArray(value) ? value : []
          for (const [resultContentIndex, leaf] of parts.entries()) {
            if (!object(leaf)) continue
            for (const index of leaves.get(leaf) ?? []) {
              if (locations.has(index)) {
                locations.set(index, { state: "unmapped", reason: "ambiguous-occurrence" })
                continue
              }
              const source = sources[index]!
              const role = data(message, "role")
              const text = data(leaf, resultType === "text" ? "value" : "text")
              if (
                text !== source.text ||
                (resultType === "content" && data(leaf, "type") !== "text") ||
                data(part, "toolCallId") !== source.tool?.callID ||
                data(part, "toolName") !== source.tool?.name ||
                (role !== "tool" && role !== "assistant")
              ) {
                locations.set(index, { state: "unmapped", reason: "prepared-value-changed" })
                continue
              }
              locations.set(index, {
                state: "mapped",
                messageIndex,
                partIndex,
                role,
                resultType: resultType === "text" ? "text" : "content",
                ...(resultType === "content" ? { resultContentIndex } : {}),
              })
            }
          }
        }
      }
      return {
        ...snapshot,
        mapping: "observed-at-prepared-request",
        sources: sources.map((source, index) => {
          const outcome = outcomes.get(index)
          return {
            ...source,
            prepared:
              outcome && "state" in outcome
                ? outcome
                : (locations.get(index) ?? { state: "unmapped" as const, reason: "not-observed" as const }),
          }
        }),
      }
    },
  }
}

export * as HistoryProjection from "./history-projection"
