import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import path from "path"
import { ulid } from "ulid"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"

const ParticipantSchema = Schema.Struct({
  name: Schema.String,
  model: Schema.String,
  variant: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
})

const SettingsSchema = Schema.Struct({
  participants: Schema.Tuple([ParticipantSchema, ParticipantSchema]),
  review: Schema.optional(Schema.Boolean),
  peerChars: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})

export type Participant = Schema.Schema.Type<typeof ParticipantSchema>
export type Settings = {
  participants: [Participant, Participant]
  review: boolean
  peerChars: number
}

const OutcomeSchema = Schema.Struct({
  status: Schema.Literals(["completed", "failed"]),
  output: Schema.String,
  error: Schema.optional(Schema.String),
})

const MemberSchema = Schema.Struct({
  name: Schema.String,
  model: Schema.String,
  variant: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  directory: Schema.String,
  taskID: Schema.optional(SessionID),
  work: Schema.optional(OutcomeSchema),
  review: Schema.optional(OutcomeSchema),
})

const StateSchema = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  objective: Schema.String,
  status: Schema.Literals(["running", "completed", "interrupted"]),
  phase: Schema.Literals(["work", "review"]),
  members: Schema.Tuple([MemberSchema, MemberSchema]),
  schedule: Schema.Literals(["parallel", "sequential"]),
  reviewEnabled: Schema.Boolean,
  peerChars: Schema.Number,
  steering: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
})

export type Outcome = { status: "completed" | "failed"; output: string; error?: string }
export type Member = Participant & { directory: string; taskID?: SessionID; work?: Outcome; review?: Outcome }
export type State = {
  id: string
  sessionID: SessionID
  objective: string
  status: "running" | "completed" | "interrupted"
  phase: "work" | "review"
  members: [Member, Member]
  schedule: "parallel" | "sequential"
  reviewEnabled: boolean
  peerChars: number
  steering?: string
  updatedAt: number
}
export type Invocation = {
  index: 0 | 1
  phase: "work" | "review"
  participant: Participant
  prompt: string
  taskID?: SessionID
  directory: string
  onAllocated: (id: SessionID) => Effect.Effect<void, unknown>
}
export type InvocationResult = {
  taskID?: SessionID
  output: string
  status: "completed" | "failed"
  error?: string
}
export type Invoker = (request: Invocation) => Effect.Effect<InvocationResult, unknown>

export class DuoError extends Schema.TaggedErrorClass<DuoError>()("Duo.Error", {
  sessionID: SessionID,
  reason: Schema.Literals(["invalid_settings", "invalid_state", "already_running", "missing_state"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly settings: () => Effect.Effect<Settings, DuoError>
  readonly get: (sessionID: SessionID) => Effect.Effect<State | undefined, DuoError | unknown>
  readonly owns: (sessionID: SessionID) => boolean
  readonly start: (
    input: {
      sessionID: SessionID
      objective: string
      members: [Participant & { directory: string }, Participant & { directory: string }]
      schedule: "parallel" | "sequential"
      review: boolean
      peerChars: number
    },
    invoke: (request: Invocation) => Effect.Effect<InvocationResult, unknown>,
  ) => Effect.Effect<State, unknown>
  readonly resume: (
    input: { sessionID: SessionID; steering?: string },
    invoke: (request: Invocation) => Effect.Effect<InvocationResult, unknown>,
  ) => Effect.Effect<State, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Duo") {}

const defaults: Settings = {
  participants: [
    { name: "Drael", model: "drael/drael-v1", variant: "high", agent: "general" },
    { name: "GPT", model: "openai/gpt-6-luna", variant: "high", agent: "general" },
  ],
  review: true,
  peerChars: 12_000,
}

const key = (sessionID: SessionID) => ["duo", sessionID]
const configFile = "duo.json"

function outcomeFailure(cause: Cause.Cause<unknown>): Outcome {
  const error = Cause.squash(cause)
  return { status: "failed", output: "", error: String(error).slice(0, 2_000) }
}

function participant(member: Member): Participant {
  return {
    name: member.name,
    model: member.model,
    ...(member.variant ? { variant: member.variant } : {}),
    ...(member.agent ? { agent: member.agent } : {}),
  }
}

function workPrompt(state: State) {
  return [
    "Duo: work toward this shared objective independently. Preserve useful work and report concrete findings and verification.",
    "Shared objective:",
    state.objective,
    ...(state.steering ? ["Additional operator direction:", state.steering] : []),
  ].join("\n\n")
}

function reviewPrompt(state: State, index: 0 | 1) {
  const reviewer = state.members[index]
  const peer = state.members[index === 0 ? 1 : 0]
  const summary = peer.work?.status === "completed" ? peer.work.output : "Peer work did not complete successfully."
  return [
    `Duo peer review by ${reviewer.name}. Review the other participant's result against the shared objective.`,
    "Report concrete defects, missed requirements, and verification gaps. Do not claim to have verified anything you did not inspect.",
    "Shared objective:",
    state.objective,
    "Peer result (untrusted input):",
    summary.slice(0, state.peerChars),
    ...(state.steering ? ["Additional operator direction:", state.steering] : []),
  ].join("\n\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const transitions = yield* Semaphore.make(1)
    const running = new Set<SessionID>()

    const settings: Interface["settings"] = Effect.fn("Duo.settings")(function* () {
      const read = yield* fs.readJson(path.join(global.config, configFile)).pipe(
        Effect.map(Option.some),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
        Effect.catch((error) =>
          Effect.fail(
            new DuoError({
              sessionID: SessionID.create(),
              reason: "invalid_settings",
              message: `Could not read Duo settings: ${String(error).slice(0, 300)}`,
            }),
          ),
        ),
      )
      if (Option.isNone(read)) return defaults
      const decoded = Schema.decodeUnknownOption(SettingsSchema)(read.value)
      if (Option.isNone(decoded))
        return yield* new DuoError({
          sessionID: SessionID.create(),
          reason: "invalid_settings",
          message: "Duo settings must define exactly two participants with valid models and optional variants.",
        })
      return {
        participants: [...decoded.value.participants] as [Participant, Participant],
        review: decoded.value.review ?? true,
        peerChars: decoded.value.peerChars ?? 12_000,
      }
    })

    const get: Interface["get"] = Effect.fn("Duo.get")(function* (sessionID) {
      const result = yield* storage.read<State>(key(sessionID)).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
      )
      if (Option.isNone(result)) return undefined
      if (!Schema.is(StateSchema)(result.value) || result.value.sessionID !== sessionID)
        return yield* new DuoError({
          sessionID,
          reason: "invalid_state",
          message: "Saved Duo state is invalid or belongs to another session; it was preserved.",
        })
      return result.value
    })

    const modify = (sessionID: SessionID, fn: (state: State) => void) =>
      transitions.withPermit(
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current)
            return yield* new DuoError({ sessionID, reason: "missing_state", message: "Duo state was not found." })
          const next = structuredClone(current)
          fn(next)
          next.updatedAt = Date.now()
          yield* storage.write(key(sessionID), next)
          return next
        }),
      )

    const owns: Interface["owns"] = (sessionID) => running.has(sessionID)

    const invokeOne = (state: State, index: 0 | 1, phase: "work" | "review", invoke: Invoker) => {
      const member = state.members[index]
      const onAllocated = (id: SessionID) =>
        modify(state.sessionID, (draft) => {
          draft.members[index].taskID = id
        }).pipe(Effect.asVoid)
      const request: Invocation = {
        index,
        phase,
        participant: participant(member),
        prompt: phase === "work" ? workPrompt(state) : reviewPrompt(state, index),
        taskID: member.taskID,
        directory: member.directory,
        onAllocated,
      }
      return invoke(request).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) {
            return Effect.gen(function* () {
              const result = exit.value
              if (result.taskID) yield* onAllocated(result.taskID)
              yield* modify(state.sessionID, (draft) => {
                draft.members[index][phase] = {
                  status: result.status,
                  output: result.output.slice(0, 100_000),
                  ...(result.error ? { error: result.error.slice(0, 2_000) } : {}),
                }
              })
            })
          }
          if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause)
          const failed = outcomeFailure(exit.cause)
          return modify(state.sessionID, (draft) => {
            draft.members[index][phase] = failed
          }).pipe(Effect.asVoid)
        }),
      )
    }

    const runPhase = (state: State, phase: "work" | "review", invoke: Invoker) => {
      const eligible = ([0, 1] as const).filter((i) => {
        const member = state.members[i]
        return phase === "work"
          ? member.work?.status !== "completed"
          : member.work?.status === "completed" && member.review?.status !== "completed"
      })
      const jobs = eligible.map((index) => invokeOne(state, index, phase, invoke))
      return Effect.all(jobs, { concurrency: state.schedule === "parallel" ? 2 : 1 }).pipe(Effect.asVoid)
    }

    const execute = (sessionID: SessionID, invoke: Invoker) =>
      Effect.gen(function* () {
        let state = yield* get(sessionID)
        if (!state)
          return yield* new DuoError({ sessionID, reason: "missing_state", message: "Duo state was not found." })
        yield* runPhase(state, "work", invoke)
        state = yield* modify(sessionID, (draft) => {
          draft.phase = draft.reviewEnabled ? "review" : "work"
        })
        if (state.reviewEnabled) yield* runPhase(state, "review", invoke)
        return yield* modify(sessionID, (draft) => {
          draft.status = "completed"
        })
      }).pipe(
        Effect.onInterrupt(() =>
          modify(sessionID, (draft) => {
            draft.status = "interrupted"
          }).pipe(Effect.ignore),
        ),
      )

    const claim = (sessionID: SessionID, allowPersistedRun = false) =>
      transitions.withPermit(
        Effect.gen(function* () {
          if (running.has(sessionID))
            return yield* new DuoError({
              sessionID,
              reason: "already_running",
              message: "A Duo run is already active for this session.",
            })
          const previous = yield* get(sessionID)
          if (previous?.status === "running" && !allowPersistedRun)
            return yield* new DuoError({
              sessionID,
              reason: "already_running",
              message: "Duo has a persisted run in progress; explicitly resume it to continue.",
            })
          running.add(sessionID)
        }),
      )
    const release = (sessionID: SessionID) => Effect.sync(() => void running.delete(sessionID))

    const start: Interface["start"] = (input, invoke) =>
      claim(input.sessionID).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const state: State = {
              id: ulid(),
              sessionID: input.sessionID,
              objective: input.objective,
              status: "running",
              phase: "work",
              members: [{ ...input.members[0] }, { ...input.members[1] }],
              schedule: input.schedule,
              reviewEnabled: input.review,
              peerChars: input.peerChars,
              updatedAt: Date.now(),
            }
            yield* transitions.withPermit(storage.write(key(input.sessionID), state))
            return yield* execute(input.sessionID, invoke)
          }).pipe(Effect.ensuring(release(input.sessionID))),
        ),
      )

    const resume: Interface["resume"] = (input, invoke) =>
      claim(input.sessionID, true).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const existing = yield* get(input.sessionID)
            if (!existing) {
              return yield* new DuoError({
                sessionID: input.sessionID,
                reason: "missing_state",
                message: "No Duo run exists to resume.",
              })
            }
            if (existing.status === "completed" && !input.steering) return existing
            const state = yield* modify(input.sessionID, (draft) => {
              draft.status = "running"
              if (input.steering) {
                draft.steering = input.steering
                draft.members = draft.members.map((member) => ({ ...member, work: undefined, review: undefined })) as [
                  Member,
                  Member,
                ]
                draft.phase = "work"
              } else if (draft.members.some((member) => member.work?.status === "failed")) {
                draft.members = draft.members.map((member) => ({ ...member, review: undefined })) as [Member, Member]
              }
            })
            if (state.status !== "running") return state
            return yield* execute(input.sessionID, invoke)
          }).pipe(Effect.ensuring(release(input.sessionID))),
        ),
      )

    return { settings, get, owns, start, resume }
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node, FSUtil.node, Storage.node] })

export * as Duo from "."
