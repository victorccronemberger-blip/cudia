import { describe, expect, test } from "bun:test"
import { parseCommand } from "../../src/goal/command"

describe("goal command parsing", () => {
  test.each(["", "   ", "status"])("%j shows status", (input) => {
    expect(parseCommand(input)).toEqual({ type: "status" })
  })

  test.each(["pause", "clear", "cancel"])("%s is an exact lifecycle command", (input) => {
    expect(parseCommand(input)).toEqual({ type: input })
  })

  test.each(["resume", "continue"])("%s resumes without a new limit", (input) => {
    expect(parseCommand(input)).toEqual({ type: "resume" })
  })

  test("accepts flags before and after the objective", () => {
    expect(parseCommand("--token-budget 120 --max-iterations 8 implement the feature")).toEqual({
      type: "start",
      objective: "implement the feature",
      replace: false,
      tokenBudget: 120,
      maxIterations: 8,
    })
    expect(parseCommand("implement the feature --max-iterations 8 --token-budget 120")).toEqual({
      type: "start",
      objective: "implement the feature",
      replace: false,
      tokenBudget: 120,
      maxIterations: 8,
    })
  })

  test("parses explicit replacement and resume limits", () => {
    expect(parseCommand("replace --max-iterations 4 update the implementation")).toEqual({
      type: "start",
      objective: "update the implementation",
      replace: true,
      maxIterations: 4,
    })
    expect(parseCommand("resume --token-budget 900 --max-iterations 12")).toEqual({
      type: "resume",
      tokenBudget: 900,
      maxIterations: 12,
    })
  })

  test("preserves multiline objectives and code fences", () => {
    const objective = "Implement this change:\n\n```ts\nconst total = one + two\n```\n\nKeep the output readable."
    expect(parseCommand(objective)).toEqual({ type: "start", objective, replace: false })
  })

  test("removes embedded budget flags without normalizing surrounding whitespace", () => {
    expect(parseCommand("first line\n  --max-iterations 3\tsecond line\n\nfinal line")).toEqual({
      type: "start",
      objective: "first line\n  \tsecond line\n\nfinal line",
      replace: false,
      maxIterations: 3,
    })
  })

  test("preserves multiline replacement objectives", () => {
    const objective = "Refactor the requested code:\n\n```ts\nreturn value\n```\nThen describe the change."
    expect(parseCommand(`replace ${objective}`)).toEqual({ type: "start", objective, replace: true })
  })

  test("keeps the literal text after -- verbatim and does not parse its options", () => {
    expect(parseCommand("--max-iterations 2 explain --   status report --token-budget 4  ")).toEqual({
      type: "start",
      objective: "explain   status report --token-budget 4  ",
      replace: false,
      maxIterations: 2,
    })
    expect(parseCommand("-- status report for project")).toEqual({
      type: "start",
      objective: "status report for project",
      replace: false,
    })
    expect(parseCommand("-- pause the background task")).toEqual({
      type: "start",
      objective: "pause the background task",
      replace: false,
    })
  })

  test("does not reinterpret subcommand words followed by extra text", () => {
    expect(parseCommand("status report for project")).toMatchObject({ type: "error" })
    expect(parseCommand("pause extra")).toMatchObject({ type: "error" })
    expect(parseCommand("cancel this goal")).toMatchObject({ type: "error" })
    expect(parseCommand("resume later")).toMatchObject({ type: "error" })
    expect(parseCommand("continue later")).toMatchObject({ type: "error" })
  })

  test("requires a replacement objective", () => {
    expect(parseCommand("replace")).toMatchObject({ type: "error" })
    expect(parseCommand("replace --token-budget 1")).toMatchObject({ type: "error" })
  })

  test.each([
    "--max-iterations",
    "--token-budget",
    "--max-iterations --token-budget 2",
    "--max-iterations=3 ship it",
    "ship it --unknown 3",
    "--max-iterations 0 ship it",
    "--token-budget -1 ship it",
    "--max-iterations 1.5 ship it",
    "--token-budget 9007199254740992 ship it",
    "--max-iterations 2 --max-iterations 3 ship it",
    "--token-budget 3 --token-budget 4 ship it",
  ])("rejects invalid option input: %s", (input) => {
    expect(parseCommand(input)).toMatchObject({ type: "error" })
  })

  test("rejects malformed resume flags and duplicate options", () => {
    expect(parseCommand("resume --max-iterations 0")).toMatchObject({ type: "error" })
    expect(parseCommand("resume --token-budget 3 --token-budget 4")).toMatchObject({ type: "error" })
  })
})
