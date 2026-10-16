export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Operation = never, OperationError = E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Applies an operation in FIFO order with the current execution owner. */
  readonly operate: (key: Key, operation: Operation) => Effect.Effect<void, E | OperationError>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type QueuedOperation<Operation, E> = {
  readonly operation: Operation
  readonly done: Deferred.Deferred<void, E>
}

type Entry<E, Operation, OperationError, Continuation> = {
  readonly done: Deferred.Deferred<void, E>
  readonly operations: Array<QueuedOperation<Operation, E | OperationError>>
  currentOperation?: QueuedOperation<Operation, E | OperationError>
  owner?: Fiber.Fiber<void, never>
  continuation?: Continuation
  hasContinuation: boolean
  drainRequested: boolean
  drainForce: boolean
  drainStarted: boolean
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E, Operation = never, Continuation = never, OperationError = E>(options: {
  readonly drain: (
    key: Key,
    force: boolean,
    control: { readonly shouldYield: () => boolean; readonly continuation?: Continuation },
  ) => Effect.Effect<void | { readonly continuation: Continuation }, E>
  readonly operate?: (key: Key, operation: Operation) => Effect.Effect<void, OperationError>
}): Effect.Effect<Coordinator<Key, E, Operation, OperationError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E, Operation, OperationError, Continuation>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (drainRequested = false, drainForce = false) =>
      ({
        done: Deferred.makeUnsafe<void, E>(),
        operations: [],
        hasContinuation: false,
        drainRequested,
        drainForce,
        drainStarted: false,
        pendingWake: false,
        stopping: false,
      }) as Entry<E, Operation, OperationError, Continuation>

    const settle = (key: Key, entry: Entry<E, Operation, OperationError, Continuation>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping) {
        if (entry.pendingWake) {
          entry.pendingWake = false
          if (!entry.drainRequested) {
            entry.drainRequested = true
            entry.drainForce = false
          }
        }

        if (
          entry.currentOperation !== undefined ||
          entry.operations.length > 0 ||
          entry.drainRequested ||
          entry.hasContinuation
        ) {
          start(key, entry)
          return
        }
      }

      if (entry.currentOperation !== undefined) Deferred.doneUnsafe(entry.currentOperation.done, exit)
      for (const queued of entry.operations.splice(0)) Deferred.doneUnsafe(queued.done, exit)

      const successor = entry.pendingWake ? makeEntry(true, false) : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const start = (key: Key, entry: Entry<E, Operation, OperationError, Continuation>) => {
      const ready = Deferred.makeUnsafe<void>()
      const loop: Effect.Effect<void, E> = Effect.suspend(() => {
        if (entry.stopping) return Effect.interrupt

        const queued = entry.operations.shift()
        if (queued !== undefined) {
          entry.currentOperation = queued
          if (options.operate === undefined) return Effect.die(new Error("Coordinator operation handler is missing"))
          return Effect.exit(options.operate(key, queued.operation)).pipe(
            Effect.flatMap((exit) =>
              Effect.sync(() => {
                entry.currentOperation = undefined
                Deferred.doneUnsafe(queued.done, exit)
              }).pipe(Effect.andThen(loop)),
            ),
          )
        }

        if (entry.pendingWake) {
          entry.pendingWake = false
          if (!entry.drainRequested) {
            entry.drainRequested = true
            entry.drainForce = false
          }
        }

        if (!entry.drainRequested && !entry.hasContinuation) return Effect.void

        const force = entry.drainRequested ? entry.drainForce : false
        entry.drainRequested = false
        entry.drainForce = false
        entry.drainStarted = true
        return Effect.suspend(() =>
          options.drain(key, force, {
            shouldYield: () => entry.operations.length > 0,
            ...(entry.hasContinuation ? { continuation: entry.continuation } : {}),
          }),
        ).pipe(
          Effect.map((result) => {
            const continuation = typeof result === "object" && result !== null && "continuation" in result
            entry.hasContinuation = continuation
            entry.continuation = continuation ? result.continuation : undefined
            if (!continuation) entry.drainStarted = false
          }),
          Effect.andThen(loop),
        )
      })

      const owner = fork(
        Deferred.await(ready).pipe(
          Effect.andThen(loop),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      Deferred.doneUnsafe(ready, Effect.void)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          if (!entry.drainStarted && !entry.hasContinuation) {
            entry.drainRequested = true
            entry.drainForce = true
          }
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry(true, true)
        active.set(key, next)
        start(key, next)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry(true, false)
        active.set(key, next)
        start(key, next)
      })

    const operate = (key: Key, operation: Operation): Effect.Effect<void, E | OperationError> =>
      Effect.uninterruptibleMask((restore) => {
        let waiter: Deferred.Deferred<void, E | OperationError>
        const entry = active.get(key)
        if (entry !== undefined) {
          waiter = Deferred.makeUnsafe<void, E | OperationError>()
          entry.operations.push({ operation, done: waiter })
        } else {
          const next = makeEntry(false, false)
          waiter = Deferred.makeUnsafe<void, E | OperationError>()
          next.operations.push({ operation, done: waiter })
          active.set(key, next)
          start(key, next)
        }
        return restore(Deferred.await(waiter))
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, operate, interrupt }
  })
