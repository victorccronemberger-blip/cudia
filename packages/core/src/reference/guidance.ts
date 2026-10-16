export * as ReferenceGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Reference } from "../reference"
import { SystemContext } from "../system-context/index"
import { ContextManifest } from "../harness/context-manifest"
import { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"

const Summary = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  description: Schema.String.pipe(Schema.optional),
})

const render = (references: ReadonlyArray<typeof Summary.Type>, prefix = ""): ContextManifest.Rendered => {
  const chunks = [
    `${prefix}Project references provide additional directories that can be accessed when relevant.\n<available_references>`,
  ]
  const origins: ContextManifestSchema.Origin[] = []
  let cursor = chunks[0].length
  for (const reference of references) {
    const text = [
      "  <reference>",
      `    <name>${reference.name}</name>`,
      `    <path>${reference.path}</path>`,
      ...(reference.description === undefined ? [] : [`    <description>${reference.description}</description>`]),
      "  </reference>",
    ].join("\n")
    const start = cursor + 1
    const observed = ContextManifest.describe(JSON.stringify(reference))
    origins.push({
      kind: "reference",
      id: reference.path,
      start,
      end: start + text.length,
      sha256: observed.sha256,
      bytes: observed.bytes,
    })
    chunks.push(text)
    cursor = start + text.length
  }
  chunks.push("</available_references>")
  return { text: chunks.join("\n"), origins }
}

export interface Interface {
  readonly load: () => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ReferenceGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const references = yield* Reference.Service

    return Service.of({
      load: Effect.fn("ReferenceGuidance.load")(function* () {
        const available = (yield* references.list())
          .filter((reference) => reference.description !== undefined)
          .map((reference) => ({
            name: reference.name,
            path: reference.path,
            description: reference.description,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name))
        if (available.length === 0) return SystemContext.empty
        return SystemContext.make({
          key: SystemContext.Key.make("core/reference-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            render(
              current,
              "The available project references have changed. This list supersedes the previous reference list.\n",
            ),
          removed: () => "Project reference guidance is no longer available. Do not use previously listed references.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [Reference.node] })
