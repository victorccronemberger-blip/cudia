import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect, Context, Layer, Option, Schema, Semaphore } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Storage } from "@/storage/storage"
import { SessionID, MessageID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const PolicySchema = Schema.Struct({
  enabled: Schema.Boolean,
  agent: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Array(Schema.String)),
  mode: Schema.optional(Schema.Literal("technical")),
  maxConsultations: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  maxContextChars: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})

type Policy = {
  enabled: boolean
  agent: string
  providers: string[]
  mode: "technical"
  maxConsultations: number
  maxContextChars: number
}

const AttemptSchema = Schema.Struct({
  id: Schema.String,
  reason: Schema.Literals(["technical", "technical-tool", "recovery"]),
  status: Schema.Literals(["pending", "completed", "failed", "interrupted"]),
  checkpoint: MessageID,
  requestedAt: Schema.Number,
  prompt: Schema.String,
})

const SavedSchema = Schema.Struct({
  sessionID: SessionID,
  scopeID: MessageID,
  goalID: Schema.optional(Schema.String),
  request: Schema.String,
  requested: Schema.optional(Schema.Literals(["technical-tool"])),
  attempts: Schema.Array(AttemptSchema),
})

type AttemptValue = Schema.Schema.Type<typeof AttemptSchema>
type Attempt = { -readonly [K in keyof AttemptValue]: AttemptValue[K] }
type SavedValue = Schema.Schema.Type<typeof SavedSchema>
type Saved = {
  -readonly [K in keyof SavedValue as K extends "attempts" ? never : K]: SavedValue[K]
} & { attempts: Attempt[] }

export type Input = {
  sessionID: SessionID
  parentSessionID?: SessionID
  providerID: string
  agentName: string
  messageID: MessageID
  continuation: boolean
  goalID?: string
  request: string
  messages: SessionV1.WithParts[]
}

export type Claim = {
  id: string
  sessionID: SessionID
  scopeID: string
  agent: string
  reason: Attempt["reason"]
  prompt: string
}

export interface Interface {
  readonly claim: (input: Input) => Effect.Effect<Claim | undefined, unknown>
  readonly beforeTool: (input: Input, toolID: string, args: unknown) => Effect.Effect<boolean, unknown>
  readonly finish: (claim: Claim, status: "completed" | "failed" | "interrupted") => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Consultation") {}

const configFile = "consultation.json"
const key = (sessionID: SessionID) => ["consultation", sessionID]

const technicalPattern =
  /\b(code|coding|program|programming|implement|implementation|debug|bug|fix|refactor|architecture|technical|deploy|deployment|build|test|tests|api|server|database|config|configuration|script|shell|terminal|repo|repository|compile|typecheck|regression|pipeline|security|diff|software|c[oó]digo|programar|programa[cç][aã]o|implementar|implementa[cç][aã]o|depurar|corrigir|consertar|refatorar|arquitetura|t[eé]cnico|implantar|compilar|testes|banco de dados|configura[cç][aã]o|roteiro|terminal|reposit[oó]rio|diferen[cç]a|seguran[cç]a)\b/i
const filePattern =
  /(?:^|[\s`"'])[^\s`"']+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|cs|cpp|c|h|json|ya?ml|toml|sql|sh|ps1|mjs|mdx?|css|html)\b/i
const multiStepPattern =
  /\b(step[- ]by[- ]step|multi[- ]step|end[- ]to[- ]end|from scratch|across files|passo a passo|fim a fim|do zero|em todas as etapas)\b/i

function technical(request: string) {
  return technicalPattern.test(request) || filePattern.test(request) || multiStepPattern.test(request)
}

function redact(text: string) {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g,
      "[redacted credential]",
    )
    .replace(/\b(api[_-]?key|password|token|secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[redacted]")
}

function maximumMessageID(messages: SessionV1.WithParts[], fallback: MessageID) {
  return messages.reduce((current, message) => (message.info.id > current ? message.info.id : current), fallback)
}

function failuresSince(messages: SessionV1.WithParts[], checkpoint: MessageID) {
  const failed: Array<{ tool: string; error: string }> = []
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.id <= checkpoint) continue
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status === "error") {
        const metadata = part.state.metadata
        if (metadata?.interrupted === true || /\b(cancelled|canceled|abort(?:ed)?)\b/i.test(part.state.error)) continue
        failed.push({ tool: part.tool, error: part.state.error })
        continue
      }
      if (
        part.state.status === "completed" &&
        typeof part.state.metadata.exit === "number" &&
        part.state.metadata.exit !== 0
      )
        failed.push({ tool: part.tool, error: `${part.tool} exited with code ${part.state.metadata.exit}` })
    }
  }
  return failed
}

function isWorkTool(input: { toolID: string; args: unknown; advisor: string }) {
  if (input.toolID === "read" || input.toolID === "glob" || input.toolID === "grep" || input.toolID === "skill")
    return false
  if (
    input.toolID === "agent_search" ||
    input.toolID === "get_goal" ||
    input.toolID === "create_goal" ||
    input.toolID === "update_goal" ||
    input.toolID === "tool_result" ||
    input.toolID === "mcp" ||
    input.toolID === "servers" ||
    input.toolID === "connect" ||
    input.toolID === "disconnect" ||
    input.toolID === "instructions" ||
    input.toolID === "search" ||
    input.toolID === "fetch" ||
    input.toolID === "websearch" ||
    input.toolID === "webfetch" ||
    input.toolID === "question" ||
    input.toolID === "todo"
  )
    return false
  if (input.toolID === "task" && typeof input.args === "object" && input.args !== null) {
    const subagent = "subagent_type" in input.args ? input.args.subagent_type : undefined
    if (subagent === input.advisor) return false
  }
  return (
    ["edit", "write", "patch", "bash", "shell", "execute", "task"].includes(input.toolID) || input.toolID.includes("_")
  )
}

function prompt(input: {
  request: string
  reason: Attempt["reason"]
  diagnostics: Array<{ tool: string; error: string }>
  maximum: number
}) {
  const request = redact(input.request).slice(0, input.maximum)
  const diagnostics = input.diagnostics.slice(0, 6).map((item) => `- ${item.tool}: ${redact(item.error).slice(0, 500)}`)
  return [
    "Independently advise on the operator's technical request. Do not edit files or run commands.",
    `Reason: ${input.reason}`,
    "Request:",
    request,
    ...(diagnostics.length ? ["New failed tool diagnostics:", ...diagnostics] : []),
    "Give concise findings, risks, and a practical next step. Do not claim verification that was not performed.",
  ]
    .join("\n")
    .slice(0, input.maximum)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const transitions = yield* Semaphore.make(1)
    const ownedClaims = new Set<string>()
    const policyPath = path.join(global.config, configFile)
    const raw = yield* fs.readJson(policyPath).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
      Effect.catch((error) =>
        Effect.logWarning("Consultation policy could not be read; automatic consultation is disabled", {
          error: String(error).slice(0, 300),
        }).pipe(Effect.as(Option.none())),
      ),
    )
    const policy = Option.isSome(raw) ? Schema.decodeUnknownOption(PolicySchema)(raw.value) : Option.none()
    if (Option.isSome(raw) && Option.isNone(policy))
      yield* Effect.logWarning("Consultation policy is malformed; automatic consultation is disabled")
    const settings: Policy | undefined = Option.isSome(policy)
      ? {
          enabled: policy.value.enabled,
          agent: policy.value.agent ?? "sol-consultor",
          providers: [...(policy.value.providers ?? ["drael"])],
          mode: policy.value.mode ?? "technical",
          maxConsultations: policy.value.maxConsultations ?? 2,
          maxContextChars: policy.value.maxContextChars ?? 12_000,
        }
      : undefined

    const get = Effect.fn("Consultation.get")(function* (sessionID: SessionID) {
      const value = yield* storage.read<Saved>(key(sessionID)).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
      )
      if (Option.isNone(value)) return undefined
      if (!Schema.is(SavedSchema)(value.value) || value.value.sessionID !== sessionID) {
        yield* Effect.logWarning("Invalid consultation state was preserved and ignored", { sessionID })
        return undefined
      }
      return value.value as Saved
    })

    const active = (input: Input, selected: Policy | undefined) =>
      selected?.enabled === true &&
      selected.mode === "technical" &&
      selected.providers.includes(input.providerID) &&
      input.parentSessionID === undefined &&
      input.agentName !== "plan" &&
      input.agentName !== selected.agent

    const scope = (input: Input, previous?: Saved) => {
      if (!previous) return { id: input.messageID, goalID: input.goalID }
      if (input.goalID && previous.goalID === input.goalID) return { id: previous.scopeID, goalID: input.goalID }
      if (input.goalID && !previous.goalID && input.messageID === previous.scopeID)
        return { id: previous.scopeID, goalID: input.goalID }
      if (input.continuation && !input.goalID && !previous.goalID) return { id: previous.scopeID, goalID: undefined }
      return { id: input.messageID, goalID: input.goalID }
    }

    const claim: Interface["claim"] = Effect.fn("Consultation.claim")(function* (input) {
      if (!active(input, settings)) return undefined
      return yield* transitions.withPermit(
        Effect.gen(function* () {
          const previous = yield* get(input.sessionID)
          const selectedScope = scope(input, previous)
          const sameScope = previous?.scopeID === selectedScope.id
          const saved: Saved = sameScope
            ? { ...previous, goalID: selectedScope.goalID }
            : {
                sessionID: input.sessionID,
                scopeID: selectedScope.id,
                goalID: selectedScope.goalID,
                request: redact(input.request).slice(0, settings!.maxContextChars),
                attempts: [],
              }
          const latest = saved.attempts.at(-1)
          if (latest?.status === "pending") {
            if (ownedClaims.has(latest.id)) return undefined
            latest.status = "interrupted"
          }
          let reason: Attempt["reason"] | undefined
          let diagnostics: Array<{ tool: string; error: string }> = []
          if (saved.requested) reason = saved.requested
          else if (saved.attempts.length === 0 && technical(saved.request)) reason = "technical"
          else if (latest?.status === "interrupted" && saved.attempts.length < settings!.maxConsultations)
            reason = latest.reason
          else if (latest && saved.attempts.length < settings!.maxConsultations) {
            diagnostics = failuresSince(input.messages, latest.checkpoint)
            if (diagnostics.length >= 2) reason = "recovery"
          }
          if (saved.attempts.length >= settings!.maxConsultations) {
            if (saved.requested || latest?.status === "interrupted") {
              saved.requested = undefined
              yield* storage.write(key(input.sessionID), saved)
            } else if (!sameScope || saved.goalID !== previous?.goalID)
              yield* storage.write(key(input.sessionID), saved)
            return undefined
          }
          if (!reason) {
            if (!sameScope) yield* storage.write(key(input.sessionID), saved)
            else if (saved.goalID !== previous?.goalID) yield* storage.write(key(input.sessionID), saved)
            return undefined
          }
          const item: Attempt = {
            id: crypto.randomUUID(),
            reason,
            status: "pending",
            checkpoint: maximumMessageID(input.messages, input.messageID),
            requestedAt: Date.now(),
            prompt: prompt({ request: saved.request, reason, diagnostics, maximum: settings!.maxContextChars }),
          }
          saved.requested = undefined
          saved.attempts.push(item)
          yield* storage.write(key(input.sessionID), saved)
          ownedClaims.add(item.id)
          return {
            id: item.id,
            sessionID: input.sessionID,
            scopeID: saved.scopeID,
            agent: settings!.agent,
            reason,
            prompt: item.prompt,
          } satisfies Claim
        }),
      )
    })

    const beforeTool: Interface["beforeTool"] = Effect.fn("Consultation.beforeTool")(function* (input, toolID, args) {
      if (!active(input, settings) || !isWorkTool({ toolID, args, advisor: settings!.agent })) return false
      return yield* transitions.withPermit(
        Effect.gen(function* () {
          const previous = yield* get(input.sessionID)
          const selectedScope = scope(input, previous)
          const sameScope = previous?.scopeID === selectedScope.id
          const saved: Saved = sameScope
            ? { ...previous, goalID: selectedScope.goalID }
            : {
                sessionID: input.sessionID,
                scopeID: selectedScope.id,
                goalID: selectedScope.goalID,
                request: redact(input.request).slice(0, settings!.maxContextChars),
                attempts: [],
              }
          if (saved.attempts.length >= settings!.maxConsultations) return false
          if (saved.attempts.some((item) => item.status === "completed" || item.status === "failed")) return false
          if (!saved.requested) {
            saved.requested = "technical-tool"
            yield* storage.write(key(input.sessionID), saved)
          } else if (!sameScope || saved.goalID !== previous?.goalID) yield* storage.write(key(input.sessionID), saved)
          return true
        }),
      )
    })

    const finish: Interface["finish"] = Effect.fn("Consultation.finish")(function* (item, status) {
      ownedClaims.delete(item.id)
      yield* transitions.withPermit(
        Effect.gen(function* () {
          const saved = yield* get(item.sessionID)
          if (!saved || saved.scopeID !== MessageID.make(item.scopeID)) return
          const attempt = saved.attempts.find((candidate) => candidate.id === item.id)
          if (!attempt || attempt.status !== "pending") return
          attempt.status = status
          yield* storage.write(key(item.sessionID), saved)
        }),
      )
    })

    return Service.of({ claim, beforeTool, finish })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Global.node, FSUtil.node, Storage.node] })
export * as Consultation from "."
