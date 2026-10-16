export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"

import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { ToolPolicy } from "./harness/tool-policy"

export { Effect, Rule, Ruleset } from "@opencode-ai/schema/permission"

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ..._rulesets: Permission.Ruleset[]): Permission.Rule {
  return ToolPolicy.evaluate(action, resource)
}

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()(
  "PermissionV2.AgentNotFoundError",
  {
    agent: AgentV2.ID.pipe(Schema.optional),
  },
) {}
export type IdentityError = SessionV2.NotFoundError | AgentNotFoundError

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  /** Evaluate the current policy without requesting approval or creating pending state. */
  readonly check: (input: AssertInput) => EffectRuntime.Effect<Permission.Effect, IdentityError>
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, IdentityError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | IdentityError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const check = EffectRuntime.fn("PermissionV2.check")(function* (input: AssertInput) {
      const session = yield* sessions.get(input.sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const id = input.agent ?? session.agent
      if (!(yield* agents.resolve(id))) return yield* new AgentNotFoundError({ agent: id })
      return ToolPolicy.evaluate(input.action, input.resources[0] ?? "*").effect
    })
    return Service.of({
      check,
      ask: EffectRuntime.fn("PermissionV2.ask")(function* (input) {
        return { id: input.id ?? ID.create(), effect: yield* check(input) }
      }),
      assert: (input) => check(input).pipe(EffectRuntime.asVoid),
      reply: (input) => EffectRuntime.fail(new NotFoundError({ requestID: input.requestID })),
      get: () => EffectRuntime.succeed(undefined),
      forSession: () => EffectRuntime.succeed([]),
      list: () => EffectRuntime.succeed([]),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentV2.node, SessionStore.node],
})
