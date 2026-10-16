import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Goal } from "../../src/goal"
import { Session } from "../../src/session/session"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { PromptInput } from "../../src/session/prompt"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const waitFor = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  awaitWithTimeout(effect, message, "10 seconds")

const suite = testEffect(
  LayerNode.compile(LayerNode.group([Goal.node, Session.node, SessionProjector.node, Agent.node, Permission.node])),
)

function result(sessionID: SessionID, text = "done", structured?: Record<string, unknown>): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      parentID: MessageID.ascending(),
      sessionID,
      role: "assistant",
      agent: "build",
      mode: "build",
      modelID: ModelV2.ID.make("selected"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now(), completed: Date.now() },
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      ...(structured ? { structured } : {}),
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

function planning(input: PromptInput) {
  return result(input.sessionID, "", {
    criteria: ["done"],
    plan: [{ description: "do the requested work", status: "pending", attempts: 0 }],
  })
}

function verification(input: PromptInput, completed: boolean) {
  return result(input.sessionID, "", {
    completed,
    blocked: false,
    criteria: [{ criterion: "done", passed: completed, evidence: completed ? "observed" : "pending" }],
    remainingWork: completed ? [] : ["done"],
  })
}

// Exercise the delivery boundary against real session storage without a provider.
function admit(sessions: Session.Interface, input: PromptInput) {
  return Effect.gen(function* () {
    const id = input.messageID ?? MessageID.ascending()
    yield* sessions.updateMessage({
      id,
      sessionID: input.sessionID,
      role: "user",
      agent: input.agent ?? "build",
      model: input.model ?? { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("selected") },
      time: { created: Date.now() },
    })
    for (const part of input.parts) {
      if (part.type !== "text") continue
      yield* sessions.updatePart({ ...part, id: PartID.ascending(), sessionID: input.sessionID, messageID: id })
    }
  })
}

suite.instance("the chosen model reaches planning, execution, and verification", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const calls: PromptInput[] = []
    const run = (input: PromptInput) => {
      calls.push(input)
      return Effect.succeed(
        input.agent === "goal-planner"
          ? planning(input)
          : input.agent === "verifier"
            ? verification(input, true)
            : result(input.sessionID),
      )
    }
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish", model: "test/selected", variant: "thinking" },
      run,
      (text) => Effect.succeed(result(session.id, text)),
      () => Effect.void,
    )
    expect(calls.length).toBe(3)
    expect(calls.every((call) => call.model?.providerID === "test" && call.model?.modelID === "selected")).toBe(true)
    expect(calls.every((call) => call.variant === "thinking")).toBe(true)
    expect((yield* goal.get(session.id))?.status).toBe("completed")
  }),
)

suite.instance("planner and verifier retain parent records without imposing role-based tool restrictions", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const permissions = yield* Permission.Service
    const session = yield* sessions.create({
      permission: [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "webfetch", pattern: "*", action: "deny" },
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "edit", pattern: "*", action: "allow" },
      ],
    })
    const children: Array<{ agent: string; session: typeof session; actions: string[]; pending: number }> = []
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner" || input.agent === "verifier") {
          const child = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          const selected = yield* agents.get(input.agent)
          if (!selected) return yield* Effect.die(new Error(`Missing child agent: ${input.agent}`))
          const actions = ["bash", "webfetch", "edit", "read"].map(
            (name) => Permission.evaluate(name, "*", selected.permission, child.permission ?? []).action,
          )
          yield* permissions
            .ask({
              sessionID: child.id,
              permission: "bash",
              patterns: ["*"],
              always: ["*"],
              metadata: {},
              ruleset: Permission.merge(selected.permission, child.permission ?? []),
            })
            .pipe(Effect.orDie)
          children.push({ agent: input.agent, session: child, actions, pending: (yield* permissions.list()).length })
        }
        return input.agent === "goal-planner"
          ? planning(input)
          : input.agent === "verifier"
            ? verification(input, true)
            : result(input.sessionID)
      })
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish" },
      run,
      (text) => Effect.succeed(result(session.id, text)),
      () => Effect.void,
    )
    // Assertions outside run cannot be mistaken for provider failures by Goal's recovery loop.
    expect((yield* goal.get(session.id))?.status).toBe("completed")
    expect((yield* goal.get(session.id))?.failures).toEqual([])
    expect(children.map((child) => child.agent)).toEqual(["goal-planner", "verifier"])
    for (const child of children) {
      expect(child.session.id).not.toBe(session.id)
      expect(child.session.parentID).toBe(session.id)
      expect(child.session.permission).toEqual(session.permission)
      expect(child.actions).toEqual(["allow", "allow", "allow", "allow"])
      expect(child.pending).toBe(0)
    }
  }),
)

suite.instance("an empty planner response falls back to the objective and cannot pass empty criteria", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    let executions = 0
    const run = (input: PromptInput) => {
      if (input.agent === "goal-planner") {
        expect(input.format?.type).toBe("json_schema")
        if (input.format?.type === "json_schema") {
          expect(input.format.schema).toMatchObject({
            properties: { criteria: { minItems: 1 }, plan: { minItems: 1 } },
          })
        }
        return Effect.succeed(result(input.sessionID, "", { criteria: [], plan: [] }))
      }
      if (input.agent === "verifier")
        return Effect.succeed(
          result(input.sessionID, "", { completed: true, blocked: false, criteria: [], remainingWork: [] }),
        )
      executions++
      return Effect.succeed(result(input.sessionID))
    }
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish --max-iterations 1" },
      run,
      (text) => Effect.succeed(result(session.id, text)),
      () => Effect.void,
    )
    const state = yield* goal.get(session.id)
    expect(state?.completionCriteria).toEqual(["finish"])
    expect(state?.plan).toHaveLength(1)
    expect(state?.status).toBe("blocked")
    expect(executions).toBe(1)
  }),
)

suite.instance("steering during the verification response prevents stale completion", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const messages: string[] = []
    let steered = false
    const run = (input: PromptInput) => {
      if (!input.agent)
        messages.push(
          input.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        )
      return Effect.succeed(
        input.agent === "goal-planner"
          ? planning(input)
          : input.agent === "verifier"
            ? verification(input, true)
            : result(input.sessionID),
      )
    }
    const respond = (text: string) =>
      Effect.gen(function* () {
        if (!steered && text.includes("verification passed")) {
          steered = true
          yield* goal.observe(session.id, "Check the updated acceptance condition")
        }
        return result(session.id, text)
      })
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish --max-iterations 3" },
      run,
      respond,
      () => Effect.void,
    )
    expect(messages).toHaveLength(2)
    expect(messages[1]).toContain("Check the updated acceptance condition")
    expect((yield* goal.get(session.id))?.status).toBe("completed")
  }),
)

suite.instance("pause during a phase transition cannot start the next executor", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const stopping = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    let executions = 0
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return planning(input)
        }
        executions++
        return result(input.sessionID)
      })
    const fiber = yield* goal
      .command(
        { sessionID: session.id, command: "goal", arguments: "finish" },
        run,
        (text) => Effect.succeed(result(session.id, text)),
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(stopping, undefined)
            yield* Deferred.await(stopped)
          }),
      )
      .pipe(Effect.forkChild)
    yield* waitFor(Deferred.await(entered), "planner did not start")
    const pause = yield* goal.pause(session.id).pipe(Effect.forkChild)
    yield* waitFor(Deferred.await(stopping), "stop did not start")
    yield* Deferred.succeed(release, undefined)
    yield* waitFor(Fiber.await(fiber), "paused loop did not exit after planning")
    yield* Deferred.succeed(stopped, undefined)
    yield* waitFor(Fiber.join(pause), "pause did not return")
    expect(executions).toBe(0)
    expect((yield* goal.get(session.id))?.status).toBe("paused")
  }),
)

for (const stage of ["goal-planner", "executor", "verifier"]) {
  suite.instance(`pause stops ${stage} and stays paused`, () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create()
      const entered = yield* Deferred.make<SessionID>()
      const stopped: SessionID[] = []
      const run = (input: PromptInput) =>
        Effect.gen(function* () {
          if ((input.agent ?? "executor") === stage) {
            yield* Deferred.succeed(entered, input.sessionID)
            return yield* Effect.never
          }
          return input.agent === "goal-planner" ? planning(input) : verification(input, false)
        })
      const fiber = yield* goal
        .command(
          { sessionID: session.id, command: "goal", arguments: "finish" },
          run,
          (text) => Effect.succeed(result(session.id, text)),
          (sessionID) =>
            Effect.sync(() => {
              stopped.push(sessionID)
            }),
        )
        .pipe(Effect.forkChild)
      const target = yield* waitFor(Deferred.await(entered), "goal did not enter stage")
      yield* goal.pause(session.id)
      yield* waitFor(Fiber.await(fiber), "paused goal did not stop")
      expect(stopped).toContain(target)
      expect((yield* goal.get(session.id))?.status).toBe("paused")
    }),
  )
}

suite.instance("cancel during verification is durable and an active resume does not launch a second loop", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const entered = yield* Deferred.make<void>()
    let executions = 0
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") return planning(input)
        if (input.agent === "verifier") {
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }
        executions++
        return result(input.sessionID)
      })
    const respond = (text: string) => Effect.succeed(result(session.id, text))
    const fiber = yield* goal
      .command({ sessionID: session.id, command: "goal", arguments: "finish" }, run, respond, () => Effect.void)
      .pipe(Effect.forkChild)
    yield* waitFor(Deferred.await(entered), "goal did not enter verifier")
    const reply = yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "resume" },
      run,
      respond,
      () => Effect.void,
    )
    expect(reply.parts.some((part) => part.type === "text" && part.text.includes("already running"))).toBe(true)
    expect(executions).toBe(1)
    yield* goal.cancel(session.id)
    yield* waitFor(Fiber.await(fiber), "cancelled goal did not stop")
    expect((yield* goal.get(session.id))?.status).toBe("cancelled")
  }),
)

suite.instance("steering during execution survives persistence and appears in the next iteration", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const messages: string[] = []
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") return planning(input)
        if (input.agent === "verifier") return verification(input, messages.length > 1)
        messages.push(
          input.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        )
        if (messages.length === 1) {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return result(input.sessionID)
      })
    const fiber = yield* goal
      .command(
        { sessionID: session.id, command: "goal", arguments: "finish --max-iterations 3" },
        run,
        (text) => Effect.succeed(result(session.id, text)),
        () => Effect.void,
      )
      .pipe(Effect.forkChild)
    yield* waitFor(Deferred.await(entered), "goal did not enter execution")
    yield* goal.observe(session.id, "Only inspect the local source")
    yield* Deferred.succeed(release, undefined)
    yield* waitFor(Fiber.join(fiber), "goal did not complete")
    expect(messages[1]).toContain("Only inspect the local source")
    expect((yield* goal.get(session.id))?.observations).toContain("[user] Only inspect the local source")
  }),
)

suite.instance("resuming an exhausted goal requires and consumes an explicit additional budget", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    let executions = 0
    const run = (input: PromptInput) => {
      if (!input.agent) executions++
      return Effect.succeed(
        input.agent === "goal-planner"
          ? planning(input)
          : input.agent === "verifier"
            ? verification(input, false)
            : result(input.sessionID),
      )
    }
    const respond = (text: string) => Effect.succeed(result(session.id, text))
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish --max-iterations 1" },
      run,
      respond,
      () => Effect.void,
    )
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "resume" },
      run,
      respond,
      () => Effect.void,
    )
    expect(executions).toBe(1)
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "resume --max-iterations 2" },
      run,
      respond,
      () => Effect.void,
    )
    const state = yield* goal.get(session.id)
    expect(executions).toBe(3)
    expect(state?.iteration).toBe(3)
    expect(state?.maxIterations).toBe(3)
    expect(state?.status).toBe("blocked")
  }),
)

suite.instance("durable continuations send instruction/report deltas while full evidence remains stored", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const messages: string[] = []
    const checks: string[] = []
    const instructions = [
      `${"Full scope instruction. ".repeat(100)}INSTRUCTION TAIL`,
      ...Array.from({ length: 6 }, (_, index) => `Keep constraint ${index}`),
    ]
    let seeded = false
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") return planning(input)
        const text = input.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        if (input.agent === "verifier") {
          checks.push(text)
          return result(input.sessionID, "", {
            completed: messages.length === 3,
            blocked: false,
            criteria: [
              { criterion: "done", passed: messages.length === 3, evidence: "UNBOUNDED EVIDENCE ".repeat(300) },
            ],
            remainingWork: messages.length === 3 ? [] : ["done"],
          })
        }
        yield* admit(sessions, input)
        messages.push(text)
        return result(
          input.sessionID,
          `REPORT ${messages.length} ${"long output ".repeat(1000)} REPORT TAIL ${messages.length}`,
        )
      })
    const respond = (text: string) =>
      Effect.gen(function* () {
        if (!seeded && text.includes("Goal accepted")) {
          seeded = true
          for (const instruction of instructions) yield* goal.observe(session.id, instruction)
        }
        return result(session.id, text)
      })
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish --max-iterations 3", model: "test/selected" },
      run,
      respond,
      () => Effect.void,
    )
    expect(messages).toHaveLength(3)
    expect(checks).toHaveLength(3)
    expect(messages[0]).toContain(instructions[0]!)
    expect(messages[1]).not.toContain("INSTRUCTION TAIL")
    expect(messages[1]).toContain("C1 pending")
    expect(messages[2]).toContain("Verification status unchanged")
    expect(messages[2]).not.toContain("UNBOUNDED EVIDENCE")
    expect(messages[2]!.length).toBeLessThan(160)
    for (const check of checks) {
      for (const instruction of instructions) expect(check).toContain(instruction)
      expect(check).toContain("REPORT TAIL")
      expect(check).not.toContain("long output ".repeat(200))
    }
    expect(checks[1]).not.toContain("REPORT 1")
    const saved = yield* goal.get(session.id)
    expect(saved?.instructions).toEqual(instructions)
    expect(saved?.latestEvidence?.text).toBe(`REPORT 3 ${"long output ".repeat(1000)} REPORT TAIL 3`)
    expect(saved?.lastVerification?.criteria[0]?.evidence).toBe("UNBOUNDED EVIDENCE ".repeat(300))
    expect(saved?.status).toBe("completed")
  }),
)

suite.instance("compaction after a delivered input restores the full objective, criteria and instructions", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const messages: string[] = []
    let seeded = false
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") return planning(input)
        if (input.agent === "verifier") return verification(input, messages.length === 3)
        yield* admit(sessions, input)
        messages.push(
          input.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        )
        if (messages.length === 2) {
          const summary = result(session.id, "Compacted history")
          if (summary.info.role === "assistant") {
            yield* sessions.updateMessage({ ...summary.info, summary: true })
            for (const part of summary.parts) yield* sessions.updatePart(part)
          }
        }
        return result(input.sessionID)
      })
    const respond = (text: string) =>
      Effect.gen(function* () {
        if (!seeded && text.includes("Goal accepted")) {
          seeded = true
          yield* goal.observe(session.id, "Keep the entire scope instruction after compaction")
        }
        return result(session.id, text)
      })
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "specific objective --max-iterations 3" },
      run,
      respond,
      () => Effect.void,
    )
    expect(messages[0]).toContain("specific objective")
    expect(messages[1]).not.toContain("specific objective")
    expect(messages[2]).toContain("specific objective")
    expect(messages[2]).toContain("C1: done")
    expect(messages[2]).toContain("Keep the entire scope instruction after compaction")
    expect((yield* goal.get(session.id))?.status).toBe("completed")
  }),
)

suite.instance("a provider failure does not consume pending instruction delivery", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const messages: string[] = []
    let seeded = false
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") return planning(input)
        if (input.agent === "verifier") return verification(input, messages.length === 2)
        yield* admit(sessions, input)
        messages.push(
          input.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        )
        if (messages.length === 1) return yield* Effect.die(new Error("Provider failed after input admission"))
        return result(input.sessionID)
      })
    const respond = (text: string) =>
      Effect.gen(function* () {
        if (!seeded && text.includes("Goal accepted")) {
          seeded = true
          yield* goal.observe(session.id, "Retain this pending instruction after provider failure")
        }
        return result(session.id, text)
      })
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "failure recovery objective --max-iterations 2" },
      run,
      respond,
      () => Effect.void,
    )
    expect(messages).toHaveLength(2)
    expect(messages[1]).toContain("failure recovery objective")
    expect(messages[1]).toContain("C1: done")
    expect(messages[1]).toContain("Retain this pending instruction after provider failure")
    expect((yield* goal.get(session.id))?.status).toBe("completed")
  }),
)

suite.instance("repeated steering received during execution is delivered in order after the admitted cursor", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const messages: string[] = []
    const checks: string[] = []
    let seeded = false
    const run = (input: PromptInput) =>
      Effect.gen(function* () {
        if (input.agent === "goal-planner") return planning(input)
        const text = input.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        if (input.agent === "verifier") {
          checks.push(text)
          return verification(input, messages.length === 2)
        }
        yield* admit(sessions, input)
        messages.push(text)
        if (messages.length === 1) {
          yield* goal.observe(session.id, "Use Y").pipe(Effect.orDie)
          yield* goal.observe(session.id, "Use X").pipe(Effect.orDie)
        }
        return result(input.sessionID)
      })
    const respond = (text: string) =>
      Effect.gen(function* () {
        if (!seeded && text.includes("Goal accepted")) {
          seeded = true
          yield* goal.observe(session.id, "Use X")
        }
        return result(session.id, text)
      })
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "finish --max-iterations 2" },
      run,
      respond,
      () => Effect.void,
    )
    expect(messages[0]).toContain("- Use X")
    expect(messages[1]).toContain("- Use Y\n- Use X")
    expect(checks[0]).toContain("- Use X\n- Use Y\n- Use X")
    expect((yield* goal.get(session.id))?.instructions).toEqual(["Use X", "Use Y", "Use X"])
    expect((yield* goal.get(session.id))?.status).toBe("completed")
  }),
)
