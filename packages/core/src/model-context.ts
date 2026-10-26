export const CONTEXT_MAX = 248_000

export function limitContext<T extends { context: number; input?: number }>(limit: T, providerID?: string): T {
  const maximum = providerID === "drael" ? 128_000 : CONTEXT_MAX
  const context = limit.context > 0 ? Math.min(limit.context, maximum) : limit.context
  return {
    ...limit,
    context,
    ...(limit.input !== undefined && context > 0 ? { input: Math.min(limit.input, context) } : {}),
  }
}
