import { describe, expect, test } from "bun:test"
import { GoalStateControl } from "../../src/goal/state"

function goal(overrides: Partial<ReturnType<typeof initial>> = {}) {
  return { ...initial(), ...overrides }
}

function initial() {
  return { id: "original", status: "active", iteration: 1, observations: ["[1] working"], replanned: false }
}

describe("goal state reconciliation", () => {
  test("an old loop cannot overwrite a replacement goal", () => {
    const replacement = goal({ id: "replacement", iteration: 0 })
    expect(GoalStateControl.merge(replacement, goal({ status: "completed" }))).toBe(replacement)
  })

  test.each(["paused", "cancelled", "blocked", "completed"])(
    "%s persisted during a provider turn wins over its stale result",
    (status) => {
      const controlled = goal({ status })
      expect(GoalStateControl.merge(controlled, goal({ status: "active", iteration: 2 }))).toBe(controlled)
      expect(GoalStateControl.merge(controlled, goal({ status: "completed", iteration: 2 }))).toBe(controlled)
    },
  )

  test("steering arriving during execution survives the next progress save", () => {
    const current = goal({ observations: ["[1] working", "[user] Only inspect the local source"], replanned: true })
    const incoming = goal({ iteration: 2, observations: ["[1] working", "[2] new evidence"] })
    const saved = GoalStateControl.merge(current, incoming)
    expect(saved.iteration).toBe(2)
    expect(saved.observations).toEqual(["[1] working", "[2] new evidence", "[user] Only inspect the local source"])
    expect(saved.replanned).toBe(true)
    expect(GoalStateControl.userUpdates(saved.observations)).toEqual(["- Only inspect the local source"])
  })

  test("repeated saves retain each steering message once", () => {
    const current = goal({ observations: ["[user] Keep changes local"], replanned: true })
    const saved = GoalStateControl.merge(current, goal())
    expect(GoalStateControl.merge(saved, saved).observations.filter((line) => line.startsWith("[user]"))).toEqual([
      "[user] Keep changes local",
    ])
  })

  test("full user instructions survive observation trimming and stale completion", () => {
    const instruction = `${"Scope detail. ".repeat(200)}Do not change files outside the requested directory.`
    const current = { ...goal(), instructions: [instruction], observations: ["[2] latest report"] }
    const incoming = { ...goal({ status: "completed" }), instructions: [] as string[] }
    const saved = GoalStateControl.merge(current, incoming)
    expect(saved.status).toBe("active")
    expect(saved.instructions).toEqual([instruction])
    expect(GoalStateControl.userUpdates(saved.observations, saved.instructions)).toContain(`- ${instruction}`)
  })

  test("more than five recent instructions remain available and preserve their order", () => {
    const instructions = Array.from({ length: 7 }, (_, index) => `Scope instruction ${index}`)
    const observations = instructions.map((instruction) => `[user] ${instruction}`)
    const current = { ...goal({ observations }), instructions }
    const saved = GoalStateControl.merge(current, current)
    expect(GoalStateControl.userUpdates(saved.observations, saved.instructions)).toEqual(
      instructions.map((instruction) => `- ${instruction}`),
    )
    expect(GoalStateControl.instructionTexts([], saved.instructions)).toEqual(instructions)
  })

  test("repeated overrides preserve occurrences without duplicating them through snapshots", () => {
    const instructions = ["Use X", "Use Y", "Use X"]
    const observations = instructions.map((instruction) => `[user] ${instruction}`)
    const current = { ...goal({ observations }), instructions }
    const stale = { ...goal(), instructions: ["Use X"] }
    const saved = GoalStateControl.merge(current, stale)
    expect(saved.instructions).toEqual(instructions)
    expect(GoalStateControl.merge(saved, saved).instructions).toEqual(instructions)
    expect(GoalStateControl.userUpdates(observations, saved.instructions)).toEqual(["- Use X", "- Use Y", "- Use X"])
    expect(GoalStateControl.userUpdates(observations)).toEqual(["- Use X", "- Use Y", "- Use X"])
  })
})

describe("goal resume budget", () => {
  test("a paused goal reuses its remaining budget without resetting usage", () => {
    expect(GoalStateControl.resumeLimit(7, 10)).toBe(10)
  })

  test("an exhausted goal needs an explicit new budget", () => {
    expect(GoalStateControl.resumeLimit(10, 10)).toBeUndefined()
    expect(GoalStateControl.resumeLimit(12, 10)).toBeUndefined()
    expect(GoalStateControl.resumeLimit(10, 10, 3)).toBe(13)
  })

  test("each explicitly renewed budget stays bounded", () => {
    expect(GoalStateControl.resumeLimit(20, 20, 999)).toBe(520)
    expect(GoalStateControl.resumeLimit(20, 20, 0)).toBe(21)
  })
})
