import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const builtInsNode = LayerNode.group([SystemContextBuiltIns.node, SystemContextRegistry.node])
const it = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]),
)
const itWithInstructions = testEffect(Layer.empty)

describe("SystemContextBuiltIns", () => {
  it.effect("loads location-scoped environment and host-local date context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
        ].join("\n"),
      )
    }),
  )

  it.effect("reconciles the date without repeating unchanged environment context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: `Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`,
      })
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect(yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  itWithInstructions.effect("composes ambient instructions after built-in context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (temporaryDirectory) => Effect.promise(() => temporaryDirectory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((temporaryDirectory) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(timestamp)
          const global = path.join(temporaryDirectory.path, "global")
          const project = path.join(temporaryDirectory.path, "repo")
          const workingDirectory = path.join(project, "packages", "core")
          const instructionFile = path.join(project, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(workingDirectory, { recursive: true })
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(instructionFile, "Be precise.")
          })
          const temporaryDirectoryPath = AbsolutePath.make(project)
          const temporaryWorkingDirectory = AbsolutePath.make(workingDirectory)
          const layer = AppNodeBuilder.build(builtInsNode, [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: temporaryWorkingDirectory },
                    {
                      projectDirectory: temporaryDirectoryPath,
                      vcs: { type: "git", store: AbsolutePath.make(path.join(project, ".git")) },
                    },
                  ),
                ),
              ),
            ],
            [Global.node, Global.layerWith({ config: global })],
          ])
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((registry) => registry.load()),
            Effect.provide(layer),
          )

          expect((yield* SystemContext.initialize(context)).baseline).toBe(
            [
              "Here is some useful information about the environment you are running in:",
              "<env>",
              `  Working directory: ${temporaryWorkingDirectory}`,
              `  Workspace root folder: ${temporaryDirectoryPath}`,
              "  Is directory a git repo: yes",
              `  Platform: ${process.platform}`,
              "</env>",
              "",
              `Today's date: ${localDate(timestamp)}`,
              "",
              `Instructions from: ${instructionFile}\nBe precise.`,
            ].join("\n"),
          )
        }),
      ),
    ),
  )
})
