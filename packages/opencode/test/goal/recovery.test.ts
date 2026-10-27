import { expect } from "bun:test"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Goal } from "@/goal"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const suite = testEffect(LayerNode.compile(LayerNode.group([Goal.node, Session.node, Storage.node])))
const marker = "SYNTHETIC_GOAL_CONTENT_NOT_FOR_ERROR_MESSAGES"

function state(sessionID: SessionID, status = "paused") {
  return {
    id: "goal-recovery-fixture",
    sessionID,
    objective: marker,
    status,
    iteration: 1,
    maxIterations: 50,
    startedAt: 1,
    updatedAt: 2,
    completionCriteria: ["preserve saved work"],
    plan: [{ id: "step", description: "continue", status: "pending", attempts: 1 }],
    observations: [],
    failures: [],
    recentHashes: [],
    replanned: false,
    extension: { futureField: ["preserve", 42] },
  }
}

function storedPath(sessionID: SessionID) {
  return path.join(Global.Path.data, "storage", "goal", sessionID + ".json")
}

suite.instance("missing goal state remains absent without changing status or resume behavior", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const sessionID = SessionID.create()
    const replies: string[] = []
    expect(yield* goal.get(sessionID)).toBeUndefined()
    for (const command of ["status", "resume"]) {
      yield* goal.command(
        { sessionID, command: "goal", arguments: command },
        () => Effect.die("provider must not run"),
        (text) => {
          replies.push(text)
          const id = MessageID.ascending()
          return Effect.succeed({
            info: {
              id,
              sessionID,
              role: "user",
              agent: "build",
              time: { created: 0 },
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("selected") },
            },
            parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
          })
        },
        () => Effect.die("stop must not run"),
      )
    }
    expect(replies).toEqual(["No active goal for this session.", "No unfinished goal is available to resume."])
    expect(yield* Effect.promise(() => Bun.file(storedPath(sessionID)).exists())).toBe(false)
  }),
)

suite.instance("historical optional fields, statuses, and unknown fields round-trip without writes", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const storage = yield* Storage.Service
    const sessionID = SessionID.create()
    for (const status of ["active", "completed", "blocked", "paused", "cancelled", "failed"]) {
      const saved = state(sessionID, status)
      yield* storage.write(["goal", sessionID], saved)
      const before = yield* Effect.promise(() => Bun.file(storedPath(sessionID)).text())
      expect(JSON.stringify(yield* goal.get(sessionID))).toBe(JSON.stringify(saved))
      expect(yield* Effect.promise(() => Bun.file(storedPath(sessionID)).text())).toBe(before)
    }
    const full = {
      ...state(sessionID),
      instructions: ["User steering"],
      variant: "thinking",
      model: { providerID: "test", modelID: "selected" },
      currentStep: "step",
      latestEvidence: { iteration: 1, text: "observed", messageID: MessageID.ascending() },
      lastVerification: {
        completed: false,
        blocked: false,
        criteria: [{ criterion: "preserve saved work", passed: false, evidence: "pending" }],
        remainingWork: ["continue"],
        recommendedNextAction: "continue",
      },
    }
    yield* storage.write(["goal", sessionID], full)
    const before = yield* Effect.promise(() => Bun.file(storedPath(sessionID)).text())
    expect(JSON.stringify(yield* goal.get(sessionID))).toBe(JSON.stringify(full))
    expect(yield* Effect.promise(() => Bun.file(storedPath(sessionID)).text())).toBe(before)
  }),
)

for (const kind of ["invalid_json", "invalid_state", "null_state", "session_mismatch"] as const) {
  suite.instance(`${kind} is visible and cannot silently replace saved goal data`, () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create()
      const saved =
        kind === "session_mismatch"
          ? state(SessionID.create())
          : kind === "invalid_state"
            ? { ...state(session.id), plan: null }
            : kind === "null_state"
              ? null
              : state(session.id)
      yield* storage.write(["goal", session.id], saved)
      if (kind === "invalid_json")
        yield* Effect.promise(() => Bun.write(storedPath(session.id), `{ "objective": "${marker}",`))
      const before = yield* Effect.promise(() => Bun.file(storedPath(session.id)).text())
      const calls: string[] = []
      const actions = [
        goal.get(session.id).pipe(Effect.asVoid),
        ...["status", "resume", "pause", "cancel", "new replace this goal", "another objective"].map((command) =>
          goal
            .command(
              { sessionID: session.id, command: "goal", arguments: command },
              () => {
                calls.push("provider")
                return Effect.die("unexpected provider")
              },
              () => {
                calls.push("reply")
                return Effect.die("unexpected reply")
              },
              () => {
                calls.push("stop")
                return Effect.void
              },
            )
            .pipe(Effect.asVoid),
        ),
        goal.observe(session.id, "User update"),
        goal.pause(session.id),
        goal.cancel(session.id),
      ]
      for (const action of actions) {
        const exit = yield* action.pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          if (kind === "invalid_json") expect(error).toBeInstanceOf(FSUtil.FileSystemError)
          else {
            expect(error).toBeInstanceOf(Goal.StateError)
            expect(error).toMatchObject({
              sessionID: session.id,
              reason: kind === "session_mismatch" ? kind : "invalid_state",
            })
            expect(JSON.stringify(error)).not.toContain(marker)
          }
        }
        expect(yield* Effect.promise(() => Bun.file(storedPath(session.id)).text())).toBe(before)
      }
      expect(calls).toEqual([])
    }),
  )
}

const ioError = new FSUtil.FileSystemError({ method: "readJson", cause: new Error("synthetic I/O error") })
const defect = new Error("synthetic storage defect")
for (const [name, read] of [
  ["storage I/O failure", Effect.fail(ioError)],
  ["storage defect", Effect.die(defect)],
] as const) {
  const faults = testEffect(
    LayerNode.compile(Goal.node, [[Storage.node, Layer.mock(Storage.Service, { read: () => read })]]),
  )
  faults.instance(`${name} preserves its original cause and cannot start a provider`, () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const sessionID = SessionID.create()
      const calls: string[] = []
      for (const action of [
        goal.get(sessionID).pipe(Effect.asVoid),
        ...["status", "resume", "new replacement"].map((command) =>
          goal
            .command(
              { sessionID, command: "goal", arguments: command },
              () => {
                calls.push("provider")
                return Effect.die("unexpected provider")
              },
              () => {
                calls.push("reply")
                return Effect.die("unexpected reply")
              },
              () => Effect.void,
            )
            .pipe(Effect.asVoid),
        ),
      ]) {
        const exit = yield* action.pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(name === "storage defect" ? defect : ioError)
      }
      expect(calls).toEqual([])
    }),
  )
}

const readEntered = Deferred.makeUnsafe<void>()
const interrupted = testEffect(
  LayerNode.compile(Goal.node, [
    [
      Storage.node,
      Layer.mock(Storage.Service, {
        read: () => Deferred.succeed(readEntered, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    ],
  ]),
)
interrupted.instance("interrupting a pending goal read stays an interruption", () =>
  Effect.gen(function* () {
    const goal = yield* Goal.Service
    const fiber = yield* goal.get(SessionID.create()).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(readEntered), "storage read did not start", "5 seconds")
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)
