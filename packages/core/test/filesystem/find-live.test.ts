import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { Entry } from "@opencode-ai/schema/filesystem"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const searchNode = LayerNode.make({
  service: FileSystemSearch.Service,
  layer: FileSystemSearch.ripgrepLayer,
  deps: [FSUtil.node, Location.node, Ripgrep.node],
})

const searchRoot = LayerNode.group([searchNode, FSUtil.node, LayerNodePlatform.filesystem])

function searchLayer(directory: string, input?: { vcs?: Project.Vcs; ripgrep?: Ripgrep.Interface }) {
  const absolute = AbsolutePath.make(directory)
  const selected = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: absolute }, { vcs: input?.vcs })),
  )
  const replacements = input?.ripgrep
    ? [
        [Location.node, selected] as const,
        [Ripgrep.node, Layer.succeed(Ripgrep.Service, Ripgrep.Service.of(input.ripgrep))] as const,
      ]
    : [[Location.node, selected] as const]
  return AppNodeBuilder.build(searchRoot, replacements)
}

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((temp) => f(temp.path)))

const find = (query: string, type?: "file" | "directory") =>
  Effect.gen(function* () {
    const search = yield* FileSystemSearch.Service
    return yield* search.find({ query, type, limit: 100 })
  })

describe("filesystem search live find", () => {
  it.live("uses a fresh scan on the first query and after create, rename, and delete", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src", "nested"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "initial-only.ts"), "initial"))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "nested", "needle-only.ts"), "nested"))

        const checks = Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          const initial = yield* search.find({ query: "initial-only.ts", type: "file" })
          expect(initial.map((item) => item.path)).toContain(RelativePath.make("src/initial-only.ts"))

          const nestedDirectories = yield* search.find({ query: "nested", type: "directory" })
          expect(nestedDirectories.map((item) => item.path)).toContain(RelativePath.make(`src/nested${path.sep}`))

          yield* Effect.promise(() => fs.writeFile(path.join(directory, "src", "fresh-only.ts"), "fresh"))
          expect((yield* search.find({ query: "fresh-only.ts", type: "file" })).map((item) => item.path)).toContain(
            RelativePath.make("src/fresh-only.ts"),
          )

          yield* Effect.promise(() =>
            fs.rename(path.join(directory, "src", "fresh-only.ts"), path.join(directory, "src", "renamed-only.ts")),
          )
          expect((yield* search.find({ query: "fresh-only.ts", type: "file" })).map((item) => item.path)).not.toContain(
            RelativePath.make("src/fresh-only.ts"),
          )
          expect((yield* search.find({ query: "renamed-only.ts", type: "file" })).map((item) => item.path)).toContain(
            RelativePath.make("src/renamed-only.ts"),
          )

          yield* Effect.promise(() => fs.rm(path.join(directory, "src", "initial-only.ts")))
          expect(
            (yield* search.find({ query: "initial-only.ts", type: "file" })).map((item) => item.path),
          ).not.toContain(RelativePath.make("src/initial-only.ts"))
        })

        yield* checks.pipe(Effect.provide(searchLayer(directory)))
      }),
    ),
  )

  it.live("honors changed gitignore rules on the next query without a watcher", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => $`git init -q ${directory}`.quiet())
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "secret-only.txt"), "secret"))
        const vcs = { type: "git" as const, store: AbsolutePath.make(path.join(directory, ".git")) }
        const layer = searchLayer(directory, { vcs })

        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          expect((yield* search.find({ query: "secret-only.txt", type: "file" })).map((item) => item.path)).toContain(
            RelativePath.make("secret-only.txt"),
          )

          yield* Effect.promise(() => fs.writeFile(path.join(directory, ".gitignore"), "secret-only.txt\n"))
          expect(
            (yield* search.find({ query: "secret-only.txt", type: "file" })).map((item) => item.path),
          ).not.toContain(RelativePath.make("secret-only.txt"))

          yield* Effect.promise(() => fs.rm(path.join(directory, ".gitignore")))
          expect((yield* search.find({ query: "secret-only.txt", type: "file" })).map((item) => item.path)).toContain(
            RelativePath.make("secret-only.txt"),
          )
        }).pipe(Effect.provide(layer))
      }),
    ),
  )

  it.live("does not expose incomplete scan entries and keeps cancellation local", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const returned = yield* Deferred.make<void>()
        let calls = 0
        let interrupted = false
        let receivedEntryCallback = false
        const partial = Entry.make({ path: RelativePath.make("partial.txt"), type: "file" })
        const complete = Entry.make({ path: RelativePath.make("partial-complete.txt"), type: "file" })
        const ripgrep: Ripgrep.Interface = {
          find: (input) => {
            calls++
            if (calls !== 1) return Effect.succeed([complete])
            receivedEntryCallback = input.onEntry !== undefined
            return Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Effect.never
              return [partial]
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))))
          },
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        }
        const layer = searchLayer(directory, { ripgrep })
        const query = Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          return yield* search.find({ query: "partial" })
        }).pipe(Effect.tap(() => Deferred.succeed(returned, undefined)))

        const pending = yield* query.pipe(Effect.provide(layer), Effect.forkScoped)
        yield* Deferred.await(entered)
        const published = yield* Effect.raceFirst(
          Deferred.await(returned).pipe(Effect.as(true)),
          Effect.sleep("20 millis").pipe(Effect.as(false)),
        )
        expect(published).toBe(false)
        expect(receivedEntryCallback).toBe(false)
        yield* Fiber.interrupt(pending)
        expect(interrupted).toBe(true)

        const next = yield* query.pipe(Effect.provide(layer))
        expect(next.map((item) => item.path)).toContain(RelativePath.make("partial-complete.txt"))
        expect(calls).toBe(2)
      }),
    ),
  )

  it.live("fails the query instead of returning an empty result when the scan errors or exceeds its budget", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const broken: Ripgrep.Interface = {
          find: () => Effect.fail(new Ripgrep.Error({ message: "fixture scan failure" })),
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        }
        const failed = yield* Effect.exit(
          find("anything").pipe(Effect.provide(searchLayer(directory, { ripgrep: broken }))),
        )
        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed)) expect(Cause.prettyErrors(failed.cause).join(" ")).toContain("fixture scan failure")

        let requestedLimit = 0
        let failOnPartial = false
        const tooMany: Ripgrep.Interface = {
          find: (input) => {
            requestedLimit = input.limit
            failOnPartial = input.failOnPartial ?? false
            return Effect.succeed(
              Array.from({ length: 100_001 }, (_, index) =>
                Entry.make({ path: RelativePath.make(`file-${index}.txt`), type: "file" }),
              ),
            )
          },
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        }
        const overBudget = yield* Effect.exit(
          find("file").pipe(Effect.provide(searchLayer(directory, { ripgrep: tooMany }))),
        )
        expect(requestedLimit).toBe(100_001)
        expect(failOnPartial).toBe(true)
        expect(Exit.isFailure(overBudget)).toBe(true)
        if (Exit.isFailure(overBudget))
          expect(Cause.prettyErrors(overBudget.cause).join(" ")).toContain("exceeds the 100000 file scan budget")
      }),
    ),
  )
})
