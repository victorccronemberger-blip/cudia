import { afterAll, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Duo } from "@/duo"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const config = mkdtempSync(path.join(tmpdir(), "cudia-duo-test-"))
writeFileSync(
  path.join(config, "duo.json"),
  JSON.stringify({
    participants: [
      { name: "Drael", model: "drael/drael-v1", variant: "high", agent: "general" },
      { name: "GPT", model: "openai/gpt-6-luna", variant: "high", agent: "general" },
    ],
    review: true,
    peerChars: 12,
  }),
)
afterAll(() => rmSync(config, { recursive: true, force: true }))

const records = new Map<string, unknown>()
const memory = Layer.mock(Storage.Service, {
  read: <T>(key: string[]) => {
    const value = records.get(key.join("/"))
    return value === undefined
      ? Effect.fail(new Storage.NotFoundError({ message: "missing" }))
      : Effect.succeed(value as T)
  },
  write: (key: string[], value: unknown) => Effect.sync(() => void records.set(key.join("/"), structuredClone(value))),
  update: <T>(key: string[], fn: (draft: T) => void) => {
    const value = records.get(key.join("/")) as T
    fn(value)
    records.set(key.join("/"), value)
    return Effect.succeed(value)
  },
  remove: (key: string[]) => Effect.sync(() => void records.delete(key.join("/"))),
  list: () => Effect.succeed([]),
})
const suite = testEffect(
  LayerNode.compile(Duo.node, [
    [Global.node, Global.layerWith({ config })],
    [Storage.node, memory],
  ]),
)

const members: [Duo.Participant & { directory: string }, Duo.Participant & { directory: string }] = [
  { name: "Drael", model: "drael/drael-v1", variant: "high", agent: "general", directory: "C:/work/a" },
  { name: "GPT", model: "openai/gpt-6-luna", variant: "high", agent: "general", directory: "C:/work/b" },
] as const

describe("duo service", () => {
  suite.instance("cancel persists for interrupted and completed runs until explicit resume", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const sessionID = SessionID.create()
      const entered = yield* Deferred.make<void>()
      const fiber = yield* duo
        .start({ sessionID, objective: "objective", members, schedule: "parallel", review: false, peerChars: 12 }, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect((yield* duo.cancel(sessionID))?.status).toBe("cancelled")
      yield* Fiber.interrupt(fiber)
      expect((yield* duo.get(sessionID))?.status).toBe("cancelled")
      const resumed = yield* duo.resume({ sessionID }, () =>
        Effect.succeed({ status: "completed" as const, output: "result" }),
      )
      expect(resumed.status).toBe("completed")
      const cancelled = yield* duo.cancel(sessionID)
      expect(cancelled?.status).toBe("cancelled")
      expect(cancelled?.members[0].work?.output).toBe("result")
    }),
  )

  suite.instance("loads explicit participant settings and get never starts work", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const settings = yield* duo.settings()
      expect(settings.participants.map((item) => item.model)).toEqual(["drael/drael-v1", "openai/gpt-6-luna"])
      expect(settings.review).toBe(true)
      expect(settings.peerChars).toBe(12)
      expect(yield* duo.get(SessionID.create())).toBeUndefined()
    }),
  )

  suite.instance("runs both work calls concurrently with one identical objective, then clips peer review context", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const sessionID = SessionID.create()
      const bothStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started: number[] = []
      const requests: Duo.Invocation[] = []
      const fiber = yield* duo
        .start(
          {
            sessionID,
            objective: "Build the same feature in both workspaces.",
            members,
            schedule: "parallel",
            review: true,
            peerChars: 12,
          },
          (request) =>
            Effect.gen(function* () {
              requests.push(request)
              if (request.phase === "work") {
                started.push(request.index)
                if (started.length === 2) yield* Deferred.succeed(bothStarted, undefined)
                yield* Deferred.await(release)
                const id = SessionID.create()
                yield* request.onAllocated(id)
                return {
                  taskID: id,
                  status: "completed" as const,
                  output: "0123456789ABCDEFGHIJ",
                }
              }
              return { status: "completed" as const, output: `reviewed:${request.prompt}` }
            }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(bothStarted)
      expect(started.sort()).toEqual([0, 1])
      expect(requests[0]?.prompt).toContain("Build the same feature in both workspaces.")
      expect(requests[1]?.prompt).toContain("Build the same feature in both workspaces.")
      expect(requests[0]?.prompt).toBe(requests[1]?.prompt)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.status).toBe("completed")
      const reviews = requests.filter((request) => request.phase === "review")
      expect(reviews).toHaveLength(2)
      expect(reviews.some((request) => request.prompt.includes("0123456789A"))).toBe(true)
      expect(reviews.some((request) => request.prompt.includes("0123456789ABCDEFGHIJ"))).toBe(false)
      expect((yield* duo.get(sessionID))?.members.every((member) => member.taskID !== undefined)).toBe(true)
    }),
  )

  suite.instance("one failed member does not cancel the peer or prevent the peer review", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const sessionID = SessionID.create()
      const calls: Duo.Invocation[] = []
      const result = yield* duo.start(
        {
          sessionID,
          objective: "Implement and verify the requested change.",
          members,
          schedule: "parallel",
          review: true,
          peerChars: 100,
        },
        (request) => {
          calls.push(request)
          if (request.phase === "work" && request.index === 0) return Effect.fail(new Error("transport failed"))
          return Effect.succeed({ status: "completed" as const, output: "peer implemented and verified" })
        },
      )
      expect(result.status).toBe("completed")
      expect(result.members[0].work).toMatchObject({ status: "failed" })
      expect(result.members[1].work).toMatchObject({ status: "completed" })
      expect(calls.filter((request) => request.phase === "review").map((request) => request.index)).toEqual([1])
    }),
  )

  suite.instance("interruption is durable and explicit resume reuses the allocated child", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const sessionID = SessionID.create()
      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const allocated: Array<SessionID | undefined> = []
      const fiber = yield* duo
        .start(
          {
            sessionID,
            objective: "Complete the task in both workspaces.",
            members,
            schedule: "sequential",
            review: false,
            peerChars: 100,
          },
          (request) =>
            Effect.gen(function* () {
              const id = SessionID.create()
              allocated[request.index] = id
              yield* request.onAllocated(id)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(never)
              return { taskID: id, status: "completed" as const, output: "unreachable" }
            }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(duo.owns(sessionID)).toBe(true)
      yield* Fiber.interrupt(fiber)
      const saved = yield* duo.get(sessionID)
      expect(saved?.status).toBe("interrupted")
      expect(saved?.members[0]?.taskID).toBe(allocated[0])
      expect(duo.owns(sessionID)).toBe(false)

      const resumed: Duo.Invocation[] = []
      const done = yield* duo.resume({ sessionID }, (request) => {
        resumed.push(request)
        return Effect.succeed({ status: "completed" as const, output: "continued" })
      })
      expect(resumed[0]?.taskID).toBe(allocated[0])
      expect(done.status).toBe("completed")
      expect(done.members[0]?.work?.output).toBe("continued")
      expect(done.members[1]?.work?.output).toBe("continued")
    }),
  )

  suite.instance("explicit resume recovers a persisted running record after process loss", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const sessionID = SessionID.create()
      const existing: Duo.State = {
        id: "saved-duo-run",
        sessionID,
        objective: "Continue the saved objective.",
        status: "running",
        phase: "work",
        members: [{ ...members[0], taskID: SessionID.create() }, { ...members[1] }],
        schedule: "sequential",
        reviewEnabled: false,
        peerChars: 100,
        updatedAt: Date.now(),
      }
      records.set(`duo/${sessionID}`, structuredClone(existing))
      expect(duo.owns(sessionID)).toBe(false)
      const seen: Duo.Invocation[] = []
      const resumed = yield* duo.resume({ sessionID }, (request) => {
        seen.push(request)
        return Effect.succeed({ status: "completed" as const, output: "recovered" })
      })
      expect(seen).toHaveLength(2)
      expect(seen[0]?.taskID).toBe(existing.members[0].taskID)
      expect(resumed.status).toBe("completed")
      expect(resumed.schedule).toBe("parallel")
      expect(duo.owns(sessionID)).toBe(false)
    }),
  )

  suite.instance("shares a completed peer result and starts its review while the other member is still working", () =>
    Effect.gen(function* () {
      const duo = yield* Duo.Service
      const sessionID = SessionID.create()
      const draelID = SessionID.create()
      const lunaID = SessionID.create()
      const draelStarted = yield* Deferred.make<void>()
      const reviewStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* duo
        .start(
          {
            sessionID,
            objective: "Improve this together while both are working.",
            members,
            schedule: "parallel",
            review: true,
            peerChars: 1_000,
          },
          (request) =>
            Effect.gen(function* () {
              yield* request.onAllocated(request.index === 0 ? draelID : lunaID)
              if (request.index === 0 && request.phase === "work") {
                yield* Deferred.succeed(draelStarted, undefined)
                yield* Deferred.await(release)
                return { status: "completed" as const, output: "Drael used the useful peer result" }
              }
              if (request.index === 1 && request.phase === "work") {
                yield* Deferred.await(draelStarted)
                return { status: "completed" as const, output: "LUNA-EARLY-RESULT" }
              }
              if (request.index === 1 && request.phase === "review") {
                expect(request.prompt).toContain("The peer is still working")
                yield* Deferred.succeed(reviewStarted, undefined)
                yield* Deferred.await(release)
              }
              return { status: "completed" as const, output: "Reviewed available evidence" }
            }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(reviewStarted)
      const whileWorking = yield* duo.get(sessionID)
      expect(whileWorking?.members[0].work).toBeUndefined()
      expect(whileWorking?.members[1].work?.status).toBe("completed")
      expect(yield* duo.context(draelID)).toContain("LUNA-EARLY-RESULT")
      expect(yield* duo.context(SessionID.create())).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const finished = yield* Fiber.join(fiber)
      expect(finished.members.every((member) => member.review?.status === "completed")).toBe(true)
      expect(yield* duo.context(draelID)).toBeUndefined()
    }),
  )
})
