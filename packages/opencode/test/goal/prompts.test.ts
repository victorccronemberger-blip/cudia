import { describe, expect, test } from "bun:test"
import { GoalPrompts } from "../../src/goal/prompts"

function state() {
  return {
    objective: "Update the requested files while retaining the existing API.",
    iteration: 2,
    maxIterations: 5,
    completionCriteria: ["The requested files contain the change", "The existing API is retained"],
    plan: [{ description: "Inspect the affected files", status: "running" }],
    observations: Array.from({ length: 10 }, (_, index) => `[${index}] OLD REPORT ${index} ${"old logs ".repeat(60)}`),
    failures: [],
    latestEvidence: {
      iteration: 2,
      text: `LATEST START ${"latest logs ".repeat(1000)} LATEST END`,
      messageID: "report",
    },
  }
}

function verification() {
  return {
    criteria: [
      { criterion: "The requested files contain the change", passed: false, evidence: "pending evidence ".repeat(100) },
      { criterion: "The existing API is retained", passed: true, evidence: "old API evidence ".repeat(100) },
    ],
    remainingWork: ["The requested files contain the change"],
    recommendedNextAction: "Inspect the requested change.",
  }
}

describe("compact goal prompts", () => {
  test("fresh verifiers retain the full objective, criteria and instructions but receive only a bounded latest report", () => {
    const goal = state()
    const instruction = `- Preserve this entire user instruction: ${"scope ".repeat(700)}END OF USER INSTRUCTION`
    const prompt = GoalPrompts.verify(goal, [instruction])
    expect(prompt).toContain(goal.objective)
    for (const criterion of goal.completionCriteria) expect(prompt).toContain(criterion)
    expect(prompt).toContain(instruction)
    expect(prompt).toContain("LATEST START")
    expect(prompt).toContain("LATEST END")
    expect(prompt).toContain("Reports are hints, not proof")
    expect(prompt).not.toContain("OLD REPORT")
    expect(prompt).not.toContain(goal.latestEvidence.text)
    const authoritative = goal.objective.length + goal.completionCriteria.join("\n").length + instruction.length
    expect(prompt.length - authoritative).toBeLessThan(1700)
    expect(goal.latestEvidence.text.length).toBeGreaterThan(10000)
  })

  test("unchanged verification reports do not repeat their logs or next action", () => {
    const goal = state()
    const report = verification()
    const first = GoalPrompts.continuation(goal, [], report)
    const delta = GoalPrompts.continuation(goal, [], report, report)
    expect(first).toContain("C1 pending")
    expect(first).toContain("C2 passed")
    expect(first).not.toContain(report.criteria[0]!.evidence)
    expect(delta).toContain("Open: C1")
    expect(delta).not.toContain("pending evidence")
    expect(delta).not.toContain("old API evidence")
    expect(delta).not.toContain(report.recommendedNextAction)
    expect(delta.length).toBeLessThan(160)
    expect(delta.length).toBeLessThan(first.length / 2)
  })

  test("changed criteria and recent instructions survive deltas without copying the old report", () => {
    const goal = state()
    const previous = verification()
    const current = {
      ...previous,
      criteria: previous.criteria.map((criterion) => ({ ...criterion, passed: true })),
      remainingWork: [],
    }
    const instruction = `- ${"Full recent scope instruction. ".repeat(100)}`
    const prompt = GoalPrompts.continuation(goal, [instruction], current, previous)
    expect(prompt).toContain("C1 passed")
    expect(prompt).toContain("Open: none")
    expect(prompt).toContain(instruction)
    expect(prompt).not.toContain("C2 passed")
    expect(prompt).not.toContain("old API evidence")
  })
})
