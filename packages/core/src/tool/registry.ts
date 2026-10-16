export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { ToolPolicy } from "../harness/tool-policy"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import type { ToolContextSource } from "@opencode-ai/schema/tool-context-source"
import { ToolProvenance } from "./provenance"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    sessionID?: SessionSchema.ID,
    options?: { readonly omit?: ReadonlyArray<string> },
  ) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (
    tools: Readonly<Record<string, AnyTool>>,
    options?: { readonly sessionID?: SessionSchema.ID },
  ) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
  readonly contextSources?: ToolContextSource.Bundle
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = {
      readonly identity: object
      readonly tool: AnyTool
      readonly sessionID?: SessionSchema.ID
    }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const select = (name: string, sessionID?: SessionSchema.ID): Registration | undefined => {
      const entries = local.get(name) ?? []
      const session =
        sessionID === undefined ? undefined : entries.findLast((entry) => entry.registration.sessionID === sessionID)
      const location = entries.findLast((entry) => entry.registration.sessionID === undefined)
      return session?.registration ?? location?.registration ?? applications.entries().get(name)
    }

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration = select(input.call.name, input.sessionID)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const contextSources = ToolProvenance.take(output)
      const bounded = yield* resources.bound({
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        output,
      })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return {
        result,
        output: bounded.output,
        ...(bounded.outputPaths.length > 0 ? { outputPaths: bounded.outputPaths } : {}),
        ...(contextSources
          ? {
              contextSources: {
                ...contextSources,
                projection: bounded.output === output ? ("original" as const) : ("replaced" as const),
              },
            }
          : {}),
      }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools, options) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [
                ...(local.get(name) ?? []),
                { token, registration: { identity: {}, tool, sessionID: options?.sessionID } },
              ])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = [], sessionID, options) {
        const registrations = new Map<string, Registration>()
        for (const name of new Set([...applications.entries().keys(), ...local.keys()])) {
          const registration = select(name, sessionID)
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (options?.omit?.includes(name) || whollyDisabled(permission(registration.tool, name), permissions))
            registrations.delete(name)
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  return ToolPolicy.hidden()
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
