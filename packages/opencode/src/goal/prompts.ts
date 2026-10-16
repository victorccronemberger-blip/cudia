export * as GoalPrompts from "./prompts"

type State = {
  objective: string
  iteration: number
  maxIterations: number
  completionCriteria: string[]
  plan: Array<{ description: string; status: string }>
  observations: string[]
  failures: Array<{ iteration: number; error: string }>
  latestEvidence?: { iteration: number; text: string; messageID: string }
}

type Verification = {
  criteria: Array<{ criterion: string; passed: boolean; evidence?: string }>
  remainingWork: string[]
  recommendedNextAction?: string
}

export function plan(objective: string): string {
  return [
    "Plan only the requested objective: a nonempty set of verifiable outcomes and the fewest necessary steps.",
    "Do not add deliverables or checks beyond the objective. Keep descriptions concise.",
    `Objective:\n${objective}`,
  ].join("\n")
}

export function initial(goal: State, updates: string[], verification?: Verification): string {
  return [
    `[GOAL LOOP ${goal.iteration + 1}/${goal.maxIterations}]`,
    `Objective:\n${goal.objective}`,
    "Criteria:",
    ...goal.completionCriteria.map((criterion, index) => `C${index + 1}: ${criterion}`),
    "Plan:",
    ...goal.plan.map((step, index) => `${index + 1}. ${step.description} (${step.status})`),
    ...(updates.length ? ["User steering (oldest first; later updates resolve conflicts):", ...updates] : []),
    ...(verification ? feedback(goal, verification) : []),
    "An independent verifier will check the requested outcomes against evidence.",
  ].join("\n")
}

export function continuation(
  goal: State,
  updates: string[],
  verification?: Verification,
  previous?: Verification,
  replan = false,
): string {
  return [
    `[GOAL LOOP ${goal.iteration + 1}/${goal.maxIterations}]`,
    ...(updates.length ? ["New user steering (oldest first):", ...updates] : []),
    ...(verification
      ? feedback(goal, verification, previous)
      : ["Verification must be repeated under the current instructions."]),
    ...(replan ? ["Progress has stalled. Reassess the approach within the same objective and scope."] : []),
    "Continue toward the open criteria.",
  ].join("\n")
}

export function verify(goal: State, updates: string[]): string {
  const report = goal.latestEvidence?.iteration === goal.iteration ? goal.latestEvidence : undefined
  const legacy = goal.observations.findLast((observation) => /^\[\d+\]/.test(observation))
  const failure = goal.failures.findLast((item) => item.iteration === goal.iteration)
  return [
    `[GOAL VERIFY ${goal.iteration}/${goal.maxIterations}]`,
    `Objective:\n${goal.objective}`,
    "Criteria:",
    ...goal.completionCriteria.map((criterion) => `- ${criterion}`),
    ...(updates.length ? ["User steering (oldest first; later updates resolve conflicts):", ...updates] : []),
    "Verify each requested outcome independently with positive evidence; use tools only as needed. Reports are hints, not proof. Return concise evidence references, not raw logs.",
    ...(report
      ? [`Latest executor report (${report.messageID}; excerpt):`, excerpt(report.text, 1200)]
      : legacy
        ? ["Latest executor report (excerpt):", excerpt(legacy, 1200)]
        : []),
    ...(failure ? ["Latest execution failure:", excerpt(failure.error, 600)] : []),
  ].join("\n")
}

function feedback(goal: State, verification: Verification, previous?: Verification): string[] {
  const checks = goal.completionCriteria.map((criterion, index) => ({
    id: `C${index + 1}`,
    current: verification.criteria.find((item) => item.criterion === criterion),
    previous: previous?.criteria.find((item) => item.criterion === criterion),
  }))
  const changed = checks.filter((check) => !previous || check.current?.passed !== check.previous?.passed)
  const open = checks.filter((check) => check.current?.passed !== true).map((check) => check.id)
  const evidence = checks
    .filter(
      (check) =>
        check.current?.passed !== true &&
        check.current?.evidence &&
        check.current.evidence !== check.previous?.evidence,
    )
    .slice(0, 3)
  const remaining = verification.remainingWork.map((item) => {
    const index = goal.completionCriteria.indexOf(item)
    return index >= 0 ? `C${index + 1}` : item
  })
  return [
    changed.length
      ? `Verification changes: ${changed.map((check) => `${check.id} ${check.current?.passed ? "passed" : "pending"}`).join("; ")}`
      : "Verification status unchanged.",
    `Open: ${open.join(", ") || "none"}.`,
    ...evidence.map((check) => `${check.id} evidence hint: ${excerpt(check.current!.evidence!, 240)}`),
    ...(remaining.length && JSON.stringify(verification.remainingWork) !== JSON.stringify(previous?.remainingWork)
      ? [`Remaining: ${excerpt(remaining.join("; "), 700)}`]
      : []),
    ...(verification.recommendedNextAction && verification.recommendedNextAction !== previous?.recommendedNextAction
      ? [`Next: ${excerpt(verification.recommendedNextAction, 300)}`]
      : []),
  ]
}

// Only model reports are excerpted. Objectives, criteria and user instructions
// retain their full text; the original reports remain in session/goal storage.
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = "\n[excerpt; full report stored]\n"
  const head = Math.ceil((limit - marker.length) / 2)
  return `${text.slice(0, head)}${marker}${text.slice(-(limit - marker.length - head))}`
}
