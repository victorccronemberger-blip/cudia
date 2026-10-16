import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionRunCoordinator", () => {
  it.effect("joins concurrent resumes for one key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("joins a wake-started execution without forcing a successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(resumed)

        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("starts execution when woken while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(drained, undefined).pipe(Effect.asVoid),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(drained)
      }),
    ),
  )

  it.effect("snapshots only active executions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Deferred.succeed(key === "first" ? firstStarted : secondStarted, undefined)
              .pipe(Effect.andThen(Deferred.await(key === "first" ? firstGate : secondGate)))
              .pipe(Effect.asVoid),
        })

        expect(Array.from(yield* coordinator.active)).toEqual([])
        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first"])

        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(secondStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first", "second"])

        yield* Deferred.succeed(firstGate, undefined)
        yield* Fiber.join(first)
        expect(Array.from(yield* coordinator.active)).toEqual(["second"])
        yield* Deferred.succeed(secondGate, undefined)
        yield* Fiber.join(second)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions after failure and defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new Error("failed")
        const defect = new Error("defect")
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) => (key === "failure" ? Effect.fail(failure) : Effect.die(defect)),
        })

        const failed = yield* coordinator.run("failure").pipe(Effect.exit)
        expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])

        const died = yield* coordinator.run("defect").pipe(Effect.exit)
        expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })
          yield* coordinator.wake("session")
          yield* Deferred.await(started)
          expect(Array.from(yield* coordinator.active)).toEqual(["session"])
          return coordinator
        }),
      )

      expect(Array.from(yield* coordinator.active)).toEqual([])
    }),
  )

  it.effect("coalesces wakes received during active execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs)
              .pipe(
                Effect.flatMap((run) =>
                  run === 1
                    ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                    : Deferred.succeed(secondStarted, undefined),
                ),
              )
              .pipe(Effect.asVoid),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* Effect.all([coordinator.wake("session"), coordinator.wake("session"), coordinator.wake("session")], {
          concurrency: "unbounded",
        })
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("runs again when woken during the follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const thirdStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs)
              .pipe(
                Effect.flatMap((run) =>
                  run === 1
                    ? Deferred.await(firstGate)
                    : run === 2
                      ? Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
                      : Deferred.succeed(thirdStarted, undefined),
                ),
              )
              .pipe(Effect.asVoid),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(secondGate, undefined)
        yield* Deferred.await(thirdStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(3)
      }),
    ),
  )

  it.effect("does nothing when interrupted while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Effect.void })
        yield* coordinator.interrupt("session")
      }),
    ),
  )

  it.effect("interrupts active execution and clears its pending wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* coordinator.interrupt("session")
        yield* Deferred.await(interrupted)

        const exit = yield* Fiber.await(resumed)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs a wake registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs)
              .pipe(
                Effect.flatMap((run) =>
                  run === 1
                    ? Deferred.succeed(firstStarted, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() =>
                          Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                        ),
                      )
                    : Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid),
                ),
              )
              .pipe(Effect.asVoid),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Deferred.await(secondStarted)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("starts a resume registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) => {
            forces.push(force)
            return forces.length === 1
              ? Deferred.succeed(firstStarted, undefined)
                  .pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                    ),
                  )
                  .pipe(Effect.asVoid)
              : Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid)
          },
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(interrupt), Fiber.join(resumed)])
        yield* Deferred.await(secondStarted)

        expect(forces).toEqual([false, true])
      }),
    ),
  )

  it.effect("starts one follow-up when a wake races with failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const failure = new Error("failed")
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs)
              .pipe(
                Effect.flatMap((run) =>
                  run === 1
                    ? Deferred.await(gate).pipe(Effect.andThen(Effect.fail(failure)))
                    : Deferred.succeed(secondStarted, undefined).pipe(Effect.asVoid),
                ),
              )
              .pipe(Effect.asVoid),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
        yield* Deferred.await(secondStarted)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("does not cancel execution when a joined waiter is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Fiber.interrupt(second)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)

        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs different keys concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const bothStarted = yield* Deferred.make<void>()
        let active = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() => (active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      }),
    ),
  )

  it.effect("trampolines synchronous self-waking execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limit = 20_000
        const completed = yield* Deferred.make<void>()
        let runs = 0
        let wake: (key: string) => Effect.Effect<void> = () => Effect.void
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (key) =>
            Effect.sync(() => ++runs).pipe(
              Effect.tap((run) => (run < limit ? wake(key) : Deferred.succeed(completed, undefined))),
              Effect.asVoid,
            ),
        })
        wake = coordinator.wake

        yield* coordinator.wake("session")
        yield* Deferred.await(completed)

        expect(runs).toBe(limit)
      }),
    ),
  )

  it.effect("runs an idle operation without starting a normal drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operations: string[] = []
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: () => Effect.sync(() => drains++).pipe(Effect.asVoid),
          operate: (_key, operation) => Effect.sync(() => operations.push(operation)),
        })

        yield* coordinator.operate("session", "inspect")

        expect(operations).toEqual(["inspect"])
        expect(drains).toBe(0)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("runs queued operations before the saved continuation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const trace: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, number, never>({
          drain: (_key, _force, control) => {
            if (control.continuation !== undefined) return Effect.sync(() => trace.push("resume")).pipe(Effect.asVoid)
            return Deferred.await(gate).pipe(
              Effect.andThen(
                Effect.sync(() => (control.shouldYield() ? { continuation: 1 } : (trace.push("finish"), undefined))),
              ),
            )
          },
          operate: (_key, operation) => Effect.sync(() => trace.push(operation)),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const first = yield* coordinator.operate("session", "first").pipe(Effect.forkChild)
        const second = yield* coordinator.operate("session", "second").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(resumed)])

        expect(trace).toEqual(["first", "second", "resume"])
      }),
    ),
  )

  it.effect("runs a forced drain after an explicit resume joins an idle operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationStarted = yield* Deferred.make<void>()
        const operationGate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: (_key, force) => Effect.sync(() => forces.push(force)).pipe(Effect.asVoid),
          operate: (_key) =>
            Deferred.succeed(operationStarted, undefined).pipe(Effect.andThen(Deferred.await(operationGate))),
        })

        const operation = yield* coordinator.operate("session", "inspect").pipe(Effect.forkChild)
        yield* Deferred.await(operationStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(operationGate, undefined)
        yield* Effect.all([Fiber.join(operation), Fiber.join(resumed)])

        expect(forces).toEqual([true])
      }),
    ),
  )

  it.effect("preserves a forced resume when a wake arrives during an idle operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationStarted = yield* Deferred.make<void>()
        const operationGate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: (_key, force) => Effect.sync(() => forces.push(force)).pipe(Effect.asVoid),
          operate: () =>
            Deferred.succeed(operationStarted, undefined).pipe(Effect.andThen(Deferred.await(operationGate))),
        })

        const operation = yield* coordinator.operate("session", "inspect").pipe(Effect.forkChild)
        yield* Deferred.await(operationStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(operationGate, undefined)
        yield* Effect.all([Fiber.join(operation), Fiber.join(resumed)])

        expect(forces).toEqual([true])
      }),
    ),
  )

  it.effect("forces a resume during an operation after a completed ordinary drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drainGate = yield* Deferred.make<void>()
        const operationStarted = yield* Deferred.make<void>()
        const operationGate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(Effect.andThen(force ? Effect.void : Deferred.await(drainGate))),
          operate: () =>
            Deferred.succeed(operationStarted, undefined).pipe(Effect.andThen(Deferred.await(operationGate))),
        })

        yield* coordinator.wake("session")
        yield* Effect.yieldNow
        const operation = yield* coordinator.operate("session", "after-drain").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(drainGate, undefined)
        yield* Deferred.await(operationStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(operationGate, undefined)
        yield* Effect.all([Fiber.join(operation), Fiber.join(resumed)])

        expect(forces).toEqual([false, true])
      }),
    ),
  )

  it.effect("fails an operation waiter when no operation handler is configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: () => Effect.void,
        })

        const exit = yield* coordinator.operate("session", "unsupported").pipe(Effect.exit)

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("keeps an active operation running when its caller waiter is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationStarted = yield* Deferred.make<void>()
        const operationGate = yield* Deferred.make<void>()
        const committed = yield* Deferred.make<void>()
        let commits = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: () => Effect.void,
          operate: () =>
            Deferred.succeed(operationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(operationGate)),
              Effect.andThen(Effect.sync(() => ++commits)),
              Effect.tap(() => Deferred.succeed(committed, undefined)),
              Effect.asVoid,
            ),
        })

        const caller = yield* coordinator.operate("session", "commit").pipe(Effect.forkChild)
        yield* Deferred.await(operationStarted)
        yield* Fiber.interrupt(caller)
        const callerExit = yield* Fiber.await(caller)
        expect(Exit.isFailure(callerExit) && Cause.hasInterruptsOnly(callerExit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual(["session"])

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(operationGate, undefined)
        yield* Effect.all([Fiber.join(resumed), Deferred.await(committed)])

        expect(commits).toBe(1)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("fails queued operation and run waiters with the same drain failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drainStarted = yield* Deferred.make<void>()
        const drainGate = yield* Deferred.make<void>()
        const failure = new Error("drain failed")
        let operations = 0
        const coordinator = yield* SessionRunCoordinator.make<string, Error, string, never, never>({
          drain: () =>
            Deferred.succeed(drainStarted, undefined).pipe(
              Effect.andThen(Deferred.await(drainGate)),
              Effect.andThen(Effect.fail(failure)),
            ),
          operate: () => Effect.sync(() => operations++).pipe(Effect.asVoid),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(drainStarted)
        const operation = yield* coordinator.operate("session", "queued").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(drainGate, undefined)
        const [runExit, operationExit] = yield* Effect.all([Fiber.await(resumed), Fiber.await(operation)])

        expect(Exit.isFailure(runExit) && Cause.hasFails(runExit.cause)).toBeTrue()
        expect(Exit.isFailure(operationExit) && Cause.hasFails(operationExit.cause)).toBeTrue()
        expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
        expect(yield* Fiber.join(operation).pipe(Effect.flip)).toBe(failure)
        expect(operations).toBe(0)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("settles active and queued operation waiters when the coordinator scope closes", () =>
    Effect.gen(function* () {
      const operationStarted = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
            drain: () => Effect.void,
            operate: () => Deferred.succeed(operationStarted, undefined).pipe(Effect.andThen(Effect.never)),
          })
          const active = yield* coordinator.operate("session", "active").pipe(Effect.forkDetach)
          yield* Deferred.await(operationStarted)
          const queued = yield* coordinator.operate("session", "queued").pipe(Effect.forkDetach)
          yield* Effect.yieldNow
          return { coordinator, active, queued }
        }),
      )
      const [activeExit, queuedExit] = yield* Effect.all([
        Fiber.await(coordinator.active),
        Fiber.await(coordinator.queued),
      ])

      expect(Exit.isFailure(activeExit) && Cause.hasInterruptsOnly(activeExit.cause)).toBeTrue()
      expect(Exit.isFailure(queuedExit) && Cause.hasInterruptsOnly(queuedExit.cause)).toBeTrue()
      expect(Array.from(yield* coordinator.coordinator.active)).toEqual([])
    }),
  )

  it.effect("settles the active operation waiter when its owner is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationStarted = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: () => Effect.void,
          operate: () => Deferred.succeed(operationStarted, undefined).pipe(Effect.andThen(Effect.never)),
        })

        const operation = yield* coordinator.operate("session", "active").pipe(Effect.forkChild)
        yield* Deferred.await(operationStarted)
        yield* coordinator.interrupt("session")
        const exit = yield* Fiber.await(operation)

        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("continues after one operation fails and coalesces a wake during an operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationStarted = yield* Deferred.make<void>()
        const operationGate = yield* Deferred.make<void>()
        const failure = new Error("operation failed")
        const trace: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, Error>({
          drain: (_key, force) => Effect.sync(() => trace.push(`drain:${force}`)).pipe(Effect.asVoid),
          operate: (_key, operation) =>
            operation === "fail"
              ? Effect.fail(failure)
              : Deferred.succeed(operationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(operationGate)),
                  Effect.tap(() => Effect.sync(() => trace.push(operation))),
                ),
        })

        const failed = yield* coordinator.operate("session", "fail").pipe(Effect.exit)
        expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBeTrue()
        const operation = yield* coordinator.operate("session", "finish").pipe(Effect.forkChild)
        yield* Deferred.await(operationStarted)
        yield* Effect.all([coordinator.wake("session"), coordinator.wake("session")], { concurrency: "unbounded" })
        yield* Deferred.succeed(operationGate, undefined)
        yield* Fiber.join(operation)

        expect(trace).toEqual(["finish", "drain:false"])
      }),
    ),
  )

  it.effect("settles queued operations on interruption and preserves a wake during cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const followup = yield* Deferred.make<void>()
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, never, string, never, never>({
          drain: () =>
            Effect.sync(() => ++drains)
              .pipe(
                Effect.flatMap((run) =>
                  run === 1
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() =>
                          Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                        ),
                      )
                    : Deferred.succeed(followup, undefined),
                ),
              )
              .pipe(Effect.asVoid),
          operate: () => Effect.never,
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const operation = yield* coordinator.operate("session", "queued").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(interrupt), Fiber.await(operation), Fiber.await(resumed)])
        yield* Deferred.await(followup)

        const operationExit = yield* Fiber.await(operation)
        expect(Exit.isFailure(operationExit) && Cause.hasInterruptsOnly(operationExit.cause)).toBeTrue()
        expect(drains).toBe(2)
      }),
    ),
  )
})
