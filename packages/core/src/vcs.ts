export * as Vcs from "./vcs"

import path from "path"
import { lstat, realpath } from "node:fs/promises"
import { Context, Effect, Layer } from "effect"
import { FileDiff, FileStatus, Info, Mode, OperationError } from "@opencode-ai/schema/vcs"
import { RelativePath } from "@opencode-ai/schema/schema"
import { makeLocationNode } from "./effect/app-node"
import { AppProcess } from "./process"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { MAX_OUTPUT_BYTES, parseNumstat, parseStatus, requireSuccess, run } from "./vcs/readonly"

export { FileDiff, FileStatus, Info, Mode, OperationError }

export interface Interface {
  readonly info: () => Effect.Effect<Info, OperationError>
  readonly status: (mode?: Mode) => Effect.Effect<FileStatus[], OperationError>
  readonly diff: (mode: Mode, options?: { readonly context?: number }) => Effect.Effect<FileDiff[], OperationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const error = (operation: string, message: string, reason: OperationError["reason"] = "command") =>
      new OperationError({ operation, message, reason })
    const discover = Effect.fnUntraced(function* () {
      const directory = yield* fs
        .realPath(location.directory)
        .pipe(Effect.mapError((cause) => error("discover", cause.message)))
      const discovered = yield* run(proc, directory, ["rev-parse", "--show-toplevel"])
      if (discovered.exitCode !== 0) {
        if (!discovered.stderr.includes("not a git repository"))
          return yield* error("discover", discovered.stderr.trim() || "Git discovery failed")
        // A malformed/inaccessible repository must not look like a clean non-Git directory.
        let current = directory
        while (true) {
          const entries = yield* fs
            .readDirectoryEntries(current)
            .pipe(Effect.mapError((cause) => error("discover", cause.message)))
          if (entries.some((entry) => entry.name === ".git"))
            return yield* error("discover", discovered.stderr.trim() || "Git discovery failed")
          const parent = path.dirname(current)
          if (parent === current) return undefined
          current = parent
        }
      }
      const root = path.normalize(FSUtil.windowsPath(discovered.stdout.replace(/\r?\n$/, "")))
      if (!FSUtil.contains(root, directory))
        return yield* error("discover", "Git root does not contain the selected Location")
      const relative = path.relative(root, directory)
      const scope = (process.platform === "win32" ? relative.replaceAll("\\", "/") : relative) || "."
      const config = yield* run(proc, root, [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|process|required)$",
      ])
      const keys = (yield* requireSuccess(config, "config", [0, 1])).split("\0").filter(Boolean)
      // Git diff can invoke clean/process filters even with --no-textconv. Disable
      // every configured driver locally for these commands, including required ones.
      const overrides = keys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`])
      const git = (args: readonly string[], limit?: number) => run(proc, root, args, { config: overrides, limit })
      const checked = (args: readonly string[], accepted?: number[], limit?: number) =>
        git(args, limit).pipe(Effect.flatMap((result) => requireSuccess(result, args[0] ?? "git", accepted)))
      return { root, directory, scope, git, checked }
    })

    const metadata = Effect.fnUntraced(function* (
      repository: NonNullable<Effect.Success<ReturnType<typeof discover>>>,
    ) {
      const branch =
        (yield* repository.checked(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])).trim() || undefined
      const refs = (yield* repository.checked(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]))
        .split("\n")
        .map((ref) => ref.trim())
        .filter(Boolean)
      const remoteHeads = refs
        .filter((ref) => ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD"))
        .sort((a, b) => Number(b.includes("/origin/")) - Number(a.includes("/origin/")))
      for (const remote of remoteHeads) {
        const ref = (yield* repository.checked(["symbolic-ref", "--quiet", remote], [0, 1])).trim()
        if (ref && refs.includes(ref)) return { branch, defaultBranch: ref.split("/").slice(3).join("/"), ref }
      }
      const configured = (yield* repository.checked(["config", "--get", "init.defaultBranch"], [0, 1])).trim()
      const name = [configured, "main", "master"].find(
        (candidate) => candidate && refs.includes(`refs/heads/${candidate}`),
      )
      return { branch, defaultBranch: name, ref: name ? `refs/heads/${name}` : undefined }
    })

    const read = Effect.fnUntraced(function* (mode: Mode, context: number | undefined) {
      if (context !== undefined && (!Number.isInteger(context) || context < 0 || context > 2_147_483_647))
        return yield* error("diff", "Context must be an integer between 0 and 2147483647", "invalid_input")
      if (mode !== "working" && mode !== "branch")
        return yield* error("diff", "Unknown comparison mode", "invalid_input")
      const repository = yield* discover()
      if (!repository) return []
      const directory = repository.directory
      const head = (yield* repository.checked(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1])).trim()
      const base = yield* Effect.gen(function* () {
        if (mode === "working") return head || undefined
        const info = yield* metadata(repository)
        if (info.branch && info.branch === info.defaultBranch) return null
        if (!info.ref || !head)
          return yield* error("merge-base", "The default branch comparison is unavailable", "unavailable")
        const result = yield* repository.git(["merge-base", "HEAD", info.ref])
        if (result.exitCode === 1)
          return yield* error("merge-base", "The default branch has no common ancestor", "unavailable")
        return (yield* requireSuccess(result, "merge-base")).trim()
      })
      if (base === null) return []
      // Validate indexed parents before commands that compare working file content.
      // In particular, replacing a tracked directory with an escaping symlink must
      // not cause Git to read files beyond this Location.
      const indexed = (yield* repository.checked(["ls-files", "--cached", "-z", "--", repository.scope]))
        .split("\0")
        .filter(Boolean)
      for (const parent of new Set(indexed.map((file) => path.dirname(path.resolve(repository.root, file))))) {
        const real = yield* Effect.tryPromise({
          try: () =>
            realpath(parent).catch((cause: NodeJS.ErrnoException) => {
              if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return undefined
              throw cause
            }),
          catch: (cause) => error("diff", cause instanceof Error ? cause.message : String(cause)),
        })
        if (real && !FSUtil.contains(directory, real))
          return yield* error("diff", "Indexed path traverses a directory symlink outside the selected Location")
      }
      const common = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--submodule=short"]
      const tracked = base
        ? yield* repository
            .checked(["diff", ...common, "--name-status", "-z", base, "--", repository.scope])
            .pipe(
              Effect.flatMap((text) =>
                Effect.try({
                  try: () => parseStatus(text),
                  catch: () => error("diff", "Invalid Git name-status output"),
                }),
              ),
            )
        : indexed.map((file) => ({ file, status: "added" as const }))
      const untracked = (yield* repository.checked([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        repository.scope,
      ]))
        .split("\0")
        .filter(Boolean)
      const files = new Map(tracked.map((item) => [item.file, item]))
      untracked.forEach((file) => {
        if (!files.has(file)) files.set(file, { file, status: "added" })
      })
      const stats = base
        ? yield* repository
            .checked(["diff", ...common, "--numstat", "-z", base, "--", repository.scope])
            .pipe(
              Effect.flatMap((text) =>
                Effect.try({ try: () => parseNumstat(text), catch: () => error("diff", "Invalid Git numstat output") }),
              ),
            )
        : new Map<string, { additions: number; deletions: number }>()
      const result: FileDiff[] = []
      let bytes = 0
      for (const item of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
        const absolute = path.resolve(repository.root, item.file)
        if (!FSUtil.contains(directory, absolute) || absolute === directory)
          return yield* error("diff", "Git returned a path outside the selected Location")
        const relative = path.relative(directory, absolute)
        const file = RelativePath.make(process.platform === "win32" ? relative.replaceAll("\\", "/") : relative)
        const info = yield* Effect.tryPromise({
          try: async () => {
            const stat = await lstat(absolute).catch((cause: NodeJS.ErrnoException) => {
              if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return undefined
              throw cause
            })
            if (!stat) return undefined
            const parent = await realpath(path.dirname(absolute))
            if (!FSUtil.contains(directory, parent))
              throw new Error("Changed path traverses a directory symlink outside the selected Location")
            return stat
          },
          catch: (cause) => error("diff", cause instanceof Error ? cause.message : String(cause)),
        })
        // Git does not follow untracked filesystem symlinks. Tracked symlinks are
        // diffed by Git as link contents, without reading their target.
        const extra = untracked.includes(item.file)
        const recreated =
          base && extra && tracked.some((tracked) => tracked.file === item.file && tracked.status !== "added")
        if (extra && !recreated && (!info?.isFile() || info.isSymbolicLink())) continue
        if (!base && !info) continue
        const created = !base || (extra && !recreated)
        const gitlink = !base && info?.isDirectory()
        const args = gitlink
          ? ["diff", ...common, "--cached", "--", item.file]
          : created
            ? ["diff", ...common, "--no-index", "--", "/dev/null", item.file]
            : ["diff", ...common, recreated ? `${base}:${item.file}` : base, "--", item.file]
        const status = recreated
          ? yield* repository
              .checked([...args.slice(0, args.indexOf("--")), "--name-status", "-z", ...args.slice(args.indexOf("--"))])
              .pipe(
                Effect.flatMap((text) =>
                  Effect.try({
                    try: () => parseStatus(text)[0]?.status,
                    catch: () => error("diff", "Invalid Git name-status output"),
                  }),
                ),
              )
          : item.status
        if (!status) continue
        const stat =
          (!recreated && stats.get(item.file)) ||
          (created || recreated
            ? yield* repository
                .checked(
                  [...args.slice(0, args.indexOf("--")), "--numstat", "-z", ...args.slice(args.indexOf("--"))],
                  [0, 1],
                )
                .pipe(
                  Effect.flatMap((text) =>
                    Effect.try({
                      try: () => [...parseNumstat(text).values()][0],
                      catch: () => error("diff", "Invalid Git numstat output"),
                    }),
                  ),
                )
            : undefined)
        const patch =
          context === undefined
            ? ""
            : yield* repository.checked(
                [...args.slice(0, args.indexOf("--")), `--unified=${context}`, ...args.slice(args.indexOf("--"))],
                created ? [0, 1] : [0],
                MAX_OUTPUT_BYTES - bytes,
              )
        bytes += Buffer.byteLength(patch)
        result.push({ file, status, additions: stat?.additions ?? 0, deletions: stat?.deletions ?? 0, patch })
      }
      return result
    })

    return Service.of({
      info: Effect.fn("Vcs.info")(function* () {
        const repository = yield* discover()
        if (!repository) return {}
        const info = yield* metadata(repository)
        return { branch: info.branch, defaultBranch: info.defaultBranch }
      }),
      status: (mode = "working") =>
        read(mode, undefined).pipe(Effect.map((items) => items.map(({ patch, ...item }) => item))),
      diff: (mode, options) => read(mode, options?.context ?? 2_147_483_647),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node, AppProcess.node, FSUtil.node] })
