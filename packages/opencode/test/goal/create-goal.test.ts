import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Goal } from "../../src/goal"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { Storage } from "../../src/storage/storage"
import { testEffect } from "../lib/effect"

const suite = testEffect(
  LayerNode.compile(LayerNode.group([Goal.node, Session.node, SessionProjector.node, Storage.node])),
)

const tokens = {
  input: 10,
  output: 20,
  reasoning: 30,
  cache: { read: 40, write: 50 },
}

function assistant(
  sessionID: SessionV1.SessionInfo["id"],
  parentID: MessageID,
  parts: SessionV1.Part[] = [],
): SessionV1.WithParts {
  const id = MessageID.ascending()
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
      tokens,
      finish: "stop",
    },
    parts,
  }
}

function rejected<A>(effect: Effect.Effect<A, unknown>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  })
}

suite.instance("creating a goal records a durable first iteration bound to the current user message", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const parentID = MessageID.ascending()
    const revision = goal.creationRevision(session.id)

    const created = yield* goal.create(
      session.id,
      parentID,
      { objective: "  finish the requested work  ", maxIterations: 4, tokenBudget: 900 },
      revision,
    )

    expect(created).toMatchObject({
      sessionID: session.id,
      objective: "  finish the requested work  ",
      status: "active",
      runtime: 2,
      iteration: 1,
      parentID,
      maxIterations: 4,
      tokenBudget: 900,
      tokensUsed: 0,
    })
    expect(yield* goal.get(session.id)).toEqual(created)
  }),
)

suite.instance("a created goal accounts its first assistant work and can continue", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const parentID = MessageID.ascending()
    yield* goal.create(session.id, parentID, { objective: "make a real change" }, goal.creationRevision(session.id))
    const assistantID = MessageID.ascending()
    const work = assistant(session.id, parentID, [
      {
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: session.id,
        type: "tool",
        callID: "read-source",
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
    ])
    work.info.id = assistantID

    yield* goal.account(session.id, work)
    const next = yield* goal.continuation(session.id, work, true)

    expect(next).toBeDefined()
    expect(yield* goal.begin(session.id, MessageID.ascending(), next)).toBe(true)
    expect(yield* goal.get(session.id)).toMatchObject({ status: "active", iteration: 2, tokensUsed: 150 })
  }),
)

suite.instance("a create_goal-only turn does not count as work for automatic continuation", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const parentID = MessageID.ascending()
    yield* goal.create(session.id, parentID, { objective: "continue real work" }, goal.creationRevision(session.id))
    const assistantID = MessageID.ascending()
    const message = assistant(session.id, parentID, [
      {
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: session.id,
        type: "tool",
        callID: "create-child-goal",
        tool: "create_goal",
        state: {
          status: "completed",
          input: { objective: "a separate requested goal" },
          output: "Goal created",
          title: "Create goal",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      },
    ])
    message.info.id = assistantID

    yield* goal.account(session.id, message)

    expect((yield* goal.get(session.id))?.workParentID).toBeUndefined()
    expect(yield* goal.continuation(session.id, message, true)).toBeUndefined()
    expect(yield* goal.get(session.id)).toMatchObject({
      status: "active",
      stopReason: "Waiting: automatic turn made no work tool call. Resume or send new input.",
    })
  }),
)

suite.instance("a deferred completed tool does not count as work for automatic continuation", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const parentID = MessageID.ascending()
    yield* goal.create(session.id, parentID, { objective: "continue actual work" }, goal.creationRevision(session.id))
    const assistantID = MessageID.ascending()
    const deferred = assistant(session.id, parentID, [
      {
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: session.id,
        type: "tool",
        callID: "deferred-read",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "source.ts" },
          output: "Aguardando consultor",
          title: "Aguardando consultor",
          metadata: { deferredByConsultation: true },
          time: { start: Date.now(), end: Date.now() },
        },
      },
    ])
    deferred.info.id = assistantID

    yield* goal.account(session.id, deferred)

    expect((yield* goal.get(session.id))?.workParentID).toBeUndefined()
    expect(yield* goal.continuation(session.id, deferred, true)).toBeUndefined()
    expect(yield* goal.get(session.id)).toMatchObject({
      status: "active",
      stopReason: "Waiting: automatic turn made no work tool call. Resume or send new input.",
    })
  }),
)

suite.instance("completion can be reported immediately with a token from the created state", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const created = yield* goal.create(
      session.id,
      MessageID.ascending(),
      { objective: "verify and finish" },
      goal.creationRevision(session.id),
    )

    const completed = yield* goal.update(session.id, Goal.token(created), {
      status: "completed",
      evidence: "The requested result is present and verified.",
    })

    expect(completed).toMatchObject({ objective: "verify and finish", status: "completed" })
  }),
)

suite.instance("simultaneous creates at one revision persist only one new goal", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const revision = goal.creationRevision(session.id)
    const create = (objective: string) =>
      Effect.exit(goal.create(session.id, MessageID.ascending(), { objective }, revision))

    const exits = yield* Effect.all([create("first competing objective"), create("second competing objective")], {
      concurrency: "unbounded",
    })
    const successes = exits.filter(Exit.isSuccess)
    const persisted = (yield* goal.get(session.id))!

    expect(successes).toHaveLength(1)
    expect(["first competing objective", "second competing objective"]).toContain(persisted.objective)
  }),
)

suite.instance("a stale creation revision is rejected after pause or user steering", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const paused = yield* sessions.create()
    const beforePause = goal.creationRevision(paused.id)
    yield* goal.create(paused.id, MessageID.ascending(), { objective: "keep the paused work" }, beforePause)
    yield* goal.pause(paused.id)
    const pauseError = yield* rejected(
      goal.create(paused.id, MessageID.ascending(), { objective: "replace paused work" }, beforePause),
    )

    const steered = yield* sessions.create()
    const beforeSteering = goal.creationRevision(steered.id)
    yield* goal.create(steered.id, MessageID.ascending(), { objective: "preserve the user objective" }, beforeSteering)
    yield* goal.observe(steered.id, "Keep this new user direction in scope")
    const steeringError = yield* rejected(
      goal.create(steered.id, MessageID.ascending(), { objective: "stale objective" }, beforeSteering),
    )

    expect(pauseError).toBeInstanceOf(Goal.StateError)
    expect(pauseError).toMatchObject({ reason: "stale_update" })
    expect(steeringError).toBeInstanceOf(Goal.StateError)
    expect(steeringError).toMatchObject({ reason: "stale_update" })
    expect(yield* goal.get(paused.id)).toMatchObject({ objective: "keep the paused work", status: "paused" })
    expect(yield* goal.get(steered.id)).toMatchObject({ objective: "preserve the user objective", status: "active" })
  }),
)

suite.instance("clearing a goal invalidates its prior creation revision even when no goal remains", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const revision = goal.creationRevision(session.id)
    yield* goal.create(session.id, MessageID.ascending(), { objective: "clear this goal" }, revision)
    yield* goal.command(
      { sessionID: session.id, command: "goal", arguments: "clear" },
      () => Effect.die("clear must not start a prompt"),
      () => Effect.succeed(assistant(session.id, MessageID.ascending())),
      () => Effect.void,
    )

    expect(yield* goal.get(session.id)).toBeUndefined()
    const staleError = yield* rejected(
      goal.create(session.id, MessageID.ascending(), { objective: "stale after clear" }, revision),
    )
    expect(staleError).toBeInstanceOf(Goal.StateError)
    expect(staleError).toMatchObject({ reason: "stale_update" })
  }),
)

suite.instance("unfinished goals are preserved and completed goals may be replaced", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    yield* goal.create(
      session.id,
      MessageID.ascending(),
      { objective: "first objective" },
      goal.creationRevision(session.id),
    )
    const revision = goal.creationRevision(session.id)
    const error = yield* rejected(
      goal.create(session.id, MessageID.ascending(), { objective: "must not replace active work" }, revision),
    )

    expect(error).toBeInstanceOf(Goal.StateError)
    expect(error).toMatchObject({ reason: "goal_exists" })
    expect(yield* goal.get(session.id)).toMatchObject({ objective: "first objective", status: "active" })

    const current = (yield* goal.get(session.id))!
    yield* goal.update(session.id, Goal.token(current), {
      status: "completed",
      evidence: "The first objective was verified.",
    })
    const replacement = yield* goal.create(
      session.id,
      MessageID.ascending(),
      { objective: "replacement after completion" },
      goal.creationRevision(session.id),
    )
    expect(replacement).toMatchObject({ objective: "replacement after completion", status: "active", iteration: 1 })
  }),
)

suite.instance("creation validates a nonempty objective and positive safe integer limits", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const invalid = [
      { objective: "  " },
      { objective: "missing limit", maxIterations: 0 },
      { objective: "fractional limit", maxIterations: 1.5 },
      { objective: "unsafe limit", maxIterations: Number.MAX_SAFE_INTEGER + 1 },
      { objective: "zero token budget", tokenBudget: 0 },
      { objective: "negative token budget", tokenBudget: -1 },
      { objective: "fractional token budget", tokenBudget: 2.5 },
    ]

    for (const input of invalid) {
      const error = yield* rejected(
        goal.create(session.id, MessageID.ascending(), input, goal.creationRevision(session.id)),
      )
      expect(error).toBeInstanceOf(Goal.StateError)
      expect(error).toMatchObject({ reason: "invalid_goal" })
      expect(yield* goal.get(session.id)).toBeUndefined()
    }
  }),
)
