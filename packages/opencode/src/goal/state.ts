export * as GoalStateControl from "./state"

type Snapshot = {
  id: string
  status: string
  observations: string[]
  replanned: boolean
  lastVerification?: unknown
  instructions?: string[]
}

// Loop snapshots may lag behind control commands or steering persisted by
// another request. A stopped or replaced goal always wins over that snapshot.
export function merge<T extends Snapshot>(current: T, incoming: T): T {
  if (current.id !== incoming.id || current.status !== "active") return current
  const updates = current.observations.filter(
    (observation) => observation.startsWith("[user]") && !incoming.observations.includes(observation),
  )
  const instructions = instructionTexts(current.observations, current.instructions)
  const previous = instructionTexts(incoming.observations, incoming.instructions)
  const changedInstructions =
    instructions.length !== previous.length ||
    instructions.some((instruction, index) => instruction !== previous[index])
  return {
    ...incoming,
    ...(incoming.status === "completed" && (updates.length || changedInstructions)
      ? { status: "active", lastVerification: undefined }
      : {}),
    instructions,
    observations: [...incoming.observations, ...updates].slice(-50),
    replanned: incoming.replanned || current.replanned,
  }
}

export function resumeLimit(iteration: number, limit: number, additional?: number): number | undefined {
  if (additional !== undefined) return iteration + Math.max(1, Math.min(additional, 500))
  return iteration < limit ? limit : undefined
}

export function instructionTexts(observations: string[], stored?: string[]): string[] {
  return (
    stored ??
    observations
      .filter((observation) => observation.startsWith("[user] "))
      .map((observation) => observation.slice("[user] ".length))
  )
}

export function userUpdates(observations: string[], stored?: string[]): string[] {
  return instructionTexts(observations, stored).map((instruction) => `- ${instruction}`)
}
