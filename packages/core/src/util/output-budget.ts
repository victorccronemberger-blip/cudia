export * as OutputBudget from "./output-budget"

export interface Limits {
  readonly maxBytes: number
  readonly maxLines: number
}

/** Measure the complete domain response, including framing and escaped content. */
export function fits(text: string, limits: Limits) {
  if (
    !Number.isSafeInteger(limits.maxLines) ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxLines < 1 ||
    limits.maxBytes < 0 ||
    Buffer.byteLength(text, "utf8") > limits.maxBytes
  )
    return false
  let lines = 1
  for (const character of text) {
    if (character === "\n" && ++lines > limits.maxLines) return false
  }
  return true
}

export function resolve(configured: Limits, defaults: Limits): Limits {
  return {
    maxBytes: Math.min(configured.maxBytes, defaults.maxBytes),
    maxLines: Math.min(configured.maxLines, defaults.maxLines),
  }
}
