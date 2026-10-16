export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Schema } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"
import { InstructionSource } from "./instruction-source"
import { AmbientInstructions } from "./harness/ambient-instructions"
import { ContextManifest } from "./harness/context-manifest"
import { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const instructions = yield* InstructionSource.Service
    const ambient = yield* AmbientInstructions.Service

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          render(current, "These instructions replace all previously loaded ambient instructions.\n\n"),
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      if (!ambient.current().automatic) return []
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
            ? []
            : yield* fs.up({
                targets: ["AGENTS.md"],
                start,
                stop,
                maxResults: instructions.limits.maxSources,
              }),
          fs.resolve,
        ),
      )
      const globalPath = join(global.config, "AGENTS.md")
      const globalInfo = yield* fs
        .stat(globalPath)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      const paths = Array.dedupe([...(globalInfo === undefined ? [] : [yield* fs.realPath(globalPath)]), ...discovered])
      const files = yield* instructions.load(
        paths.map((path) => ({
          kind: "file" as const,
          path,
        })),
      )
      return files.map((file) => new File({ path: AbsolutePath.make(file.source), content: file.text }))
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) => (files.length === 0 ? SystemContext.empty : source(files))),
        Effect.catch((error) =>
          Effect.logWarning("Cannot acquire ambient instruction context", { error }).pipe(
            Effect.as(source(SystemContext.unavailable)),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning("Ambient instruction discovery failed", { defect }).pipe(
            Effect.as(source(SystemContext.unavailable)),
          ),
        ),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [
    FSUtil.node,
    Global.node,
    Location.node,
    SystemContextRegistry.node,
    InstructionSource.node,
    AmbientInstructions.node,
  ],
})

function render(files: ReadonlyArray<File>, prefix = ""): ContextManifest.Rendered {
  const chunks = [prefix]
  const origins: ContextManifestSchema.Origin[] = []
  let cursor = prefix.length
  files.forEach((file, index) => {
    const header = `${index === 0 ? "" : "\n\n"}Instructions from: ${file.path}\n`
    const start = cursor + header.length
    const observed = ContextManifest.describe(file.content)
    origins.push({
      kind: "file",
      id: file.path,
      start,
      end: start + file.content.length,
      sha256: observed.sha256,
      bytes: observed.bytes,
    })
    chunks.push(header, file.content)
    cursor = start + file.content.length
  })
  return { text: chunks.join(""), origins }
}
