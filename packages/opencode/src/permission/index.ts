import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ToolPolicy } from "@opencode-ai/core/harness/tool-policy"

import { Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

export function evaluate(permission: string, pattern: string, ..._rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  const rule = ToolPolicy.evaluate(permission, pattern)
  return { permission: rule.action, pattern: rule.resource, action: rule.effect }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    ask: () => Effect.void,
    reply: (input) => Effect.fail(new PermissionV1.NotFoundError({ requestID: input.requestID })),
    list: () => Effect.succeed([]),
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(_tools: string[], _ruleset: PermissionV1.Ruleset): Set<string> {
  return new Set()
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as Permission from "."
