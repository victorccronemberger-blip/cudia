export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import { Context, Effect, Layer } from "effect"
import fuzzysort from "fuzzysort"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import type { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem/Search") {}

const makeRipgrepSearch = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const ripgrep = yield* Ripgrep.Service
  const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
  const resolve = Effect.fnUntraced(function* (input?: string) {
    const target = path.resolve(location.directory, input ?? ".")
    const real = yield* fs.realPath(target).pipe(Effect.orDie)
    return real
  })
  return Service.of({
    glob: (input) =>
      Effect.gen(function* () {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        if (info.type !== "Directory") return yield* Effect.die(new Error("Glob target must be a directory"))
        const cwd = target
        return yield* ripgrep
          .glob({
            cwd,
            pattern: input.pattern,
            limit: input.limit ?? Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.map((result) =>
              result.map((entry) =>
                Entry.make({
                  ...entry,
                  path: RelativePath.make(path.relative(root, path.resolve(cwd, entry.path))),
                }),
              ),
            ),
            Effect.orDie,
          )
      }),
    grep: (input) =>
      Effect.gen(function* () {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        if (info.type !== "File" && info.type !== "Directory")
          return yield* Effect.die(new Error("Grep target must be a file or directory"))
        const cwd = info.type === "File" ? path.dirname(target) : target
        return yield* ripgrep
          .grep({
            cwd,
            pattern: input.pattern,
            file: info.type === "File" ? path.basename(target) : undefined,
            include: input.include,
            limit: input.limit ?? Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.map((result) =>
              result.map((match) =>
                Match.make({
                  ...match,
                  entry: Entry.make({
                    ...match.entry,
                    path: RelativePath.make(path.relative(root, path.resolve(cwd, match.entry.path))),
                  }),
                }),
              ),
            ),
            Effect.orDie,
          )
      }),
    find: (input) =>
      Effect.gen(function* () {
        // Every request owns its scan: a previous scan cannot establish freshness
        // for files created before this request, and cancellation stays local.
        const maximum = location.vcs ? Number.MAX_SAFE_INTEGER : 100_000
        const entries = yield* ripgrep
          .find({
            cwd: location.directory,
            pattern: "*",
            limit: maximum === Number.MAX_SAFE_INTEGER ? maximum : maximum + 1,
            failOnPartial: true,
          })
          .pipe(Effect.orDie)
        if (entries.length > maximum)
          return yield* Effect.die(new Error(`Filesystem search exceeds the ${maximum} file scan budget`))
        const files = entries.map((entry) => entry.path)
        const directories = new Set<string>()
        for (const file of files) {
          const parts = file.split("/")
          parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/") + path.sep))
        }
        const items =
          input.type === "file" ? files : input.type === "directory" ? [...directories] : [...files, ...directories]
        return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
          const relative = item.target
          const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
          return Entry.make({
            path: RelativePath.make(relative),
            type,
          })
        })
      }),
  })
})

export const ripgrepLayer = Layer.effect(Service, makeRipgrepSearch)

// The indexed FFF SDK cannot establish freshness for each request and parses
// grep paths/patterns together. Keep all public searches on structured, live
// ripgrep requests; do not initialize an unused native picker or watcher.
export const locationLayer = ripgrepLayer

export const node = makeLocationNode({
  service: Service,
  layer: ripgrepLayer,
  deps: [FSUtil.node, Location.node, Ripgrep.node],
})
