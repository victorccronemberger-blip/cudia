export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigDistribution } from "@opencode-ai/core/config/distribution"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const sources = Effect.fn("ConfigPaths.sources")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  const distribution = yield* Effect.promise(() => ConfigDistribution.resolve())
  const directories = unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
  if (!distribution) return directories.map((path) => ({ path, readOnly: false }))
  const writable = yield* Effect.filter(directories, (dir) =>
    Effect.promise(() => distribution.contains(dir)).pipe(Effect.map((readOnly) => !readOnly)),
  )
  return [{ path: distribution.directory, readOnly: true }, ...writable.map((path) => ({ path, readOnly: false }))]
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  return (yield* sources(directory, worktree)).map((source) => source.path)
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
