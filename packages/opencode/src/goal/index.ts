import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { ulid } from "ulid"
import { Storage } from "@/storage/storage"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { CommandInput, PromptInput } from "@/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Image } from "@/image/image"
import { parseCommand } from "./command"

const Status = Schema.Literals(["active", "completed", "blocked", "paused", "cancelled", "failed", "budget_limited"])
const Saved = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  objective: Schema.String,
  status: Status,
  iteration: Schema.Number,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  maxIterations: Schema.optional(Schema.Number),
  runtime: Schema.optional(Schema.Literal(2)),
  revision: Schema.optional(Schema.Number),
  tokensUsed: Schema.optional(Schema.Number),
  tokenBudget: Schema.optional(Schema.Number),
  completionCriteria: Schema.Array(Schema.String),
  plan: Schema.Array(Schema.Unknown),
  observations: Schema.Array(Schema.String),
  failures: Schema.Array(Schema.Unknown),
  recentHashes: Schema.Array(Schema.String),
  replanned: Schema.Boolean,
})

type SavedState = Schema.Schema.Type<typeof Saved>
export type State = { -readonly [K in keyof SavedState]: SavedState[K] } & {
  completionCriteria: string[]
  plan: Array<{ id: string; description: string; status: string; attempts: number }>
  observations: string[]
  failures: Array<{ iteration: number; error: string }>
  recentHashes: string[]
  replanned: boolean
  lastVerification?: unknown
  currentStep?: string
  instructions?: string[]
  parentID?: MessageID
  accountedID?: MessageID
  workParentID?: MessageID
  continuedID?: MessageID
  stopReason?: string
  evidence?: string
  summary?: string
}

export class StateError extends Schema.TaggedErrorClass<StateError>()("Goal.StateError", {
  sessionID: SessionID,
  reason: Schema.Literals(["invalid_state", "session_mismatch", "stale_update", "missing_evidence"]),
  message: Schema.String,
}) {}

export type Token = { id: string; revision: number }
const WakeToken = Schema.Struct({ id: Schema.String, revision: Schema.Number })
export function wakeToken(message: SessionV1.WithParts): Token | undefined {
  for (const part of message.parts) {
    if (part.type !== "text" || !part.synthetic) continue
    const value = part.metadata?.goalWake
    if (Schema.is(WakeToken)(value)) return value
  }
}
export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<State | undefined, unknown>
  readonly command: (
    input: CommandInput,
    run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
    respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
    stop: (sessionID: SessionID) => Effect.Effect<void>,
  ) => Effect.Effect<SessionV1.WithParts, unknown>
  readonly observe: (sessionID: SessionID, text: string) => Effect.Effect<void, unknown>
  readonly pause: (sessionID: SessionID) => Effect.Effect<void, unknown>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void, unknown>
  readonly begin: (sessionID: SessionID, parentID: MessageID, expected?: Token) => Effect.Effect<boolean, unknown>
  readonly account: (sessionID: SessionID, message: SessionV1.WithParts) => Effect.Effect<void, unknown>
  readonly continuation: (
    sessionID: SessionID,
    message: SessionV1.WithParts,
    automatic: boolean,
  ) => Effect.Effect<Token | undefined, unknown>
  readonly update: (
    sessionID: SessionID,
    token: Token,
    input: { status: "completed" | "blocked"; evidence: string; summary?: string },
  ) => Effect.Effect<State, unknown>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

export function context(goal: State, includeObjective = true): string {
  return [
    "[Active goal]",
    ...(includeObjective ? [goal.objective] : []),
    "Continue toward this outcome. Check the result against available evidence. Use update_goal to report completion or a concrete blocker; get_goal reads current state.",
    ...(goal.tokenBudget ? [`Tokens: ${goal.tokensUsed ?? 0}/${goal.tokenBudget}.`] : []),
    ...(goal.maxIterations ? [`Turns: ${goal.iteration}/${goal.maxIterations}.`] : []),
  ].join("\n")
}

export function token(goal: State): Token {
  return { id: goal.id, revision: goal.revision ?? 0 }
}

export function formatStatus(goal: State): string {
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Turns: ${goal.iteration}${goal.maxIterations ? `/${goal.maxIterations}` : ""}`,
    `Tokens: ${goal.tokensUsed ?? 0}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}`,
    ...(goal.stopReason ? [`Continuation: ${goal.stopReason}`] : []),
    ...(goal.evidence ? [`Evidence: ${goal.evidence}`] : []),
    "Commands: /goal pause | resume | clear | replace <objective>",
  ].join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const commands = yield* Semaphore.make(1)
    const key = (id: SessionID) => ["goal", id]
    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      const value = yield* storage.read<State>(key(sessionID)).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
      )
      if (Option.isNone(value)) return undefined
      if (!Schema.is(Saved)(value.value))
        return yield* new StateError({
          sessionID,
          reason: "invalid_state",
          message: "Saved goal state is invalid and was preserved.",
        })
      if (value.value.sessionID !== sessionID)
        return yield* new StateError({
          sessionID,
          reason: "session_mismatch",
          message: "Saved goal state belongs to another session and was preserved.",
        })
      return value.value
    })

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID) {
      if (!(yield* get(sessionID))) return
      yield* storage.update<State>(key(sessionID), (current) => {
        if (current.status !== "active") return
        current.status = "paused"
        current.revision = (current.revision ?? 0) + 1
        current.updatedAt = Date.now()
      })
    })

    const cancel = Effect.fn("Goal.cancel")(function* (sessionID: SessionID) {
      if (!(yield* get(sessionID))) return
      yield* storage.update<State>(key(sessionID), (current) => {
        current.status = "cancelled"
        current.revision = (current.revision ?? 0) + 1
        current.updatedAt = Date.now()
      })
    })

    const observe = Effect.fn("Goal.observe")(function* (sessionID: SessionID, _text: string) {
      if (!(yield* get(sessionID))) return
      yield* storage.update<State>(key(sessionID), (current) => {
        // Steering already lives in session history. Keep only its revision here.
        current.revision = (current.revision ?? 0) + 1
        delete current.stopReason
        current.updatedAt = Date.now()
      })
    })

    const begin = Effect.fn("Goal.begin")(function* (sessionID: SessionID, parentID: MessageID, expected?: Token) {
      const goal = yield* get(sessionID)
      if (!goal) return expected === undefined
      if (
        expected &&
        goal.id === expected.id &&
        goal.parentID === parentID &&
        ["active", "completed", "blocked"].includes(goal.status)
      )
        return true
      if (
        expected &&
        (goal.status !== "active" || goal.id !== expected.id || (goal.revision ?? 0) !== expected.revision)
      )
        return false
      if (goal.status !== "active") return true
      const updated = yield* storage.update<State>(key(sessionID), (current) => {
        if (current.id !== goal.id || current.status !== "active") return
        if (expected && (current.revision ?? 0) !== expected.revision) return
        if (current.parentID === parentID) return
        if (current.maxIterations !== undefined && current.iteration >= current.maxIterations) {
          current.status = "budget_limited"
          current.stopReason = "User-selected turn budget reached."
          return
        }
        if (current.tokenBudget !== undefined && (current.tokensUsed ?? 0) >= current.tokenBudget) {
          current.status = "budget_limited"
          current.stopReason = "User-selected token budget reached."
          return
        }
        current.parentID = parentID
        current.iteration++
        current.updatedAt = Date.now()
      })
      return (
        expected === undefined ||
        (updated.id === expected.id && updated.status === "active" && (updated.revision ?? 0) === expected.revision)
      )
    })

    const account = Effect.fn("Goal.account")(function* (sessionID: SessionID, message: SessionV1.WithParts) {
      if (message.info.role !== "assistant") return
      const info = message.info
      const goal = yield* get(sessionID)
      if (!goal || goal.parentID !== info.parentID) return
      yield* storage.update<State>(key(sessionID), (current) => {
        if (
          current.id !== goal.id ||
          current.parentID !== info.parentID ||
          (current.accountedID && current.accountedID >= info.id)
        )
          return
        current.accountedID = info.id
        const steps = message.parts.filter((part) => part.type === "step-finish").map((part) => part.tokens)
        current.tokensUsed =
          (current.tokensUsed ?? 0) +
          (steps.length ? steps : [info.tokens]).reduce(
            (total, usage) =>
              total + usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write,
            0,
          )
        if (
          message.parts.some(
            (part) =>
              part.type === "tool" &&
              !["get_goal", "update_goal"].includes(part.tool) &&
              part.state.status === "completed",
          )
        )
          current.workParentID = info.parentID
        if (
          current.status === "active" &&
          current.tokenBudget !== undefined &&
          current.tokensUsed >= current.tokenBudget
        ) {
          current.status = "budget_limited"
          current.stopReason = "User-selected token budget reached."
        }
        current.updatedAt = Date.now()
      })
    })

    const continuation = Effect.fn("Goal.continuation")(function* (
      sessionID: SessionID,
      message: SessionV1.WithParts,
      automatic: boolean,
    ) {
      const goal = yield* get(sessionID)
      if (
        !goal ||
        goal.runtime !== 2 ||
        goal.status !== "active" ||
        message.info.role !== "assistant" ||
        message.info.error
      )
        return undefined
      const info = message.info
      const claimed = { value: false }
      const changed = yield* storage.update<State>(key(sessionID), (current) => {
        if (
          current.id !== goal.id ||
          current.status !== "active" ||
          current.continuedID === info.id ||
          current.parentID !== info.parentID
        )
          return
        if (automatic && current.workParentID !== info.parentID) {
          current.stopReason = "Waiting: automatic turn made no work tool call. Resume or send new input."
          return
        }
        if (current.maxIterations !== undefined && current.iteration >= current.maxIterations) {
          current.status = "budget_limited"
          current.stopReason = "User-selected turn budget reached."
          return
        }
        current.continuedID = info.id
        claimed.value = true
        delete current.stopReason
        current.updatedAt = Date.now()
      })
      if (!claimed.value || changed.id !== goal.id || changed.status !== "active" || changed.stopReason)
        return undefined
      return token(changed)
    })

    const update = Effect.fn("Goal.update")(function* (
      sessionID: SessionID,
      expected: Token,
      input: { status: "completed" | "blocked"; evidence: string; summary?: string },
    ) {
      if (!input.evidence.trim())
        return yield* new StateError({
          sessionID,
          reason: "missing_evidence",
          message: "Report the evidence checked or the concrete blocker.",
        })
      const goal = yield* get(sessionID)
      if (!goal || goal.id !== expected.id || (goal.revision ?? 0) !== expected.revision || goal.status !== "active")
        return yield* new StateError({
          sessionID,
          reason: "stale_update",
          message: "The goal changed. Read the current goal before reporting its result.",
        })
      const claimed = { value: false }
      const changed = yield* storage.update<State>(key(sessionID), (current) => {
        if (current.id !== expected.id || (current.revision ?? 0) !== expected.revision || current.status !== "active")
          return
        current.status = input.status
        claimed.value = true
        current.evidence = input.evidence
        current.summary = input.summary
        current.revision = expected.revision + 1
        current.updatedAt = Date.now()
      })
      if (!claimed.value)
        return yield* new StateError({
          sessionID,
          reason: "stale_update",
          message: "The goal changed while reporting its result.",
        })
      return changed
    })

    const prepare = Effect.fn("Goal.prepare")(function* (
      input: CommandInput,
      respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
      stop: (sessionID: SessionID) => Effect.Effect<void>,
    ) {
      const parsed = parseCommand(input.arguments)
      if (parsed.type === "error") return yield* respond(parsed.message)
      const existing = yield* get(input.sessionID)
      if (parsed.type === "status")
        return yield* respond(existing ? formatStatus(existing) : "No active goal for this session.")
      if (parsed.type === "pause" || parsed.type === "cancel" || parsed.type === "clear") {
        if (!existing) return yield* respond("No active goal for this session.")
        if (parsed.type === "pause") yield* pause(input.sessionID)
        else yield* cancel(input.sessionID)
        yield* stop(input.sessionID)
        if (parsed.type === "clear") {
          yield* storage.remove(key(input.sessionID))
          return yield* respond("Goal cleared.")
        }
        return yield* respond(formatStatus((yield* get(input.sessionID))!))
      }
      if (
        parsed.type === "start" &&
        existing &&
        !["completed", "cancelled", "failed"].includes(existing.status) &&
        !parsed.replace
      )
        return yield* respond("A goal already exists. Use /goal resume, /goal clear, or /goal replace <objective>.")
      if (parsed.type === "resume" && (!existing || ["completed", "cancelled", "failed"].includes(existing.status)))
        return yield* respond("No unfinished goal is available to resume.")
      if (parsed.type === "start" && existing) {
        yield* cancel(input.sessionID)
        yield* stop(input.sessionID)
      }
      if (parsed.type !== "start" && parsed.type !== "resume") return yield* respond("Unknown goal command.")
      const selected: State =
        parsed.type === "resume"
          ? {
              ...existing!,
              // Legacy records did not distinguish the invented default of 50 from
              // an explicit user limit. Do not silently renew that old default.
              maxIterations:
                parsed.maxIterations === undefined
                  ? existing!.runtime === 2
                    ? existing!.maxIterations
                    : existing!.maxIterations === 50
                      ? undefined
                      : existing!.maxIterations
                  : existing!.iteration + parsed.maxIterations,
              tokenBudget:
                parsed.tokenBudget === undefined
                  ? existing!.tokenBudget
                  : (existing!.tokensUsed ?? 0) + parsed.tokenBudget,
              runtime: 2,
              status: "active",
              revision: (existing!.revision ?? 0) + 1,
              stopReason: undefined,
              updatedAt: Date.now(),
            }
          : {
              id: ulid(),
              sessionID: input.sessionID,
              objective: parsed.objective,
              status: "active",
              runtime: 2,
              iteration: 0,
              revision: 0,
              startedAt: Date.now(),
              updatedAt: Date.now(),
              maxIterations: parsed.maxIterations,
              tokenBudget: parsed.tokenBudget,
              tokensUsed: 0,
              completionCriteria: [],
              plan: [],
              observations: [],
              failures: [],
              recentHashes: [],
              replanned: false,
            }
      if (
        (selected.maxIterations !== undefined && selected.iteration >= selected.maxIterations) ||
        (selected.tokenBudget !== undefined && (selected.tokensUsed ?? 0) >= selected.tokenBudget)
      )
        return yield* respond(
          "The user-selected budget is exhausted. Resume with --max-iterations N or --token-budget N to add a budget.",
        )
      yield* storage.write(key(input.sessionID), selected)
      return selected
    })
    const command: Interface["command"] = Effect.fn("Goal.command")(function* (input, run, respond, stop) {
      const selected = yield* commands.withPermit(prepare(input, respond, stop))
      if ("info" in selected) return selected
      yield* respond(`Goal active.\n${formatStatus(selected)}`)
      return yield* run({
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model ? Provider.parseModel(input.model) : undefined,
        variant: input.variant,
        parts: [
          {
            type: "text",
            text: selected.objective,
            synthetic: true,
            metadata: { goalWake: token(selected), goalObjective: selected.id },
          },
        ],
      })
    })
    return Service.of({ command, get, observe, pause, cancel, begin, account, continuation, update })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node] })
export * as Goal from "."
