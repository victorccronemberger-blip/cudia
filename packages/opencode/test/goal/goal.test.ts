import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Goal } from "../../src/goal"
import { Session } from "../../src/session/session"
import { Storage } from "../../src/storage/storage"
import { MessageID, PartID } from "../../src/session/schema"
import type { PromptInput } from "../../src/session/prompt"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const suite = testEffect(
  LayerNode.compile(LayerNode.group([Goal.node, Session.node, SessionProjector.node, Storage.node])),
)

const tokens = {
  input: 10,
  output: 20,
  reasoning: 30,
  cache: { read: 40, write: 50 },
}

function result(
  sessionID: SessionV1.SessionInfo["id"],
  options: {
    id?: MessageID
    parentID?: MessageID
    text?: string
    usage?: typeof tokens
    parts?: SessionV1.Part[]
  } = {},
): SessionV1.WithParts {
  const id = options.id ?? MessageID.ascending()
  const parentID = options.parentID ?? MessageID.ascending()
  return {
    info: {
      id,
      parentID,
      sessionID,
      role: "assistant",
      agent: "build",
      mode: "build",
      modelID: ModelV2.ID.make("selected"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now(), completed: Date.now() },
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: options.usage ?? tokens,
      finish: "stop",
    },
    parts: options.parts ?? [
      { id: PartID.ascending(), messageID: id, sessionID, type: "text", text: options.text ?? "done" },
    ],
  }
}

function start(goal: Goal.Interface, sessionID: SessionV1.SessionInfo["id"], arguments_: string) {
  const calls: PromptInput[] = []
  return Effect.gen(function* () {
    yield* goal.command(
      { sessionID, command: "goal", arguments: arguments_ },
      (input) => {
        calls.push(input)
        return Effect.succeed(result(sessionID))
      },
      (text) => Effect.succeed(result(sessionID, { text })),
      () => Effect.void,
    )
    return calls
  })
}

function updateError(
  goal: Goal.Interface,
  sessionID: SessionV1.SessionInfo["id"],
  token: Goal.Token,
  evidence: string,
) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(goal.update(sessionID, token, { status: "completed", evidence }))
    expect(Exit.isFailure(exit)).toBe(true)
    return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
  })
}

suite.instance("starting a goal creates one durable continuation request without planner or verifier calls", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()

    const calls = yield* start(goal, session.id, "finish the requested work")
    const saved = yield* goal.get(session.id)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.parts.some((part) => part.type === "text" && part.metadata?.goalWake !== undefined)).toBe(true)
    expect(saved).toMatchObject({
      objective: "finish the requested work",
      status: "active",
      runtime: 2,
      iteration: 0,
      tokensUsed: 0,
    })
  }),
)
suite.instance("an unbounded goal remains active beyond the former default of fifty turns", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "finish without an iteration limit")

    for (let index = 0; index < 51; index++) {
      const parentID = MessageID.ascending()
      expect(yield* goal.begin(session.id, parentID)).toBe(true)
    }

    const state = yield* goal.get(session.id)
    expect(state?.status).toBe("active")
    expect(state?.iteration).toBe(51)
    expect(state?.maxIterations).toBeUndefined()
  }),
)

suite.instance("an explicit turn budget stops as budget_limited instead of reporting a blocker", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "finish within one turn --max-iterations 1")
    expect(yield* goal.begin(session.id, MessageID.ascending())).toBe(true)
    expect(yield* goal.begin(session.id, MessageID.ascending())).toBe(true)
    expect(yield* goal.get(session.id)).toMatchObject({ status: "budget_limited", iteration: 1 })
  }),
)

suite.instance("assistant usage includes cache and reasoning tokens and is accounted only once", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "account all provider tokens")
    const parentID = MessageID.ascending()
    yield* goal.begin(session.id, parentID)
    const assistant = result(session.id, { parentID })

    yield* goal.account(session.id, assistant)
    yield* goal.account(session.id, assistant)

    expect(yield* goal.get(session.id)).toMatchObject({ tokensUsed: 150 })
  }),
)

suite.instance("multi-step usage sums step-finish parts without recounting aggregate or last-step tokens", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "account provider steps once")
    const parentID = MessageID.ascending()
    yield* goal.begin(session.id, parentID)
    const assistantID = MessageID.ascending()
    const step = (usage: typeof tokens): SessionV1.Part => ({
      id: PartID.ascending(),
      messageID: assistantID,
      sessionID: session.id,
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { ...usage },
    })
    const assistant = result(session.id, {
      id: assistantID,
      parentID,
      usage: { input: 500, output: 600, reasoning: 700, cache: { read: 800, write: 900 } },
      parts: [
        step({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }),
        step({ input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } }),
      ],
    })

    yield* goal.account(session.id, assistant)
    yield* goal.account(session.id, assistant)

    expect((yield* goal.get(session.id))?.tokensUsed).toBe(165)
  }),
)

suite.instance("automatic continuation blocks after three no-work turns", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "wait for actual work")
    const parentID = MessageID.ascending()
    yield* goal.begin(session.id, parentID)
    const assistant = result(session.id, { parentID })

    yield* goal.account(session.id, assistant)
    let next = yield* goal.continuation(session.id, assistant, true)
    expect(next).toBeDefined()
    expect((yield* goal.get(session.id))?.noWorkTurns).toBe(1)
    for (let turn = 2; turn <= 3; turn++) {
      const parent = MessageID.ascending()
      expect(yield* goal.begin(session.id, parent, next)).toBe(true)
      const reply = result(session.id, { parentID: parent })
      yield* goal.account(session.id, reply)
      next = yield* goal.continuation(session.id, reply, true)
      expect(next === undefined).toBe(turn === 3)
    }
    expect(yield* goal.get(session.id)).toMatchObject({
      status: "blocked",
      noWorkTurns: 3,
      stopReason: "Stopped: three consecutive automatic turns made no work tool call. Resume or send new input.",
    })
  }),
)

suite.instance("a get_goal-only assistant turn does not count as work for automatic continuation", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "make progress")
    const parentID = MessageID.ascending()
    yield* goal.begin(session.id, parentID)
    const assistantID = MessageID.ascending()
    const assistant = result(session.id, {
      id: assistantID,
      parentID,
      parts: [
        {
          id: PartID.ascending(),
          messageID: assistantID,
          sessionID: session.id,
          type: "tool",
          callID: "get-goal",
          tool: "get_goal",
          state: {
            status: "completed",
            input: {},
            output: "Goal state",
            title: "Read goal",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        },
      ],
    })

    yield* goal.account(session.id, assistant)
    expect(yield* goal.continuation(session.id, assistant, true)).toBeDefined()
    expect(yield* goal.get(session.id)).toMatchObject({ status: "active", noWorkTurns: 1 })
  }),
)

suite.instance("concurrent automatic continuation claims schedule one follow-up only", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "schedule a follow-up once")
    const parentID = MessageID.ascending()
    yield* goal.begin(session.id, parentID)
    expect((yield* goal.get(session.id))?.parentID).toBe(parentID)
    const assistantID = MessageID.ascending()
    const assistant = result(session.id, {
      id: assistantID,
      parentID,
      parts: [
        {
          id: PartID.ascending(),
          messageID: assistantID,
          sessionID: session.id,
          type: "tool",
          callID: "read-work",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "source.ts" },
            output: "Inspected source",
            title: "Read source",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        },
      ],
    })
    if (assistant.info.role !== "assistant") throw new Error("Expected an assistant result")
    expect(assistant.info.parentID).toBe(parentID)
    expect(assistant.parts.some((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
    yield* goal.account(session.id, assistant)
    expect((yield* goal.get(session.id))?.tokensUsed).toBe(150)
    expect((yield* goal.get(session.id))?.workParentID).toBe(parentID)

    const claims = yield* Effect.all(
      [goal.continuation(session.id, assistant, true), goal.continuation(session.id, assistant, true)],
      { concurrency: "unbounded" },
    )

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
    expect(claims.filter((claim) => claim === undefined)).toHaveLength(1)
  }),
)

suite.instance("simultaneous goal starts launch only the winning goal", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const starts: string[] = []
    const command = (objective: string) =>
      goal.command(
        { sessionID: session.id, command: "goal", arguments: objective },
        () => {
          starts.push(objective)
          return Effect.succeed(result(session.id))
        },
        (text) => Effect.succeed(result(session.id, { text })),
        () => Effect.void,
      )

    yield* Effect.all([command("first objective"), command("second objective")], { concurrency: "unbounded" })

    const saved = yield* goal.get(session.id)
    expect(starts).toHaveLength(1)
    if (!saved) throw new Error("Expected the winning goal to be saved")
    expect(["first objective", "second objective"]).toContain(saved.objective)
    expect(saved?.status).toBe("active")
  }),
)

suite.instance("resume waits for the paused goal's stop callback before restarting", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "preserve the paused goal")
    const stopStarted = yield* Deferred.make<void>()
    const releaseStop = yield* Deferred.make<void>()
    const resumeAttempted = yield* Deferred.make<void>()
    const resumeRan = yield* Deferred.make<void>()
    const events: string[] = []
    const stop = () =>
      Effect.gen(function* () {
        events.push("stopstart")
        yield* Deferred.succeed(stopStarted, undefined)
        yield* Deferred.await(releaseStop)
        events.push("stopend")
      })
    const respond = (text: string) => Effect.succeed(result(session.id, { text }))
    const run = () =>
      Effect.gen(function* () {
        events.push("resumerun")
        yield* Deferred.succeed(resumeRan, undefined)
        return result(session.id, { text: "resumed" })
      })

    const pause = yield* goal
      .command({ sessionID: session.id, command: "goal", arguments: "pause" }, run, respond, stop)
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(stopStarted), "pause did not enter its stop callback")

    const resume = yield* Effect.gen(function* () {
      yield* Deferred.succeed(resumeAttempted, undefined)
      yield* Effect.yieldNow
      return yield* goal.command({ sessionID: session.id, command: "goal", arguments: "resume" }, run, respond, stop)
    }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(resumeAttempted), "resume command was not launched")
    yield* Effect.yieldNow
    expect(yield* Deferred.isDone(resumeRan)).toBe(false)
    expect(events).toEqual(["stopstart"])

    yield* Deferred.succeed(releaseStop, undefined)
    yield* awaitWithTimeout(Fiber.join(pause), "pause command did not return")
    yield* awaitWithTimeout(Fiber.join(resume), "resume command did not return")

    expect(events).toEqual(["stopstart", "stopend", "resumerun"])
    expect((yield* goal.get(session.id))?.status).toBe("active")
  }),
)

suite.instance("clear waits for its stop callback before allowing a new goal to start", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "goal that will be cleared")
    const stopStarted = yield* Deferred.make<void>()
    const releaseStop = yield* Deferred.make<void>()
    const startAttempted = yield* Deferred.make<void>()
    const newGoalRan = yield* Deferred.make<void>()
    const events: string[] = []
    const stop = () =>
      Effect.gen(function* () {
        events.push("stopstart")
        yield* Deferred.succeed(stopStarted, undefined)
        yield* Deferred.await(releaseStop)
        events.push("stopend")
      })
    const respond = (text: string) => Effect.succeed(result(session.id, { text }))

    const clear = yield* goal
      .command(
        { sessionID: session.id, command: "goal", arguments: "clear" },
        () => Effect.succeed(result(session.id)),
        respond,
        stop,
      )
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(stopStarted), "clear did not enter its stop callback")

    const create = yield* Effect.gen(function* () {
      yield* Deferred.succeed(startAttempted, undefined)
      yield* Effect.yieldNow
      return yield* goal.command(
        { sessionID: session.id, command: "goal", arguments: "new goal after clear" },
        () =>
          Effect.gen(function* () {
            events.push("newrun")
            yield* Deferred.succeed(newGoalRan, undefined)
            return result(session.id)
          }),
        respond,
        stop,
      )
    }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(startAttempted), "new goal command was not launched")
    yield* Effect.yieldNow
    expect(yield* Deferred.isDone(newGoalRan)).toBe(false)
    expect(events).toEqual(["stopstart"])

    yield* Deferred.succeed(releaseStop, undefined)
    yield* awaitWithTimeout(Fiber.join(clear), "clear command did not return")
    yield* awaitWithTimeout(Fiber.join(create), "new goal command did not return")

    expect(events).toEqual(["stopstart", "stopend", "newrun"])
    expect(yield* goal.get(session.id)).toMatchObject({ objective: "new goal after clear", status: "active" })
  }),
)

suite.instance("get_goal alone does not change work accounting", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "inspect current state")
    const before = yield* goal.get(session.id)

    const read = yield* goal.get(session.id)

    expect(read?.tokensUsed).toBe(before?.tokensUsed)
    expect(read?.iteration).toBe(before?.iteration)
    expect(read?.status).toBe(before?.status)
  }),
)

suite.instance("pause, cancel, resume, and clear are explicit lifecycle controls", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "keep this durable goal")
    const stop = () => Effect.void
    const respond = (text: string) => Effect.succeed(result(session.id, { text }))
    const run = (input: PromptInput) => Effect.succeed(result(session.id, { text: "wake" }))

    yield* goal.command({ sessionID: session.id, command: "goal", arguments: "pause" }, run, respond, stop)
    expect((yield* goal.get(session.id))?.status).toBe("paused")
    yield* goal.command({ sessionID: session.id, command: "goal", arguments: "resume" }, run, respond, stop)
    expect((yield* goal.get(session.id))?.status).toBe("active")
    yield* goal.command({ sessionID: session.id, command: "goal", arguments: "cancel" }, run, respond, stop)
    expect((yield* goal.get(session.id))?.status).toBe("cancelled")
    yield* goal.command({ sessionID: session.id, command: "goal", arguments: "clear" }, run, respond, stop)
    expect(yield* goal.get(session.id)).toBeUndefined()
  }),
)

suite.instance("a replaced goal and a steered goal reject stale completion tokens", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const first = yield* sessions.create()
    yield* start(goal, first.id, "original objective")
    const stale = Goal.token((yield* goal.get(first.id))!)
    yield* start(goal, first.id, "replace updated objective")
    expect(yield* updateError(goal, first.id, stale, "The original objective was checked.")).toContain("goal changed")

    const second = yield* sessions.create()
    yield* start(goal, second.id, "objective before steering")
    const beforeSteering = Goal.token((yield* goal.get(second.id))!)
    yield* goal.observe(second.id, "Keep the user update in scope")
    expect(yield* updateError(goal, second.id, beforeSteering, "The old objective was checked.")).toContain(
      "goal changed",
    )
  }),
)

suite.instance("a paused goal is not silently replaced by starting another objective", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const calls = yield* start(goal, session.id, "first objective")
    yield* goal.pause(session.id)
    const before = yield* goal.get(session.id)

    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "second objective" },
      (input) => {
        calls.push(input)
        return Effect.succeed(result(session.id))
      },
      (text) => Effect.succeed(result(session.id, { text })),
      () => Effect.void,
    )

    expect(calls).toHaveLength(1)
    expect(yield* goal.get(session.id)).toMatchObject({
      id: before?.id,
      objective: "first objective",
      status: "paused",
    })
  }),
)

suite.instance("legacy default fifty is removed when the goal is resumed", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const session = yield* sessions.create()
    yield* storage.write(["goal", session.id], {
      id: "legacy-goal",
      sessionID: session.id,
      objective: "legacy objective",
      status: "blocked",
      iteration: 9,
      maxIterations: 50,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      completionCriteria: ["complete"],
      plan: [],
      observations: [],
      failures: [],
      recentHashes: [],
      replanned: false,
    })

    yield* start(goal, session.id, "resume")

    const resumed = yield* goal.get(session.id)
    expect(resumed).toMatchObject({ runtime: 2, status: "active", iteration: 9 })
    expect(resumed?.maxIterations).toBeUndefined()
  }),
)

suite.instance("completion requires evidence but does not require a particular tool call", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "complete based on evidence")
    const token = Goal.token((yield* goal.get(session.id))!)

    const missing = yield* updateError(goal, session.id, token, "")
    expect(missing).toContain("Report the evidence checked")
    const completed = yield* goal.update(session.id, token, {
      status: "completed",
      evidence: "The requested behavior is present in the inspected source and output.",
    })
    expect(completed.status).toBe("completed")
    expect(completed.evidence).toContain("inspected source")
  }),
)


suite.instance("blocked requires reports in three distinct consecutive goal turns", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "resolve a dependency")
    for (let turn = 1; turn <= 3; turn++) {
      const parent = MessageID.ascending()
      yield* goal.begin(session.id, parent)
      const current = (yield* goal.get(session.id))!
      const updated = yield* goal.update(session.id, Goal.token(current), { status: "blocked", evidence: "same external dependency" })
      expect(updated).toMatchObject({ status: turn === 3 ? "blocked" : "active", blockerTurns: turn })
      if (turn === 1) {
        const repeated = yield* goal.update(session.id, Goal.token(updated), { status: "blocked", evidence: "same external dependency" })
        expect(repeated).toMatchObject({ status: "active", blockerTurns: 1 })
      }
    }
  }),
)

suite.instance("a turn without a blocker report breaks the consecutive streak", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "resolve dependency")
    yield* goal.begin(session.id, MessageID.ascending())
    yield* goal.update(session.id, Goal.token((yield* goal.get(session.id))!), { status: "blocked", evidence: "dependency" })
    yield* goal.begin(session.id, MessageID.ascending())
    yield* goal.begin(session.id, MessageID.ascending())
    const updated = yield* goal.update(session.id, Goal.token((yield* goal.get(session.id))!), { status: "blocked", evidence: "dependency" })
    expect(updated).toMatchObject({ status: "active", blockerTurns: 1 })
  }),
)


suite.instance("work resets no-work recovery and resume resets both counters", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "make progress")
    const first = MessageID.ascending()
    yield* goal.begin(session.id, first)
    const idle = result(session.id, { parentID: first })
    yield* goal.account(session.id, idle)
    const next = yield* goal.continuation(session.id, idle, true)
    const parent = MessageID.ascending()
    yield* goal.begin(session.id, parent, next)
    const id = MessageID.ascending()
    const work = result(session.id, { id, parentID: parent, parts: [{
      id: PartID.ascending(), messageID: id, sessionID: session.id, type: "tool", callID: "read",
      tool: "read", state: { status: "completed", input: {}, output: "read", title: "Read", metadata: {}, time: { start: Date.now(), end: Date.now() } },
    }] })
    yield* goal.account(session.id, work)
    yield* goal.continuation(session.id, work, true)
    expect((yield* goal.get(session.id))?.noWorkTurns).toBe(0)
    yield* goal.update(session.id, Goal.token((yield* goal.get(session.id))!), { status: "blocked", evidence: "dependency" })
    yield* goal.pause(session.id)
    yield* start(goal, session.id, "resume")
    expect(yield* goal.get(session.id)).toMatchObject({ status: "active", blockerTurns: 0, noWorkTurns: 0 })
  }),
)

suite.instance("content-filter responses do not trigger automatic recovery", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* start(goal, session.id, "work")
    const parent = MessageID.ascending()
    yield* goal.begin(session.id, parent)
    const filtered = result(session.id, { parentID: parent })
    if (filtered.info.role !== "assistant") throw new Error("Expected assistant")
    filtered.info.finish = "content-filter"
    expect(yield* goal.continuation(session.id, filtered, true)).toBeUndefined()
    expect((yield* goal.get(session.id))?.noWorkTurns).toBeUndefined()
  }),
)
