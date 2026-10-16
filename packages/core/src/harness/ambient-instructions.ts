export * as AmbientInstructions from "./ambient-instructions"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export type Choice = { readonly automatic: boolean; readonly source: "default" | "cli" }

// This preference comes from the parsed CLI, not project configuration or .env.
// Embedders default to manual delivery and can provide this service explicitly.
let choice: Choice = Object.freeze({ automatic: false, source: "default" })

export function configure(automatic: boolean) {
  const enabled = automatic === true
  choice = Object.freeze({ automatic: enabled, source: enabled ? "cli" : "default" })
}

export function current(): Choice {
  return choice
}

export interface Interface {
  readonly current: () => Choice
}

export class Service extends Context.Service<Service, Interface>()("@cudia/AmbientInstructions") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, Service.of({ current })),
  deps: [],
})
