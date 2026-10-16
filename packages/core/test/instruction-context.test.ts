import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ContextManifest } from "@opencode-ai/core/harness/context-manifest"
import { AmbientInstructions } from "@opencode-ai/core/harness/ambient-instructions"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  automatic?: boolean
  config: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
}) =>
  AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, InstructionContext.node]), [
    ...(input.automatic === false
      ? []
      : [
          [
            AmbientInstructions.node,
            Layer.succeed(
              AmbientInstructions.Service,
              AmbientInstructions.Service.of({ current: () => ({ automatic: true, source: "cli" }) }),
            ),
          ] as const,
        ]),
    [Global.node, Global.layerWith({ config: input.config })],
    [Location.node, input.locationServiceLayer],
    ...(input.filesystemLayer ? [[FSUtil.node, input.filesystemLayer] as const] : []),
  ])

describe("InstructionContext", () => {
  it.live("default mode leaves global, ancestor and nested instructions out of system context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "nested")
          yield* Effect.promise(async () => {
            await fs.mkdir(config, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(path.join(config, "AGENTS.md"), "GLOBAL_RULE_MUST_NOT_BE_PROMOTED")
            await fs.writeFile(path.join(project, "AGENTS.md"), "ANCESTOR_RULE_MUST_NOT_BE_PROMOTED")
            await fs.writeFile(path.join(directory, "AGENTS.md"), "NESTED_RULE_MUST_NOT_BE_PROMOTED")
          })
          const initialized = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.flatMap(SystemContext.initialize),
            Effect.provide(
              instructionLayer({
                automatic: false,
                config,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )
          expect(initialized.baseline).toBe("")
          expect(initialized.manifest.parts).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("loads global and upward project AGENTS.md files as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          const packageFile = path.join(directory, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const load = SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const initialized = yield* SystemContext.initialize(yield* load)
          expect(ContextManifest.verify(initialized.baseline, initialized.manifest)).toBe("valid")
          expect(initialized.manifest.parts).toHaveLength(1)
          expect(initialized.manifest.parts[0]).toMatchObject({ producer: "core/instructions", phase: "baseline" })
          expect(
            initialized.manifest.parts[0]?.origins.map((origin) => ({
              kind: origin.kind,
              id: origin.id,
              text: initialized.baseline.slice(origin.start, origin.end),
              sha256: origin.sha256,
              bytes: origin.bytes,
            })),
          ).toEqual(
            [
              { id: globalFile, text: "global" },
              { id: packageFile, text: "package" },
              { id: projectFile, text: "project" },
            ].map(({ id, text }) => ({
              kind: "file",
              id,
              text,
              sha256: ContextManifest.describe(text).sha256,
              bytes: ContextManifest.describe(text).bytes,
            })),
          )
          expect(initialized.baseline).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(initialized.baseline).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          const changed = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(changed._tag).toBe("Updated")
          if (changed._tag !== "Updated") throw new Error("Changed instruction was not reconciled")
          expect(changed.text).toContain(`Instructions from: ${packageFile}\nchanged`)
          expect(ContextManifest.verify(changed.text, changed.manifest)).toBe("valid")
          expect(changed.manifest.parts).toMatchObject([{ producer: "core/instructions", phase: "update" }])
          expect(
            changed.manifest.parts[0]?.origins.map((origin) => changed.text.slice(origin.start, origin.end)),
          ).toContain("changed")

          yield* Effect.promise(() => fs.rm(packageFile))
          const partial = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(partial._tag).toBe("Updated")
          if (partial._tag !== "Updated") throw new Error("Partial instruction removal was not reconciled")
          expect(partial.text).toBe(
            [
              "These instructions replace all previously loaded ambient instructions.",
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(ContextManifest.verify(partial.text, partial.manifest)).toBe("valid")
          expect(partial.manifest.parts).toMatchObject([{ producer: "core/instructions", phase: "update" }])
          expect(
            partial.manifest.parts[0]?.origins.map((origin) => partial.text.slice(origin.start, origin.end)),
          ).toEqual(["global", "project"])

          yield* Effect.promise(() => Promise.all([fs.rm(globalFile), fs.rm(projectFile)]))
          const removed = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(removed._tag).toBe("Updated")
          if (removed._tag !== "Updated") throw new Error("Instruction removal was not reconciled")
          expect(removed).toMatchObject({
            _tag: "Updated",
            text: "Previously loaded instructions no longer apply.",
            snapshot: {},
          })
          expect(ContextManifest.verify(removed.text, removed.manifest)).toBe("valid")
          expect(removed.manifest.parts).toMatchObject([
            { producer: "core/instructions", phase: "removed", origins: [] },
          ])
        }),
      ),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          const initialized = yield* SystemContext.initialize(context)
          expect(initialized.baseline).toBe(`Instructions from: ${file}\n`)
          expect(ContextManifest.verify(initialized.baseline, initialized.manifest)).toBe("valid")
          expect(initialized.manifest.parts[0]?.origins).toMatchObject([
            { kind: "file", id: file, start: initialized.baseline.length, end: initialized.baseline.length },
          ])
        }),
      ),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: "/repo/AGENTS.md", content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("preserves admitted instructions when a discovered file is already missing", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: file, content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.live("admits a project instruction when the missing global source does not consume the source limit", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "project")
          const projectFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(projectFile, "project instructions")
          })
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }).pipe(
                Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CUDIA_INSTRUCTION_MAX_SOURCES: 1 }))),
              ),
            ),
          )

          const initialized = yield* SystemContext.initialize(context)
          expect(initialized.baseline).toBe(`Instructions from: ${projectFile}\nproject instructions`)
          expect(initialized.snapshot["core/instructions"]?.value).toEqual([
            { path: projectFile, content: "project instructions" },
          ])
        }),
      ),
    ),
  )

  it.live("preserves the admitted snapshot when an existing global source disappears after discovery", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "project")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(globalFile, "admitted global instructions")
            await fs.writeFile(projectFile, "admitted project instructions")
          })
          const locationServiceLayer = Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
            ),
          )
          const load = (filesystemLayer?: Layer.Layer<FSUtil.Service>) =>
            SystemContextRegistry.Service.pipe(
              Effect.flatMap((service) => service.load()),
              Effect.provide(instructionLayer({ config: global, locationServiceLayer, filesystemLayer })),
            )

          const initialized = yield* SystemContext.initialize(yield* load())
          expect(initialized.baseline).toContain("admitted global instructions")
          expect(initialized.baseline).toContain("admitted project instructions")

          const realFS = yield* FSUtil.Service.pipe(Effect.provide(LayerNode.compile(FSUtil.node)))
          let removedAfterStat = false
          const disappearingFS = Layer.succeed(
            FSUtil.Service,
            FSUtil.Service.of({
              ...realFS,
              stat: (candidate) =>
                Effect.gen(function* () {
                  const result = yield* realFS.stat(candidate)
                  if (path.resolve(candidate) === path.resolve(globalFile)) {
                    yield* Effect.promise(() => fs.rm(globalFile))
                    removedAfterStat = true
                  }
                  return result
                }),
            }),
          )
          const unavailable = yield* load(disappearingFS)
          expect(removedAfterStat).toBe(true)
          expect(yield* SystemContext.reconcile(unavailable, initialized.snapshot)).toEqual({ _tag: "Unchanged" })
          expect(yield* SystemContext.replace(unavailable, initialized.snapshot)).toEqual({
            _tag: "ReplacementBlocked",
          })
        }),
      ),
    ),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string; maxResults?: number } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                Effect.sync(() => {
                  observed = options
                  return []
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
        maxResults: 64,
      })
    }),
  )

  it.live("blocks initialization instead of admitting an oversized global or project batch", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "project")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(globalFile, "g".repeat(32))
            await fs.writeFile(projectFile, "project")
          })

          const config = instructionLayer({
            config: global,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
              ),
            ),
          }).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CUDIA_INSTRUCTION_MAX_SOURCE_BYTES: 16 }))),
          )
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(config),
          )
          const initialized = yield* Effect.exit(SystemContext.initialize(context))
          expect(initialized._tag).toBe("Failure")
          if (initialized._tag !== "Failure") throw new Error("Oversized instructions unexpectedly initialized")
          expect(initialized.cause.toString()).toContain("SystemContext.InitializationBlocked")
          expect(initialized.cause.toString()).toContain("core/instructions")

          yield* Effect.promise(async () => {
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "p".repeat(32))
          })
          const projectContext = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(config),
          )
          const oversizedProject = yield* Effect.exit(SystemContext.initialize(projectContext))
          expect(oversizedProject._tag).toBe("Failure")
          if (oversizedProject._tag !== "Failure")
            throw new Error("Oversized project instructions unexpectedly initialized")
          expect(oversizedProject.cause.toString()).toContain("SystemContext.InitializationBlocked")
        }),
      ),
    ),
  )

  it.live("keeps the complete admitted snapshot during aggregate overflow and reconciles the full retry", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "project")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(globalFile, "global old")
            await fs.writeFile(projectFile, "project old")
          })
          const locationServiceLayer = Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
            ),
          )
          const load = (configuration: Layer.Layer<never>) =>
            SystemContextRegistry.Service.pipe(
              Effect.flatMap((service) => service.load()),
              Effect.provide(
                instructionLayer({ config: global, locationServiceLayer }).pipe(Layer.provide(configuration)),
              ),
            )
          const original = yield* SystemContext.initialize(
            yield* load(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          )
          expect(original.baseline).toContain("global old")
          expect(original.baseline).toContain("project old")

          yield* Effect.promise(async () => {
            await fs.writeFile(globalFile, "global changed and too large")
            await fs.writeFile(projectFile, "project changed")
          })
          const constrained = yield* load(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ CUDIA_INSTRUCTION_MAX_TOTAL_BYTES: 190 })),
          )
          expect(yield* SystemContext.reconcile(constrained, original.snapshot)).toEqual({ _tag: "Unchanged" })
          expect(yield* SystemContext.replace(constrained, original.snapshot)).toEqual({ _tag: "ReplacementBlocked" })

          yield* Effect.promise(async () => {
            await fs.writeFile(globalFile, "global new")
            await fs.writeFile(projectFile, "project new")
          })
          const retried = yield* SystemContext.reconcile(
            yield* load(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            original.snapshot,
          )
          if (retried._tag !== "Updated") throw new Error("Valid source retry did not update the admitted set")
          const retriedSnapshot = JSON.stringify(retried.snapshot)
          expect(retried.text).toBeString()
          expect(retried.text).toContain("global new")
          expect(retried.text).toContain("project new")
          expect(retried.text).not.toContain("global old")
          expect(retried.text).not.toContain("project old")
          expect(retriedSnapshot).toContain("global new")
          expect(retriedSnapshot).toContain("project new")
        }),
      ),
    ),
  )

  it.live("distinguishes an optional missing global file from a failed existing global file", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "project")
          const projectFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(projectFile, "project instructions")
          })
          const locationServiceLayer = Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
            ),
          )
          const normalContext = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(instructionLayer({ config: global, locationServiceLayer })),
          )
          expect((yield* SystemContext.initialize(normalContext)).baseline).toContain("project instructions")

          const globalFile = path.join(global, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(globalFile, "global instructions"))
          const realFS = yield* FSUtil.Service.pipe(Effect.provide(LayerNode.compile(FSUtil.node)))
          const failingFS = Layer.succeed(
            FSUtil.Service,
            FSUtil.Service.of({
              ...realFS,
              open: (candidate, options) =>
                path.resolve(candidate) === path.resolve(globalFile)
                  ? realFS.open(path.join(global, "missing-AGENTS.md"), options)
                  : realFS.open(candidate, options),
            }),
          )
          const failedContext = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(instructionLayer({ config: global, locationServiceLayer, filesystemLayer: failingFS })),
          )
          const initialized = yield* Effect.exit(SystemContext.initialize(failedContext))
          expect(initialized._tag).toBe("Failure")
          if (initialized._tag !== "Failure") throw new Error("Failed existing global source was admitted")
          expect(initialized.cause.toString()).toContain("SystemContext.InitializationBlocked")
        }),
      ),
    ),
  )

  it.live("blocks malformed UTF-8 instructions without admitting partial text", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "project")
          const projectFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(projectFile, Buffer.from([0x61, 0xc3, 0x28]))
          })
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )
          const initialized = yield* Effect.exit(SystemContext.initialize(context))
          expect(initialized._tag).toBe("Failure")
          if (initialized._tag !== "Failure") throw new Error("Malformed UTF-8 instructions were admitted")
          expect(initialized.cause.toString()).toContain("SystemContext.InitializationBlocked")
        }),
      ),
    ),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
            else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )
})
