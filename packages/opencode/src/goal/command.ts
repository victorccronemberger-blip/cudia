export type Command =
  | { type: "status" | "pause" | "clear" | "cancel" }
  | { type: "resume"; maxIterations?: number; tokenBudget?: number }
  | { type: "start"; objective: string; replace: boolean; maxIterations?: number; tokenBudget?: number }
  | { type: "error"; message: string }

type ParsedFlags = {
  maxIterations?: number
  tokenBudget?: number
}

type Token = { text: string; start: number; end: number }

export function parseCommand(arguments_: string): Command {
  const tokens = [...arguments_.matchAll(/\S+/g)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
  if (tokens.length === 0) return { type: "status" }

  const first = tokens[0]!.text
  if (first === "status") {
    if (tokens.length === 1) return { type: "status" }
    return reservedArgumentError("status")
  }
  if (first === "pause" || first === "clear" || first === "cancel") {
    if (tokens.length === 1) return { type: first }
    return reservedArgumentError(first)
  }
  if (first === "resume" || first === "continue") {
    const parsed = parseFlags(tokens.slice(1), arguments_)
    if ("error" in parsed) return parsed.error
    if (parsed.objective.trim()) return { type: "error", message: "Resume does not accept an objective." }
    return { type: "resume", ...parsed.flags }
  }

  const replace = first === "replace"
  const source = replace ? tokens.slice(1) : tokens
  const parsed = parseFlags(source, arguments_)
  if ("error" in parsed) return parsed.error
  if (!parsed.objective.trim()) {
    return {
      type: "error",
      message: replace ? "Usage: /goal replace <objective>" : "Usage: /goal <objective>",
    }
  }
  return { type: "start", objective: parsed.objective, replace, ...parsed.flags }
}

function parseFlags(
  tokens: Token[],
  source: string,
): { objective: string; flags: ParsedFlags } | { error: Extract<Command, { type: "error" }> } {
  const flags: ParsedFlags = {}
  const removed: Array<{ start: number; end: number }> = []
  const sourceStart = tokens[0]?.start ?? source.length
  let literal = false

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.text === "--") {
      const after = source.slice(token.end)
      literal = true
      removed.push({ start: token.start, end: /^\s/.test(after) ? token.end + 1 : token.end })
      break
    }

    const key =
      token.text === "--max-iterations" ? "maxIterations" : token.text === "--token-budget" ? "tokenBudget" : undefined
    if (!key) {
      if (token.text.startsWith("--")) {
        return { error: { type: "error", message: `Unknown goal option: ${token.text}` } }
      }
      continue
    }

    if (flags[key] !== undefined) {
      return { error: { type: "error", message: `Goal option ${token.text} may be used only once.` } }
    }
    const value = tokens[++index]
    if (value === undefined || value.text === "--" || value.text.startsWith("--")) {
      return { error: { type: "error", message: `Goal option ${token.text} requires a positive integer value.` } }
    }
    if (!/^\d+$/.test(value.text) || !Number.isSafeInteger(Number(value.text)) || Number(value.text) < 1) {
      return { error: { type: "error", message: `Goal option ${token.text} requires a positive safe integer.` } }
    }
    flags[key] = Number(value.text)
    removed.push({ start: token.start, end: value.end })
  }

  let objective = ""
  let cursor = sourceStart
  for (const span of removed) {
    objective += source.slice(cursor, span.start)
    cursor = span.end
  }
  objective += source.slice(cursor)
  return { objective: literal ? objective.trimStart() : objective.trim(), flags }
}

function reservedArgumentError(command: string): Extract<Command, { type: "error" }> {
  return {
    type: "error",
    message: `The /goal ${command} command does not accept arguments. Use "-- ${command} ..." for a literal objective.`,
  }
}
