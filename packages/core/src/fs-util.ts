import { NodeFileSystem } from "@effect/platform-node"
import { dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from "path"
import { realpathSync } from "fs"
import * as NFS from "fs/promises"
import { lookup } from "mime-types"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"
import { serviceUse } from "./effect/service-use"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"

export namespace FSUtil {
  export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
      return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
    }
  }

  export class DirectoryLimitError extends Schema.TaggedErrorClass<DirectoryLimitError>()("DirectoryLimitError", {
    reason: Schema.Literals(["entries", "bytes"]),
    maximum: Schema.Number,
  }) {
    override get message() {
      return `Directory listing exceeded ${this.reason} limit of ${this.maximum}`
    }
  }

  export class DiscoveryLimitError extends Schema.TaggedErrorClass<DiscoveryLimitError>()("DiscoveryLimitError", {
    maximumResults: Schema.Number,
  }) {
    override get message() {
      return `Filesystem discovery exceeded result limit of ${this.maximumResults}`
    }
  }

  export type Error = PlatformError | FileSystemError | DirectoryLimitError | DiscoveryLimitError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly readDirectoryEntriesBounded: (
      path: string,
      options?: { maxEntries?: number; maxBytes?: number },
    ) => Effect.Effect<DirEntry[], Error>
    readonly resolve: (path: string) => Effect.Effect<string>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: {
      targets: string[]
      start: string
      stop?: string
      maxResults?: number
    }) => Effect.Effect<string[], Error>
    readonly globUp: (
      pattern: string,
      start: string,
      stop?: string,
      options?: { maxResults?: number },
    ) => Effect.Effect<string[], Error>
    readonly glob: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

  export const use = serviceUse(Service)

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        return yield* fs.readFileString(path).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(undefined)),
        )
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await NFS.readdir(dirPath, { withFileTypes: true })
            return entries.map(
              (e): DirEntry => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
              }),
            )
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      const readDirectoryEntriesBounded = Effect.fn("FileSystem.readDirectoryEntriesBounded")(function (
        dirPath: string,
        options?: { maxEntries?: number; maxBytes?: number },
      ) {
        return Effect.scoped(
          Effect.gen(function* () {
            const maxEntries = options?.maxEntries ?? 100_000
            const maxBytes = options?.maxBytes ?? 16 * 1024 * 1024
            if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
              return yield* Effect.fail(
                new FileSystemError({
                  method: "readDirectoryEntriesBounded",
                  cause: new RangeError("maxEntries must be a nonnegative safe integer"),
                }),
              )
            }
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
              return yield* Effect.fail(
                new FileSystemError({
                  method: "readDirectoryEntriesBounded",
                  cause: new RangeError("maxBytes must be a nonnegative safe integer"),
                }),
              )
            }
            if (maxBytes < 2) return yield* Effect.fail(new DirectoryLimitError({ reason: "bytes", maximum: maxBytes }))
            let inFlight: Promise<unknown> | undefined
            const directory = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => NFS.opendir(dirPath, { bufferSize: 32 }),
                catch: (cause) => new FileSystemError({ method: "readDirectoryEntriesBounded", cause }),
              }),
              (handle) =>
                Effect.promise(async () => {
                  if (inFlight) await inFlight.catch(() => undefined)
                  await Promise.resolve()
                    .then(() => handle.close())
                    .catch(() => undefined)
                }),
            )
            const entries: DirEntry[] = []
            let bytes = 2
            while (true) {
              const reading = Promise.resolve().then(() => directory.read())
              inFlight = reading
              const entry = yield* Effect.tryPromise({
                try: (signal) => {
                  let abort: (() => void) | undefined
                  const interrupted = new Promise<never>((_, reject) => {
                    abort = () => reject(signal.reason)
                    if (signal.aborted) abort()
                    else signal.addEventListener("abort", abort, { once: true })
                  })
                  return Promise.race([reading, interrupted]).finally(() => {
                    if (abort) signal.removeEventListener("abort", abort)
                  })
                },
                catch: (cause) => new FileSystemError({ method: "readDirectoryEntriesBounded", cause }),
              })
              inFlight = undefined
              if (!entry) return entries
              const result: DirEntry = {
                name: entry.name,
                type: entry.isDirectory()
                  ? "directory"
                  : entry.isSymbolicLink()
                    ? "symlink"
                    : entry.isFile()
                      ? "file"
                      : "other",
              }
              if (entries.length + 1 > maxEntries)
                return yield* Effect.fail(new DirectoryLimitError({ reason: "entries", maximum: maxEntries }))
              const metadataBytes =
                bytes + Buffer.byteLength(JSON.stringify(result), "utf8") + (entries.length === 0 ? 0 : 1)
              if (metadataBytes > maxBytes)
                return yield* Effect.fail(new DirectoryLimitError({ reason: "bytes", maximum: maxBytes }))
              bytes = metadataBytes
              entries.push(result)
            }
          }),
        )
      })

      const resolve = Effect.fn("FileSystem.resolve")(function* (path: string) {
        const resolved = pathResolve(windowsPath(path))
        return yield* fs.realPath(resolved).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(resolved)),
          Effect.orDie,
        )
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new FileSystemError({ method: "readJson", cause }),
        })
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true }).pipe(
          // Bun on Windows can throw EEXIST here despite recursive mode.
          // https://github.com/oven-sh/bun/issues/21901
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            (error) => isDir(path).pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
          ),
        )
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const glob = Effect.fn("FileSystem.glob")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: (signal) => Glob.scan(pattern, options, signal),
          catch: (cause) =>
            cause instanceof Glob.ResultLimitError
              ? new DiscoveryLimitError({ maximumResults: cause.maximumResults })
              : new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: {
        targets: string[]
        start: string
        stop?: string
        maxResults?: number
      }) {
        const maxResults = options.maxResults
        if (maxResults !== undefined && (!Number.isSafeInteger(maxResults) || maxResults < 0)) {
          return yield* Effect.fail(
            new FileSystemError({
              method: "up",
              cause: new RangeError("maxResults must be a nonnegative safe integer"),
            }),
          )
        }
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) {
              if (maxResults !== undefined && result.length >= maxResults) {
                return yield* Effect.fail(new DiscoveryLimitError({ maximumResults: maxResults }))
              }
              result.push(search)
            }
          }
          if (options.stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (
        pattern: string,
        start: string,
        stop?: string,
        options?: { maxResults?: number },
      ) {
        const maxResults = options?.maxResults
        if (maxResults !== undefined && (!Number.isSafeInteger(maxResults) || maxResults < 0)) {
          return yield* Effect.fail(
            new FileSystemError({
              method: "globUp",
              cause: new RangeError("maxResults must be a nonnegative safe integer"),
            }),
          )
        }
        const result: string[] = []
        let current = start
        while (true) {
          const scan = glob(pattern, {
            cwd: current,
            absolute: true,
            include: "file",
            dot: true,
            ...(maxResults === undefined ? {} : { maxResults: maxResults - result.length }),
          })
          const matches = yield* maxResults === undefined
            ? scan.pipe(Effect.catch(() => Effect.succeed([] as string[])))
            : scan.pipe(
                Effect.catchTag("DiscoveryLimitError", () =>
                  Effect.fail(new DiscoveryLimitError({ maximumResults: maxResults })),
                ),
              )
          result.push(...matches)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        readDirectoryEntriesBounded,
        resolve,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        glob,
        globMatch: Glob.match,
      })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [filesystem] })

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = pathResolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = pathResolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT") return normalizePath(resolved)
      throw e
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  export function overlaps(a: string, b: string) {
    return contains(a, b) || contains(b, a)
  }

  export function contains(parent: string, child: string) {
    const result = relative(parent, child)
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  }
}
