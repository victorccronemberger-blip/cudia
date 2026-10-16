import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MessageID, SessionID } from "@/session/schema"
import { Cause, Effect, Fiber, Layer, Context, Option, Schema, Scope } from "effect"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import type { CommandInput, PromptInput } from "@/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { Image } from "@/image/image"
import { ulid } from "ulid"
import { InstanceState } from "@/effect/instance-state"
import { GoalStateControl } from "./state"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { isGoalControl } from "./control"

import { GoalPrompts } from "./prompts"

// --- Schemas ---

const GoalStatus = Schema.Literals(["active", "completed", "blocked", "paused", "cancelled", "failed"])

export class StateError extends Schema.TaggedErrorClass<StateError>()("Goal.StateError", {
  sessionID: SessionID,
  reason: Schema.Literals(["invalid_state", "session_mismatch"]),
  message: Schema.String,
}) {}

const GoalStep = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "failed", "skipped"]),
  attempts: Schema.Number,
})

const VerificationCriteriaItem = Schema.Struct({
  criterion: Schema.String,
  passed: Schema.Boolean,
  evidence: Schema.optional(Schema.String),
})

const VerificationResult = Schema.Struct({
  completed: Schema.Boolean,
  blocked: Schema.Boolean,
  criteria: Schema.Array(VerificationCriteriaItem),
  remainingWork: Schema.Array(Schema.String),
  recommendedNextAction: Schema.optional(Schema.String),
  blocker: Schema.optional(Schema.String),
})

const GoalState = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  objective: Schema.String,
  status: GoalStatus,
  iteration: Schema.Number,
  maxIterations: Schema.Number,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  completionCriteria: Schema.Array(Schema.String),
  plan: Schema.Array(GoalStep),
  observations: Schema.Array(Schema.String),
  failures: Schema.Array(
    Schema.Struct({
      iteration: Schema.Number,
      error: Schema.String,
    }),
  ),
  lastVerification: Schema.optional(VerificationResult),
  currentStep: Schema.optional(Schema.String),
  recentHashes: Schema.Array(Schema.String),
  replanned: Schema.Boolean,
  variant: Schema.optional(Schema.String),
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
  instructions: Schema.optional(Schema.Array(Schema.String)),
  latestEvidence: Schema.optional(
    Schema.Struct({ iteration: Schema.Number, text: Schema.String, messageID: MessageID }),
  ),
})

// Native types for mutable state (mirroring Schema.Schema.Type but mutable)
interface GoalState {
  id: string
  sessionID: SessionID
  objective: string
  status: "active" | "completed" | "blocked" | "paused" | "cancelled" | "failed"
  iteration: number
  maxIterations: number
  startedAt: number
  updatedAt: number
  completionCriteria: string[]
  plan: Array<{
    id: string
    description: string
    status: "pending" | "running" | "completed" | "failed" | "skipped"
    attempts: number
  }>
  observations: string[]
  failures: Array<{ iteration: number; error: string }>
  lastVerification: VerificationResult | undefined
  currentStep: string | undefined
  recentHashes: string[]
  replanned: boolean
  variant?: string
  model?: PromptInput["model"]
  instructions?: string[]
  latestEvidence?: { iteration: number; text: string; messageID: MessageID }
}

interface VerificationResult {
  completed: boolean
  blocked: boolean
  criteria: Array<{
    criterion: string
    passed: boolean
    evidence: string | undefined
  }>
  remainingWork: string[]
  recommendedNextAction: string | undefined
  blocker: string | undefined
}

// --- Verification JSON Schema for structured output ---

const VERIFICATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    completed: { type: "boolean" },
    blocked: { type: "boolean" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          passed: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["criterion", "passed"],
      },
    },
    remainingWork: { type: "array", items: { type: "string" } },
    recommendedNextAction: { type: "string" },
    blocker: { type: "string" },
  },
  required: ["completed", "blocked", "criteria", "remainingWork"],
}

const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    plan: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          status: { type: "string", enum: ["pending"] },
          attempts: { type: "integer", minimum: 0 },
        },
        required: ["description", "status", "attempts"],
      },
    },
  },
  required: ["criteria", "plan"],
}

// --- Constants ---

const DEFAULT_MAX_ITERATIONS = 50
const NO_PROGRESS_LIMIT = 3
const STORAGE_PREFIX = ["goal"] as const
const VERIFIER_AGENT = "verifier"
const PLANNER_AGENT = "goal-planner"

// --- Service ---

export interface Interface {
  readonly command: (
    input: CommandInput,
    run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
    respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
    stop: (sessionID: SessionID) => Effect.Effect<void>,
  ) => Effect.Effect<SessionV1.WithParts, unknown>
  readonly get: (sessionID: SessionID) => Effect.Effect<GoalState | undefined, unknown>
  readonly observe: (sessionID: SessionID, text: string) => Effect.Effect<void, unknown>
  readonly pause: (sessionID: SessionID) => Effect.Effect<void, unknown>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    const running = yield* InstanceState.make(
      Effect.fn("Goal.running")(function* () {
        const scope = yield* Scope.Scope
        const runs = new Map<
          SessionID,
          {
            target: SessionID
            stop: (sessionID: SessionID) => Effect.Effect<void>
            stopped: boolean
            fiber?: Fiber.Fiber<SessionV1.WithParts, unknown>
          }
        >()
        return { runs, scope }
      }),
    )

    // --- Persistence helpers ---

    const storageKey = (sessionID: SessionID) => [...STORAGE_PREFIX, sessionID] as unknown as string[]

    const save = Effect.fn("Goal.save")(function* (goal: GoalState) {
      const updated = yield* storage.update<GoalState>(storageKey(goal.sessionID), (current) => {
        const merged = GoalStateControl.merge(current, goal)
        if (merged === current) return
        Object.assign(current, merged, { updatedAt: Date.now() })
      })
      if (updated.id === goal.id) Object.assign(goal, updated)
      else goal.status = "cancelled"
    })

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      const saved = yield* storage.read<GoalState>(storageKey(sessionID)).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
      )
      if (Option.isNone(saved)) return undefined
      const goal = saved.value
      if (!Schema.is(GoalState)(goal))
        return yield* new StateError({
          sessionID,
          reason: "invalid_state",
          message: "Saved goal state is invalid and was preserved.",
        })
      if (goal.sessionID !== sessionID)
        return yield* new StateError({
          sessionID,
          reason: "session_mismatch",
          message: "Saved goal state belongs to another session and was preserved.",
        })
      return goal
    })

    // --- Hash for repetition detection ---

    function progressHash(goal: GoalState): string {
      const v = goal.lastVerification
      const criteriaStatus = v?.criteria.map((c) => `${c.criterion}:${c.passed}`).join("|") ?? ""
      const remaining = v?.remainingWork.join("|") ?? ""
      return [criteriaStatus, remaining].join("||")
    }

    function isNoProgress(goal: GoalState): boolean {
      const recent = goal.recentHashes
      if (recent.length < NO_PROGRESS_LIMIT) return false
      const last = recent[recent.length - 1]!
      return recent.slice(-NO_PROGRESS_LIMIT).every((h) => h === last)
    }

    function isComplete(goal: GoalState, verification: VerificationResult): boolean {
      return (
        verification.completed &&
        goal.completionCriteria.length > 0 &&
        goal.completionCriteria.every(
          (criterion) => verification.criteria.find((item) => item.criterion === criterion)?.passed === true,
        )
      )
    }

    // --- Structured output format ---

    function verificationFormat(): Schema.Schema.Type<typeof SessionV1.Format> {
      return new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema: VERIFICATION_JSON_SCHEMA,
        retryCount: 2,
      })
    }

    function planFormat(): Schema.Schema.Type<typeof SessionV1.Format> {
      return new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema: PLAN_JSON_SCHEMA,
        retryCount: 2,
      })
    }

    // --- Verifier invocation ---

    const createChild = Effect.fn("Goal.createChild")(function* (parentID: SessionID, agent: string) {
      const parent = yield* sessions.get(parentID)
      const subagent = yield* agents.get(agent)
      if (!subagent) return yield* Effect.die(new Error(`Agent not found: ${agent}`))
      const permission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent,
      })
      return yield* sessions.create({ parentID, agent, permission })
    })

    const runVerifier = Effect.fn("Goal.runVerifier")(function* (
      parentSessionID: SessionID,
      promptText: string,
      model: PromptInput["model"],
      variant: string | undefined,
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
    ) {
      const child = yield* createChild(parentSessionID, VERIFIER_AGENT)
      const result = yield* run({
        sessionID: child.id,
        agent: VERIFIER_AGENT,
        model,
        variant,
        parts: [{ type: "text", text: promptText }],
        format: verificationFormat(),
      })
      if (result.info.role !== "assistant" || !result.info.structured) {
        return undefined
      }
      return result.info.structured as VerificationResult
    })

    // --- Plan invocation ---

    const runPlanning = Effect.fn("Goal.runPlanning")(function* (
      parentSessionID: SessionID,
      objective: string,
      model: PromptInput["model"],
      variant: string | undefined,
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
    ) {
      const child = yield* createChild(parentSessionID, PLANNER_AGENT)
      const result = yield* run({
        sessionID: child.id,
        agent: PLANNER_AGENT,
        model,
        variant,
        parts: [{ type: "text", text: GoalPrompts.plan(objective) }],
        format: planFormat(),
      })
      if (result.info.role !== "assistant" || !result.info.structured) {
        return undefined
      }
      const data = result.info.structured as { criteria?: string[]; plan?: GoalState["plan"] }
      if (
        !data.criteria?.length ||
        !data.plan?.length ||
        !data.criteria.every((criterion) => typeof criterion === "string" && criterion.trim())
      )
        return undefined
      return { criteria: data.criteria, plan: data.plan }
    })

    // --- Status formatter ---

    function formatStatus(goal: GoalState): string {
      const stepLines = goal.plan.map((s) => {
        const icon = s.status === "completed" ? "✓" : s.status === "running" ? "→" : s.status === "failed" ? "✗" : "○"
        return `${icon} ${s.description}`
      })
      const v = goal.lastVerification
      const criteriaLines = v
        ? v.criteria.map((c) => `${c.passed ? "✓" : "✗"} ${c.criterion}`)
        : goal.completionCriteria.map((c) => `? ${c}`)
      return [
        `Goal: ${goal.objective}`,
        ``,
        `Status: ${goal.status}`,
        `Iteration: ${goal.iteration}/${goal.maxIterations}`,
        ``,
        `Plan:`,
        ...stepLines,
        ``,
        `Criteria:`,
        ...criteriaLines,
        goal.currentStep ? [``, `Current step: ${goal.currentStep}`] : [],
        goal.observations.length > 0
          ? [``, `Recent observations:`, ...goal.observations.slice(-5).map((o) => `- ${o}`)]
          : [],
        goal.failures.length > 0
          ? [``, `Failures:`, ...goal.failures.slice(-3).map((f) => `- iter ${f.iteration}: ${f.error}`)]
          : [],
      ]
        .flat()
        .join("\n")
    }

    // --- Subcommand router ---

    const stopRunning = Effect.fn("Goal.stopRunning")(function* (sessionID: SessionID) {
      const { runs } = yield* InstanceState.get(running)
      const current = runs.get(sessionID)
      if (!current) return
      current.stopped = true
      const target = current.target
      yield* current.stop(target)
      if (current.target !== target) yield* current.stop(current.target)
      if (current.fiber) yield* Fiber.interrupt(current.fiber)
      if (runs.get(sessionID) === current) runs.delete(sessionID)
    })

    const managedStart = Effect.fn("Goal.managedStart")(function* (
      input: CommandInput,
      objective: string,
      maxIterations: number,
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
      respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
      stop: (sessionID: SessionID) => Effect.Effect<void>,
      existing?: GoalState,
    ) {
      const { runs, scope } = yield* InstanceState.get(running)
      if (runs.has(input.sessionID)) return yield* respond("A goal loop is already running for this session.")
      const current = {
        target: input.sessionID,
        stop,
        stopped: false,
        fiber: undefined as Fiber.Fiber<SessionV1.WithParts, unknown> | undefined,
      }
      runs.set(input.sessionID, current)
      current.fiber = yield* start(
        input,
        objective,
        maxIterations,
        (prompt) => {
          current.target = prompt.sessionID
          if (current.stopped) return Effect.interrupt
          return run(prompt)
        },
        respond,
        existing,
      ).pipe(
        Effect.interruptible,
        Effect.onExit(() =>
          Effect.sync(() => {
            if (runs.get(input.sessionID) === current) runs.delete(input.sessionID)
          }),
        ),
        Effect.forkIn(scope),
      )
      if (current.stopped) yield* Fiber.interrupt(current.fiber)
      return yield* Fiber.join(current.fiber)
    })

    const command = Effect.fn("Goal.command")(function* (
      input: CommandInput,
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
      respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
      stop: (sessionID: SessionID) => Effect.Effect<void>,
    ) {
      const args = input.arguments.trim()
      const reply = respond

      // Subcommand: status
      if (args === "status" || args.startsWith("status ")) {
        const goal = yield* load(input.sessionID)
        if (!goal) return yield* reply("No active goal for this session.")
        return yield* reply(formatStatus(goal))
      }

      if (args === "pause") {
        const goal = yield* load(input.sessionID)
        if (!goal) return yield* reply("No active goal to pause.")
        if (goal.status !== "active") return yield* reply(`Goal is already ${goal.status}.\n\n${formatStatus(goal)}`)
        yield* pause(input.sessionID)
        const paused = yield* load(input.sessionID)
        return yield* reply(`Goal paused.\n\n${formatStatus(paused ?? goal)}`)
      }

      const resume = args.match(/^(?:resume|continue)(?:\s+--max-iterations\s+(\d+))?$/)
      if (resume) {
        const goal = yield* load(input.sessionID)
        if (!goal) return yield* reply("No goal is available to resume.")
        if (goal.status === "completed" || goal.status === "cancelled" || goal.status === "failed") {
          return yield* reply(`Goal cannot be resumed because it is ${goal.status}.`)
        }
        if ((yield* InstanceState.get(running)).runs.has(input.sessionID)) {
          return yield* reply(`Goal is already running.\n\n${formatStatus(goal)}`)
        }
        const limit = GoalStateControl.resumeLimit(
          goal.iteration,
          goal.maxIterations,
          resume[1] === undefined ? undefined : Number.parseInt(resume[1], 10),
        )
        if (limit === undefined) {
          return yield* reply(
            "Iteration limit reached. Use `/goal resume --max-iterations N` to authorize N additional iterations (1-500).",
          )
        }
        const resumed = yield* storage.update<GoalState>(storageKey(input.sessionID), (current) => {
          if (current.id !== goal.id || !["active", "paused", "blocked"].includes(current.status)) return
          current.status = "active"
          current.maxIterations = limit
          current.recentHashes = []
          current.replanned = false
          current.variant = input.variant ?? current.variant
          current.updatedAt = Date.now()
        })
        if (resumed.id !== goal.id || resumed.status !== "active")
          return yield* reply("The goal changed; resume the current goal explicitly.")
        return yield* managedStart(input, resumed.objective, resumed.maxIterations, run, respond, stop, resumed)
      }

      // Subcommand: cancel
      if (args === "cancel" || args.startsWith("cancel ")) {
        const goal = yield* load(input.sessionID)
        if (!goal) return yield* reply("No active goal to cancel.")
        yield* cancel(input.sessionID)
        const cancelled = yield* load(input.sessionID)
        return yield* reply(`Goal ${cancelled?.status ?? goal.status}.\n\n${formatStatus(cancelled ?? goal)}`)
      }

      // New goal — parse flags
      const replace = args.startsWith("replace ")
      let objective = replace ? args.slice("replace ".length).trim() : args
      let maxIterations = DEFAULT_MAX_ITERATIONS
      const maxMatch = objective.match(/--max-iterations\s+(\d+)/)
      if (maxMatch) {
        maxIterations = Math.max(1, Math.min(Number.parseInt(maxMatch[1]!, 10), 500))
        objective = objective.replace(/--max-iterations\s+\d+/, "").trim()
      }

      if (!objective) {
        return yield* reply("Usage: /goal <objective> [--max-iterations N]")
      }

      const existing = yield* load(input.sessionID)
      if (existing?.status === "active" && !replace) {
        const recoverable =
          existing.iteration === 0 && (existing.plan.length === 0 || existing.completionCriteria.length === 0)
        if (recoverable && existing.objective === objective) {
          return yield* managedStart(input, existing.objective, existing.maxIterations, run, respond, stop, existing)
        }
        return yield* reply(
          "A goal is already active. Use `/goal pause`, `/goal cancel`, or `/goal replace <objective>`.",
        )
      }
      if (existing?.status === "paused" && existing.objective === objective && !replace) {
        if (GoalStateControl.resumeLimit(existing.iteration, existing.maxIterations) === undefined) {
          return yield* reply(
            "Iteration limit reached. Use `/goal resume --max-iterations N` to authorize additional iterations.",
          )
        }
        const resumed = yield* storage.update<GoalState>(storageKey(input.sessionID), (current) => {
          if (current.id !== existing.id || current.status !== "paused") return
          current.status = "active"
          current.recentHashes = []
          current.replanned = false
          current.updatedAt = Date.now()
        })
        if (resumed.id !== existing.id || resumed.status !== "active") {
          return yield* reply("The goal changed; resume the current goal explicitly.")
        }
        return yield* managedStart(input, resumed.objective, resumed.maxIterations, run, respond, stop, resumed)
      }
      if (existing?.status === "active" && replace) yield* pause(input.sessionID)
      return yield* managedStart(input, objective, maxIterations, run, respond, stop)
    })

    // --- Main goal loop ---

    const start = Effect.fn("Goal.start")(function* (
      input: CommandInput,
      objective: string,
      maxIterations: number,
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
      respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
      existing?: GoalState,
    ) {
      // Initialize goal state
      const goal: GoalState = existing ?? {
        id: ulid(),
        sessionID: input.sessionID,
        objective,
        status: "active",
        iteration: 0,
        maxIterations,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completionCriteria: [],
        plan: [],
        observations: [],
        failures: [],
        recentHashes: [],
        replanned: false,
        variant: input.variant,
        lastVerification: undefined,
        currentStep: undefined,
      }
      if (!existing) yield* storage.write(storageKey(goal.sessionID), goal)

      // Phase 1: Planning — extract criteria + plan via verifier
      const needsPlanning = goal.plan.length === 0 || goal.completionCriteria.length === 0
      if (needsPlanning) {
        yield* respond(
          existing
            ? `Recovering interrupted goal. Planning: ${goal.objective}`
            : `Goal accepted. Planning: ${goal.objective}`,
        )
      }
      const latestUser = yield* sessions.findMessage(
        input.sessionID,
        (message) => !isGoalControl(message) && message.info.role === "user" && !!message.info.model,
      )
      const model = input.model
        ? Provider.parseModel(input.model)
        : (goal.model ??
          (Option.isSome(latestUser) && latestUser.value.info.role === "user"
            ? latestUser.value.info.model
            : undefined))
      goal.model = model
      goal.variant ??=
        Option.isSome(latestUser) && latestUser.value.info.role === "user"
          ? latestUser.value.info.model.variant
          : undefined
      yield* save(goal)
      const planData = needsPlanning
        ? yield* runPlanning(input.sessionID, objective, model, goal.variant, run).pipe(
            Effect.catchCause(
              (cause): Effect.Effect<{ criteria: string[]; plan: GoalState["plan"] } | undefined, unknown> => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
                return Effect.gen(function* () {
                  goal.failures.push({ iteration: 0, error: `Planning failed: ${Cause.pretty(cause).slice(0, 1000)}` })
                  yield* save(goal)
                  return undefined
                })
              },
            ),
          )
        : undefined
      if (planData) {
        goal.completionCriteria = planData.criteria
        goal.plan = planData.plan.map((s) => ({
          ...s,
          id: ulid(),
          status: (s.status as GoalState["plan"][number]["status"]) ?? "pending",
          attempts: s.attempts ?? 0,
        }))
      } else if (needsPlanning) {
        goal.completionCriteria = [objective]
        goal.plan = [{ id: ulid(), description: objective, status: "running", attempts: 0 }]
      }
      if (needsPlanning) {
        yield* save(goal)
        if (goal.status === "active") {
          yield* respond(
            planData
              ? `Goal planned: ${goal.completionCriteria.length} criteria, ${goal.plan.length} steps. Starting autonomous execution.`
              : `Planner failed to return a plan. Continuing with a fallback plan so the goal does not remain stuck.`,
          )
        }
      }

      let lastInputID: MessageID | undefined
      let deliveredUpdates = 0
      let deliveredVerification: VerificationResult | undefined
      let forceReplan = false

      // Phase 3: Loop
      while (goal.status === "active" && goal.iteration < goal.maxIterations) {
        // Check cancellation between iterations
        const current = yield* load(input.sessionID)
        if (current?.id !== goal.id || current?.status !== "active") {
          goal.status = current?.id === goal.id ? current.status : "cancelled"
          break
        }
        Object.assign(goal, GoalStateControl.merge(current, goal))
        // A durable input is the delivery boundary, never a persisted cursor.
        // Compaction after that boundary requires a fresh objective/criteria anchor.
        const boundary = lastInputID
          ? yield* sessions.findMessage(
              input.sessionID,
              (message) =>
                message.info.id === lastInputID ||
                (message.info.role === "assistant" && message.info.summary === true) ||
                message.parts.some((part) => part.type === "compaction"),
            )
          : Option.none<SessionV1.WithParts>()
        const anchor = Option.isNone(boundary) || boundary.value.info.id !== lastInputID
        const updates = GoalStateControl.userUpdates(goal.observations, goal.instructions)
        const newUpdates = anchor ? updates : updates.slice(deliveredUpdates)
        const sentVerification = goal.lastVerification
        const currentMessage = anchor
          ? GoalPrompts.initial(goal, newUpdates, sentVerification)
          : GoalPrompts.continuation(goal, newUpdates, sentVerification, deliveredVerification, forceReplan)
        const messageID = MessageID.ascending()

        goal.iteration++
        const step = goal.plan.find((step) => step.status === "running" || step.status === "pending")
        goal.currentStep = step?.description
        if (step) {
          goal.plan = goal.plan.map((item) =>
            item.id === step.id ? { ...item, status: "running", attempts: item.attempts + 1 } : item,
          )
        }
        yield* save(goal)
        if (goal.status !== "active") break
        yield* respond(
          `Goal iteration ${goal.iteration}/${goal.maxIterations} — executing: ${goal.currentStep ?? goal.objective}`,
        )

        // Run agent turn on the parent session
        const agentResult = yield* run({
          sessionID: input.sessionID,
          messageID,
          agent: input.agent,
          model,
          variant: goal.variant,
          parts: [{ type: "text", text: currentMessage }],
        }).pipe(
          Effect.catchCause((cause): Effect.Effect<SessionV1.WithParts | undefined, unknown> => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            return Effect.gen(function* () {
              goal.failures.push({ iteration: goal.iteration, error: Cause.pretty(cause).slice(0, 1000) })
              yield* save(goal)
              return undefined
            })
          }),
        )

        if (
          agentResult?.info.role === "assistant" &&
          !agentResult.info.error &&
          agentResult.info.finish !== "error" &&
          Option.isSome(
            yield* sessions.findMessage(
              input.sessionID,
              (message) => message.info.role === "user" && message.info.id === messageID,
            ),
          )
        ) {
          lastInputID = messageID
          deliveredUpdates = updates.length
          deliveredVerification = sentVerification
        } else lastInputID = undefined

        // Capture observations from agent output
        const textParts = agentResult?.parts.filter((p) => p.type === "text") ?? []
        const agentText = textParts.map((p) => p.text).join("\n")
        if (agentResult) {
          goal.latestEvidence = { iteration: goal.iteration, text: agentText, messageID: agentResult.info.id }
          goal.observations.push(`[${goal.iteration}] Executor report: ${agentResult.info.id}`)
          if (goal.observations.length > 50) goal.observations = goal.observations.slice(-30)
        }

        // Check cancellation after agent turn
        const afterAgent = yield* load(input.sessionID)
        if (afterAgent?.id !== goal.id || afterAgent?.status !== "active") {
          goal.status = afterAgent?.id === goal.id ? afterAgent.status : "cancelled"
          break
        }
        Object.assign(goal, GoalStateControl.merge(afterAgent, goal))

        // Check for agent-reported errors (finish === "error")
        if (agentResult?.info.role === "assistant" && agentResult.info.error) {
          const errorMsg =
            typeof agentResult.info.error === "object" &&
            agentResult.info.error !== null &&
            "message" in agentResult.info.error
              ? String((agentResult.info.error as Record<string, unknown>).message)
              : String(agentResult.info.error)
          goal.failures.push({ iteration: goal.iteration, error: errorMsg })
          yield* save(goal)
          // Don't abort — let verifier decide if this is blocking
        }

        // Phase 4: Verification via independent verifier
        yield* save(goal)
        if (goal.status !== "active") break
        const verificationUpdates = JSON.stringify(GoalStateControl.userUpdates(goal.observations, goal.instructions))
        yield* respond(`Goal iteration ${goal.iteration}/${goal.maxIterations} — verifying progress...`)
        const verification = yield* runVerifier(
          input.sessionID,
          GoalPrompts.verify(goal, GoalStateControl.userUpdates(goal.observations, goal.instructions)),
          model,
          goal.variant,
          run,
        ).pipe(
          Effect.catchCause((cause): Effect.Effect<VerificationResult | undefined, unknown> => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            return Effect.gen(function* () {
              goal.failures.push({
                iteration: goal.iteration,
                error: `Verification failed: ${Cause.pretty(cause).slice(0, 1000)}`,
              })
              yield* save(goal)
              return undefined
            })
          }),
        )
        if (verification) {
          goal.lastVerification = verification
        } else {
          goal.lastVerification = {
            completed: false,
            blocked: false,
            criteria: goal.completionCriteria.map((c) => ({
              criterion: c,
              passed: false,
              evidence: "Verification failed",
            })),
            remainingWork: goal.completionCriteria,
            recommendedNextAction: undefined,
            blocker: undefined,
          }
          if (!goal.failures.some((failure) => failure.iteration === goal.iteration)) {
            goal.failures.push({ iteration: goal.iteration, error: "Verifier did not return structured output" })
          }
        }
        yield* save(goal)
        if (goal.status !== "active") break
        if (
          JSON.stringify(GoalStateControl.userUpdates(goal.observations, goal.instructions)) !== verificationUpdates
        ) {
          goal.lastVerification = undefined
          yield* save(goal)
          continue
        }

        const passed = goal.lastVerification.criteria.filter((criterion) => criterion.passed).length
        yield* respond(
          goal.lastVerification.completed
            ? `Goal iteration ${goal.iteration}/${goal.maxIterations} — verification passed (${passed}/${goal.lastVerification.criteria.length} criteria).`
            : `Goal iteration ${goal.iteration}/${goal.maxIterations} — verification: ${passed}/${goal.lastVerification.criteria.length} criteria passed. Continuing.`,
        )

        // Check completion
        if (goal.lastVerification && isComplete(goal, goal.lastVerification)) {
          goal.status = "completed"
          // Mark all plan steps as completed
          goal.plan = goal.plan.map((s) => (s.status !== "skipped" ? { ...s, status: "completed" as const } : s))
          yield* save(goal)
          if (goal.status === "completed") break
          continue
        }

        // Check blocked
        if (goal.lastVerification?.blocked) {
          goal.status = "blocked"
          yield* save(goal)
          break
        }

        // Repetition detection
        const hash = progressHash(goal)
        goal.recentHashes.push(hash)
        if (goal.recentHashes.length > 20) goal.recentHashes = goal.recentHashes.slice(-10)

        if (forceReplan && isNoProgress(goal)) {
          // Still no progress after forced replan → block
          goal.status = "blocked"
          goal.observations.push("Blocked: no progress after forced replan")
          yield* save(goal)
          break
        }

        if (isNoProgress(goal)) {
          forceReplan = true
          goal.replanned = true
          goal.observations.push("No progress detected — forcing replan on next iteration")
          yield* save(goal)
        } else {
          forceReplan = false
        }
        yield* save(goal)
      }

      // Hit iteration limit while still active
      if (goal.status === "active" && goal.iteration >= goal.maxIterations) {
        goal.status = "blocked"
        goal.observations.push(`Reached iteration limit (${goal.maxIterations})`)
        yield* save(goal)
      }

      // Final summary — inject as a synthetic message
      const summaryLines = [
        goal.status === "completed"
          ? `[GOAL COMPLETE — ${goal.iteration} iterations]`
          : goal.status === "blocked"
            ? `[GOAL BLOCKED — ${goal.iteration} iterations]`
            : goal.status === "cancelled"
              ? `[GOAL CANCELLED — ${goal.iteration} iterations]`
              : `[GOAL ${goal.status.toUpperCase()} — ${goal.iteration} iterations]`,
        "",
        "Verified criteria:",
        ...(goal.lastVerification?.criteria.map((c) => `${c.passed ? "✓" : "✗"} ${c.criterion}`) ?? []),
      ]
      if (goal.status === "blocked" && goal.lastVerification?.blocker) {
        summaryLines.push("", `Blocker: ${goal.lastVerification.blocker}`)
      }
      if (goal.status === "blocked" && goal.iteration >= goal.maxIterations) {
        summaryLines.push("", `Reason: iteration limit reached (${goal.maxIterations})`)
      }

      return yield* respond(summaryLines.join("\n"))
    })

    // --- Control changes are atomic and interrupt whichever session is active. ---

    const pause = Effect.fn("Goal.pause")(function* (sessionID: SessionID) {
      if (yield* load(sessionID)) {
        yield* storage.update<GoalState>(storageKey(sessionID), (current) => {
          if (current.status !== "active") return
          current.status = "paused"
          current.updatedAt = Date.now()
        })
      }
      yield* stopRunning(sessionID)
    })

    const cancel = Effect.fn("Goal.cancel")(function* (sessionID: SessionID) {
      if (!(yield* load(sessionID))) return
      yield* storage.update<GoalState>(storageKey(sessionID), (current) => {
        if (!["active", "paused", "blocked"].includes(current.status)) return
        current.status = "cancelled"
        current.updatedAt = Date.now()
      })
      yield* stopRunning(sessionID)
    })

    const observe = Effect.fn("Goal.observe")(function* (sessionID: SessionID, text: string) {
      if (!(yield* load(sessionID))) return
      yield* storage.update<GoalState>(storageKey(sessionID), (current) => {
        if (current.status !== "active") return
        current.instructions = [...GoalStateControl.instructionTexts(current.observations, current.instructions), text]
        current.observations = [...current.observations, `[user] ${text}`].slice(-30)
        current.replanned = true
        current.updatedAt = Date.now()
      })
    })

    // --- Get ---

    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      return yield* load(sessionID)
    })

    return Service.of({ command, get, observe, pause, cancel })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Storage.node, Session.node, Agent.node],
})

export * as Goal from "./index"
