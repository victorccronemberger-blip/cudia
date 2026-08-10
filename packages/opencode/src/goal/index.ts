import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "@/session/schema"
import { Cause, Effect, Layer, Context, Option, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import type { CommandInput, PromptInput } from "@/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { Image } from "@/image/image"
import { ulid } from "ulid"

// --- Schemas ---

const GoalStatus = Schema.Literals(["active", "completed", "blocked", "paused", "cancelled", "failed"])

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
      items: { type: "string" },
    },
    plan: {
      type: "array",
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
  ) => Effect.Effect<SessionV1.WithParts, unknown>
  readonly get: (sessionID: SessionID) => Effect.Effect<GoalState | undefined, unknown>
  readonly observe: (sessionID: SessionID, text: string) => Effect.Effect<void, unknown>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const sessions = yield* Session.Service

    // --- Persistence helpers ---

    const storageKey = (sessionID: SessionID) => [...STORAGE_PREFIX, sessionID] as unknown as string[]

    const save = Effect.fn("Goal.save")(function* (goal: GoalState) {
      const updated = { ...goal, updatedAt: Date.now() }
      yield* storage.write(storageKey(goal.sessionID), updated)
    })

    const load = Effect.fn("Goal.load")(function* (sessionID: SessionID) {
      return yield* storage
        .read<GoalState>(storageKey(sessionID))
        .pipe(Effect.catch(() => Effect.succeed(undefined as GoalState | undefined)))
    })

    const pauseInterrupted = Effect.fn("Goal.pauseInterrupted")(function* (goal: GoalState, observation: string) {
      const current = yield* load(goal.sessionID)
      if (!current || current.id !== goal.id || current.status !== "active") return
      yield* save({
        ...current,
        status: "paused",
        observations: [...current.observations, observation].slice(-30),
      })
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
        goal.completionCriteria.every(
          (criterion) => verification.criteria.find((item) => item.criterion === criterion)?.passed === true,
        )
      )
    }

    // --- Prompt builders ---

    function planPrompt(objective: string): string {
      return [
        `You are operating inside an autonomous goal loop.`,
        `Given this objective, determine the completion criteria and an initial plan.`,
        `Objective: ${objective}`,
        ``,
        `Return a JSON object with:`,
        `- "criteria": array of strings, each a verifiable completion criterion (3-8 items).`,
        `- "plan": array of steps, each with "description", "status": "pending", "attempts": 0. Keep it to 3-8 high-level steps.`,
        ``,
        `Criteria must be objectively verifiable: test pass, file exists, typecheck clean, etc.`,
        `Do NOT include vague criteria like "implementation is good".`,
      ].join("\n")
    }

    function firstMessage(goal: GoalState): string {
      const criteriaList = goal.completionCriteria.map((c) => `- ${c}`).join("\n")
      const planList = goal.plan.map((s, i) => `${i + 1}. ${s.description} (${s.status})`).join("\n")
      return [
        `[GOAL LOOP — iteration 0/${goal.maxIterations}]`,
        ``,
        `## Objective`,
        goal.objective,
        ``,
        `## Completion Criteria`,
        criteriaList,
        ``,
        `## Initial Plan`,
        planList,
        ``,
        `You are inside an autonomous goal loop. The harness will verify your progress after this turn using an independent verifier.`,
        `Work toward satisfying every criterion. After each action, compare the current state against the goal and continue.`,
        `Only mark yourself done when every criterion would pass independent verification.`,
      ].join("\n")
    }

    function continuationMessage(goal: GoalState, verification: VerificationResult, forceReplan: boolean): string {
      const criteriaTable = verification.criteria
        .map((c) => `${c.passed ? "✓" : "✗"} ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ""}`)
        .join("\n")
      const remaining = verification.remainingWork.join("\n")
      const next = verification.recommendedNextAction
        ? `\nRecommended next action: ${verification.recommendedNextAction}`
        : ""
      const updates = goal.observations
        .filter((observation) => observation.startsWith("[user]"))
        .slice(-5)
        .map((observation) => `- ${observation.slice("[user] ".length)}`)

      const replanBlock = forceReplan
        ? [
            ``,
            `## FORCE REPLAN`,
            `Your recent iterations are repeating without measurable progress.`,
            `Stop what you are doing. Reassess the situation from scratch and try a fundamentally different approach.`,
          ].join("\n")
        : ""

      return [
        `[GOAL LOOP — iteration ${goal.iteration}/${goal.maxIterations}]`,
        ``,
        `## Verification Result`,
        criteriaTable,
        ``,
        `## Remaining Work`,
        remaining,
        next,
        ...(updates.length ? ["", "## User Updates", ...updates] : []),
        replanBlock,
        ``,
        `Continue working toward the completion criteria.`,
      ].join("\n")
    }

    function verifyPrompt(goal: GoalState): string {
      const criteriaList = goal.completionCriteria.map((c) => `- ${c}`).join("\n")
      return [
        `Objective: ${goal.objective}`,
        ``,
        `Completion Criteria:`,
        criteriaList,
        ``,
        `Iteration: ${goal.iteration}`,
        ``,
        `Evaluate each criterion against the actual state of the repository using tools.`,
        `Do not trust claims — run tests, read files, inspect diffs, check exit codes.`,
        `A criterion passes only with positive evidence.`,
        ``,
        `Observations from this iteration:`,
        ...goal.observations.slice(-10).map((o) => `- ${o}`),
      ].join("\n")
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

    const runVerifier = Effect.fn("Goal.runVerifier")(function* (
      parentSessionID: SessionID,
      promptText: string,
      model: PromptInput["model"],
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
    ) {
      const child = yield* sessions.create({ parentID: parentSessionID, agent: VERIFIER_AGENT })
      const result = yield* run({
        sessionID: child.id,
        agent: VERIFIER_AGENT,
        model,
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
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
    ) {
      const child = yield* sessions.create({ parentID: parentSessionID, agent: PLANNER_AGENT })
      const result = yield* run({
        sessionID: child.id,
        agent: PLANNER_AGENT,
        model,
        parts: [{ type: "text", text: planPrompt(objective) }],
        format: planFormat(),
      })
      if (result.info.role !== "assistant" || !result.info.structured) {
        return undefined
      }
      return result.info.structured as { criteria: string[]; plan: GoalState["plan"] }
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

    const command = Effect.fn("Goal.command")(function* (
      input: CommandInput,
      run: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
      respond: (text: string) => Effect.Effect<SessionV1.WithParts, unknown>,
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
        const paused = { ...goal, status: "paused" as const }
        yield* save(paused)
        return yield* reply(`Goal paused.\n\n${formatStatus(paused)}`)
      }

      if (args === "resume" || args === "continue") {
        const goal = yield* load(input.sessionID)
        if (!goal) return yield* reply("No goal is available to resume.")
        if (goal.status === "completed" || goal.status === "cancelled" || goal.status === "failed") {
          return yield* reply(`Goal cannot be resumed because it is ${goal.status}.`)
        }
        const resumed = { ...goal, status: "active" as const }
        yield* save(resumed)
        return yield* start(input, resumed.objective, resumed.maxIterations, run, respond, resumed)
      }

      // Subcommand: cancel
      if (args === "cancel" || args.startsWith("cancel ")) {
        const goal = yield* load(input.sessionID)
        if (!goal) return yield* reply("No active goal to cancel.")
        yield* cancel(input.sessionID)
        return yield* reply(`Goal cancelled.\n\n${formatStatus({ ...goal, status: "cancelled" })}`)
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
          return yield* start(input, existing.objective, existing.maxIterations, run, respond, existing)
        }
        return yield* reply(
          "A goal is already active. Use `/goal pause`, `/goal cancel`, or `/goal replace <objective>`.",
        )
      }
      if (existing?.status === "paused" && existing.objective === objective && !replace) {
        const resumed = { ...existing, status: "active" as const }
        yield* save(resumed)
        return yield* start(input, resumed.objective, resumed.maxIterations, run, respond, resumed)
      }
      if (existing?.status === "active" && replace) yield* save({ ...existing, status: "paused" })
      return yield* start(input, objective, maxIterations, run, respond)
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
        lastVerification: undefined,
        currentStep: undefined,
      }
      if (!existing) yield* save(goal)

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
        (message) => message.info.role === "user" && !!message.info.model,
      )
      const model = input.model
        ? Provider.parseModel(input.model)
        : Option.isSome(latestUser) && latestUser.value.info.role === "user"
          ? latestUser.value.info.model
          : undefined
      const planData = needsPlanning
        ? yield* runPlanning(input.sessionID, objective, model, run).pipe(
            Effect.onInterrupt(() => pauseInterrupted(goal, "Planning was interrupted; goal can be resumed.")),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              return Effect.gen(function* () {
                goal.failures.push({ iteration: 0, error: `Planning failed: ${Cause.pretty(cause).slice(0, 1000)}` })
                yield* save(goal)
                return undefined
              })
            }),
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
        yield* respond(
          planData
            ? `Goal planned: ${goal.completionCriteria.length} criteria, ${goal.plan.length} steps. Starting autonomous execution.`
            : `Planner failed to return a plan. Continuing with a fallback plan so the goal does not remain stuck.`,
        )
      }

      // Phase 2: First agent turn
      let currentMessage = goal.lastVerification
        ? continuationMessage(goal, goal.lastVerification, goal.replanned)
        : firstMessage(goal)
      let forceReplan = false

      // Phase 3: Loop
      while (goal.status === "active" && goal.iteration < goal.maxIterations) {
        // Check cancellation between iterations
        const current = yield* load(input.sessionID)
        if (current?.id !== goal.id || current?.status !== "active") {
          goal.status = current?.status ?? "cancelled"
          yield* save(goal)
          break
        }

        goal.iteration++
        const step = goal.plan.find((step) => step.status === "running" || step.status === "pending")
        goal.currentStep = step?.description
        if (step) {
          goal.plan = goal.plan.map((item) =>
            item.id === step.id ? { ...item, status: "running", attempts: item.attempts + 1 } : item,
          )
        }
        yield* save(goal)
        yield* respond(
          `Goal iteration ${goal.iteration}/${goal.maxIterations} — executing: ${goal.currentStep ?? goal.objective}`,
        )

        // Run agent turn on the parent session
        const agentResult = yield* run({
          sessionID: input.sessionID,
          agent: input.agent,
          parts: [{ type: "text", text: currentMessage }],
        }).pipe(
          Effect.onInterrupt(() => pauseInterrupted(goal, "Agent execution was interrupted; goal can be resumed.")),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            return Effect.gen(function* () {
              goal.failures.push({ iteration: goal.iteration, error: Cause.pretty(cause).slice(0, 1000) })
              yield* save(goal)
              return undefined
            })
          }),
        )

        // Capture observations from agent output
        const textParts = agentResult?.parts.filter((p) => p.type === "text") ?? []
        const agentText = textParts.map((p) => p.text).join("\n")
        if (agentText.length > 0 && agentText.length < 2000) {
          goal.observations.push(`[${goal.iteration}] ${agentText.slice(0, 500)}`)
          if (goal.observations.length > 50) goal.observations = goal.observations.slice(-30)
        }

        // Check cancellation after agent turn
        const afterAgent = yield* load(input.sessionID)
        if (afterAgent?.id !== goal.id || afterAgent?.status !== "active") {
          goal.status = afterAgent?.status ?? "cancelled"
          yield* save(goal)
          break
        }

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
        yield* respond(`Goal iteration ${goal.iteration}/${goal.maxIterations} — verifying repository state...`)
        const verification = yield* runVerifier(input.sessionID, verifyPrompt(goal), model, run).pipe(
          Effect.onInterrupt(() => pauseInterrupted(goal, "Verification was interrupted; goal can be resumed.")),
          Effect.catchCause((cause) => {
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
          break
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

        // Prepare continuation message
        currentMessage = continuationMessage(goal, goal.lastVerification, forceReplan)
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

    // --- Cancel ---

    const cancel = Effect.fn("Goal.cancel")(function* (sessionID: SessionID) {
      const goal = yield* load(sessionID)
      if (goal && ["active", "paused", "blocked"].includes(goal.status)) {
        yield* save({ ...goal, status: "cancelled" })
      }
    })

    const observe = Effect.fn("Goal.observe")(function* (sessionID: SessionID, text: string) {
      const goal = yield* load(sessionID)
      if (!goal || goal.status !== "active") return
      const observations = [...goal.observations, `[user] ${text.slice(0, 1000)}`].slice(-30)
      yield* save({ ...goal, observations, replanned: true })
    })

    // --- Get ---

    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      return yield* load(sessionID)
    })

    return Service.of({ command, get, observe, cancel })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Storage.node, Session.node],
})

export * as Goal from "./index"
