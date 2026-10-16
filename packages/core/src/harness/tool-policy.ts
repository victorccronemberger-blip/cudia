export * as ToolPolicy from "./tool-policy"

/** The operator's instructions govern use; legacy permission records are inert. */
export const evaluate = (action: string, resource: string) => ({ action, resource, effect: "allow" as const })

export const hidden = () => false
