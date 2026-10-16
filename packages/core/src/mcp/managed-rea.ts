import path from "path"
import { createHash, randomUUID } from "crypto"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import reaPackage from "./rea-deps/package.json" with { type: "text" }
import reaLock from "./rea-deps/bun.lock" with { type: "text" }
import { AppProcess, AppProcessError } from "../process"
import { LayerNode } from "../effect/layer-node"
import { Global } from "../global"
import { FSUtil } from "../fs-util"
import { EffectFlock } from "../util/effect-flock"
import { Hash } from "../util/hash"
import { httpClient } from "../effect/app-node-platform"

const LOCK_SHA256 = "dd0163078350dbcaf412baaa9c519bdc706e8ef556db9a7da9f6a8eef63d8685"
const NODE_VERSION = "24.22.0"
const NODE_SHA256 = "ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c"
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`
const REA_VERSION = "6.5.0"
const MAX_NODE_BYTES = 128 * 1024 * 1024
const MAX_DOWNLOAD_MS = 3 * 60 * 1000
const MAX_INSTALL_MS = 8 * 60 * 1000
const MAX_PROCESS_OUTPUT = 1024 * 1024
const MAX_PACKAGE_FILES = 25_000
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const registry = "https://registry.npmjs.org/"
const cliRelative = path.join("node_modules", "rea-agents", "scripts", "rea.mjs")

const ReaManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.Literal("cudia-managed-rea"),
    version: Schema.Literal("1.0.0"),
    private: Schema.Literal(true),
    dependencies: Schema.Struct({ "rea-agents": Schema.Literal(REA_VERSION) }),
  }),
)

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    cacheIdentity: Schema.String,
    packageLockSha256: Schema.String,
    platform: Schema.Literal("win32"),
    arch: Schema.Literal("x64"),
    nodeVersion: Schema.Literal(NODE_VERSION),
    nodePath: Schema.String,
    nodeSize: Schema.Number,
    nodeSha256: Schema.String,
    cliPath: Schema.String,
    cliSize: Schema.Number,
    cliSha256: Schema.String,
    packageManifestSha256: Schema.String,
    installedManifestSha256: Schema.String,
    packageFiles: Schema.Array(
      Schema.Struct({ relativePath: Schema.String, size: Schema.Number, sha256: Schema.String }),
    ),
  }),
)

export class UnsupportedPlatformError extends Schema.TaggedErrorClass<UnsupportedPlatformError>()(
  "ManagedReaUnsupportedPlatformError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message() {
    return `Managed REA is currently available for Windows x64; this host is ${this.platform}/${this.arch}`
  }
}

export class ManagedReaError extends Schema.TaggedErrorClass<ManagedReaError>()("ManagedReaError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail
  }
}

export interface PreparedRea {
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string>
}

export interface PrepareServices {
  readonly global: Pick<Global.Interface, "cache">
  readonly fs: FSUtil.Interface
  readonly flock: Pick<EffectFlock.Interface, "withLock">
  readonly process: Pick<AppProcess.Interface, "run">
  readonly downloadNode: (url: string) => Effect.Effect<Uint8Array, Error>
  readonly platform?: {
    readonly platform: string
    readonly arch: string
    readonly execPath: string
    readonly isBun?: boolean
  }
  readonly expectedNodeSha256?: string
}

const packageText = reaPackage as unknown as string
const lockText = reaLock as unknown as string
const packageManifestSha256 = Hash.sha256(packageText)
const packageLockSha256 = Hash.sha256(lockText)
const identity = Hash.sha256(`${packageManifestSha256}:${packageLockSha256}:${NODE_VERSION}:${NODE_SHA256}:win32:x64`)
const layerNodes = LayerNode.group([Global.node, FSUtil.node, AppProcess.node, EffectFlock.node, httpClient])
const layer = LayerNode.compile(layerNodes)

export function prepare(
  args: readonly string[],
  environment: Record<string, string> = {},
  baseEnvironment?: Record<string, string>,
) {
  return Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const appProcess = yield* AppProcess.Service
    const http = yield* HttpClient.HttpClient
    return yield* prepareWithServices(
      { args, environment, baseEnvironment },
      { global, fs, flock, process: appProcess, downloadNode: (url) => downloadNode(http, url) },
    )
  }).pipe(Effect.provide(layer))
}

export function prepareWithServices(
  input: {
    readonly args: readonly string[]
    readonly environment?: Record<string, string>
    readonly baseEnvironment?: Record<string, string>
  },
  services: PrepareServices,
): Effect.Effect<PreparedRea, Error | EffectFlock.LockError | AppProcessError | FSUtil.Error> {
  return Effect.gen(function* () {
    const platform = services.platform ?? { platform: process.platform, arch: process.arch, execPath: process.execPath }
    const inheritedEnv =
      input.baseEnvironment ??
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
    if (platform.platform !== "win32" || platform.arch !== "x64")
      return yield* new UnsupportedPlatformError({ platform: platform.platform, arch: platform.arch })
    if (packageLockSha256 !== LOCK_SHA256)
      return yield* new ManagedReaError({ detail: "Embedded REA lockfile digest does not match" })
    const manifest = yield* Schema.decodeUnknownEffect(ReaManifest)(packageText).pipe(
      Effect.mapError((cause) => new ManagedReaError({ detail: "Embedded REA package manifest is invalid", cause })),
    )
    if (manifest.dependencies["rea-agents"] !== REA_VERSION)
      return yield* new ManagedReaError({ detail: "Embedded REA version does not match the pinned CLI" })

    const root = path.join(services.global.cache, "managed-rea", identity.slice(0, 20))
    const receiptPath = path.join(root, "receipt.json")
    const expectedNodeSha256 = services.expectedNodeSha256 ?? NODE_SHA256
    const launchEnv = (nodePath: string) => {
      const merged = { ...inheritedEnv, ...input.environment }
      const pathValue =
        Object.entries(input.environment ?? {}).find(([key]) => key.toLowerCase() === "path")?.[1] ??
        Object.entries(inheritedEnv).find(([key]) => key.toLowerCase() === "path")?.[1] ??
        ""
      return {
        ...Object.fromEntries(Object.entries(merged).filter(([key]) => key.toLowerCase() !== "path")),
        PATH: `${path.dirname(nodePath)}${path.delimiter}${pathValue}`,
        BUN_BE_BUN: "0",
      }
    }

    const validateReceipt = Effect.gen(function* () {
      const raw = yield* services.fs.readFileStringSafe(receiptPath)
      if (!raw) return undefined
      const receipt = Option.getOrUndefined(Schema.decodeUnknownOption(Receipt)(raw))
      if (
        !receipt ||
        receipt.cacheIdentity !== identity ||
        receipt.packageLockSha256 !== packageLockSha256 ||
        receipt.packageManifestSha256 !== packageManifestSha256 ||
        receipt.nodeSha256 !== expectedNodeSha256 ||
        receipt.nodeSize <= 0
      )
        return undefined
      const realRoot = yield* services.fs.realPath(root).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const attempt = path.dirname(receipt.nodePath)
      const realAttempt = yield* services.fs.realPath(attempt).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!realRoot || !realAttempt || !FSUtil.contains(realRoot, realAttempt)) return undefined
      if (path.dirname(attempt) !== root || !path.basename(attempt).startsWith("a-")) return undefined
      if (receipt.nodePath !== path.join(attempt, "node.exe")) return undefined
      if (receipt.cliPath !== path.join(attempt, cliRelative)) return undefined
      const packageFiles = yield* inventory(services.fs, path.join(attempt, "node_modules")).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!packageFiles || JSON.stringify(packageFiles) !== JSON.stringify(receipt.packageFiles)) return undefined
      const node = yield* fingerprint(services.fs, receipt.nodePath, MAX_NODE_BYTES).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const cli = yield* fingerprint(services.fs, receipt.cliPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const installedManifest = yield* services.fs
        .readFile(path.join(attempt, "package.json"))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const lockBytes = yield* services.fs
        .readFile(path.join(attempt, "bun.lock"))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const installedRea = yield* services.fs
        .readJson(path.join(attempt, "node_modules", "rea-agents", "package.json"))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (
        !node ||
        !cli ||
        !installedManifest ||
        !lockBytes ||
        !installedRea ||
        typeof installedRea !== "object" ||
        !("version" in installedRea) ||
        installedRea.version !== REA_VERSION ||
        node.size !== receipt.nodeSize ||
        node.sha256 !== receipt.nodeSha256
      )
        return undefined
      if (cli.size !== receipt.cliSize || cli.sha256 !== receipt.cliSha256) return undefined
      if (Hash.sha256(Buffer.from(installedManifest)) !== receipt.installedManifestSha256) return undefined
      if (Hash.sha256(Buffer.from(lockBytes)) !== packageLockSha256) return undefined
      return {
        command: receipt.nodePath,
        args: [receipt.cliPath, ...input.args],
        env: launchEnv(receipt.nodePath),
      } satisfies PreparedRea
    })

    return yield* services.flock.withLock(
      Effect.gen(function* () {
        const cached = yield* validateReceipt
        if (cached) return cached
        if (!(platform.isBun ?? typeof Bun !== "undefined"))
          return yield* new ManagedReaError({ detail: "Preparing REA requires the embedded CUDIA Bun runtime" })
        yield* services.fs.ensureDir(root)
        const attempt = path.join(root, `a-${randomUUID().replaceAll("-", "").slice(0, 12)}`)
        const nodePath = path.join(attempt, "node.exe")
        const packagePath = path.join(attempt, "package.json")
        const lockPath = path.join(attempt, "bun.lock")
        const npmrc = path.join(attempt, ".npmrc")
        const globalNpmrc = path.join(attempt, "global.npmrc")
        const bunCache = path.join(attempt, "bun-cache")
        const installEnv = {
          ...inheritedEnv,
          ...input.environment,
          BUN_BE_BUN: "1",
          BUN_CONFIG_REGISTRY: registry,
          BUN_INSTALL_CACHE_DIR: bunCache,
          npm_config_globalconfig: globalNpmrc,
          npm_config_registry: registry,
          npm_config_userconfig: npmrc,
        }
        yield* services.fs.ensureDir(attempt)
        yield* services.fs.writeFileString(packagePath, packageText)
        yield* services.fs.writeFileString(lockPath, lockText)
        yield* services.fs.writeFileString(npmrc, `registry=${registry}\n`)
        yield* services.fs.writeFileString(globalNpmrc, `registry=${registry}\n`)

        const nodeBytes = yield* services.downloadNode(NODE_URL).pipe(
          Effect.timeout(Duration.millis(MAX_DOWNLOAD_MS)),
          Effect.mapError(
            (cause) => new ManagedReaError({ detail: "Portable Node download failed or timed out", cause }),
          ),
        )
        if (nodeBytes.byteLength === 0 || nodeBytes.byteLength > MAX_NODE_BYTES)
          return yield* new ManagedReaError({ detail: "Portable Node download was empty or exceeded 128 MiB" })
        if (Hash.sha256(Buffer.from(nodeBytes)) !== expectedNodeSha256)
          return yield* new ManagedReaError({ detail: "Portable Node checksum did not match the pinned release" })
        yield* services.fs.writeFile(nodePath, nodeBytes)

        const bunInstall = yield* services.process.run(
          ChildProcess.make(platform.execPath, ["install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"], {
            cwd: attempt,
            env: installEnv,
            extendEnv: false,
            stdin: "ignore",
          }),
          {
            timeout: Duration.millis(MAX_INSTALL_MS),
            maxOutputBytes: MAX_PROCESS_OUTPUT,
            maxErrorBytes: MAX_PROCESS_OUTPUT,
          },
        )
        if (bunInstall.exitCode !== 0)
          return yield* new ManagedReaError({ detail: `Bun install failed with exit code ${bunInstall.exitCode}` })

        const installedManifest = yield* services.fs.readJson(packagePath)
        if (
          !installedManifest ||
          typeof installedManifest !== "object" ||
          !("dependencies" in installedManifest) ||
          typeof installedManifest.dependencies !== "object" ||
          installedManifest.dependencies === null ||
          !("rea-agents" in installedManifest.dependencies) ||
          installedManifest.dependencies["rea-agents"] !== REA_VERSION
        )
          return yield* new ManagedReaError({ detail: "Installed REA manifest did not match version 6.5.0" })
        const installedRea = yield* services.fs.readJson(
          path.join(attempt, "node_modules", "rea-agents", "package.json"),
        )
        if (
          !installedRea ||
          typeof installedRea !== "object" ||
          !("version" in installedRea) ||
          installedRea.version !== REA_VERSION
        )
          return yield* new ManagedReaError({ detail: "Installed REA package version did not match 6.5.0" })
        const cliPath = path.join(attempt, cliRelative)
        if (!(yield* services.fs.isFile(cliPath)))
          return yield* new ManagedReaError({ detail: "Installed REA CLI entrypoint was not found" })

        const packageFiles = yield* inventory(services.fs, path.join(attempt, "node_modules"))
        const cli = yield* fingerprint(services.fs, cliPath)
        const node = yield* fingerprint(services.fs, nodePath, MAX_NODE_BYTES)
        const manifestBytes = yield* services.fs.readFile(packagePath)
        const receipt = {
          version: 1 as const,
          cacheIdentity: identity,
          packageLockSha256,
          platform: "win32" as const,
          arch: "x64" as const,
          nodeVersion: NODE_VERSION,
          nodePath,
          nodeSize: node.size,
          nodeSha256: node.sha256,
          cliPath,
          cliSize: cli.size,
          cliSha256: cli.sha256,
          packageManifestSha256,
          installedManifestSha256: Hash.sha256(Buffer.from(manifestBytes)),
          packageFiles,
        }
        const receiptTemp = `${receiptPath}.${randomUUID()}.tmp`
        yield* services.fs.writeJson(receiptTemp, receipt)
        yield* services.fs.rename(receiptTemp, receiptPath)
        return { command: nodePath, args: [cliPath, ...input.args], env: launchEnv(nodePath) } satisfies PreparedRea
      }),
      `managed-rea:${identity}`,
    )
  })
}

function inventory(fs: FSUtil.Interface, root: string) {
  return Effect.gen(function* () {
    const realRoot = yield* fs.realPath(root)
    const targets: string[] = []
    const budget = { reserved: 0, read: 0 }
    const pending = [realRoot]
    while (pending.length > 0) {
      const directory = pending.pop()!
      const entries = yield* fs.readDirectoryEntriesBounded(directory, {
        maxEntries: MAX_PACKAGE_FILES,
        maxBytes: 4 * 1024 * 1024,
      })
      for (const entry of entries) {
        if (entry.name === ".bin" && path.basename(directory) === "node_modules") continue
        const target = path.join(directory, entry.name)
        if (entry.type === "directory") {
          const real = yield* fs.realPath(target)
          if (!FSUtil.contains(realRoot, real))
            return yield* new ManagedReaError({ detail: "REA package directory escapes its managed install" })
          pending.push(real)
          continue
        }
        if (entry.type !== "file")
          return yield* new ManagedReaError({
            detail: "REA package inventory contains an unsupported filesystem entry",
          })
        if (targets.length >= MAX_PACKAGE_FILES)
          return yield* new ManagedReaError({ detail: "REA package inventory exceeded 25,000 files" })
        targets.push(target)
      }
    }
    const files = yield* Effect.forEach(
      targets,
      (target) =>
        Effect.gen(function* () {
          const real = yield* fs.realPath(target)
          if (!FSUtil.contains(realRoot, real))
            return yield* new ManagedReaError({ detail: "REA package file escapes its managed install" })
          const file = yield* fingerprint(fs, real, MAX_PACKAGE_BYTES, budget)
          return { relativePath: path.relative(realRoot, real), ...file }
        }),
      { concurrency: 8 },
    )
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    return files
  })
}

function fingerprint(
  fs: FSUtil.Interface,
  file: string,
  maxBytes = MAX_PACKAGE_BYTES,
  budget?: { reserved: number; read: number },
) {
  return Effect.gen(function* () {
    const info = yield* fs.stat(file)
    if (info.type !== "File" || info.size > BigInt(maxBytes))
      return yield* new ManagedReaError({ detail: "Managed REA file is invalid or exceeds its byte limit" })
    if (budget) {
      if (budget.reserved + Number(info.size) > MAX_PACKAGE_BYTES)
        return yield* new ManagedReaError({ detail: "REA package inventory exceeded 512 MiB" })
      budget.reserved += Number(info.size)
    }
    const hash = createHash("sha256")
    let size = 0
    yield* fs.stream(file).pipe(
      Stream.runForEach((chunk) => {
        if (size + chunk.byteLength > maxBytes)
          return Effect.fail(new ManagedReaError({ detail: "Managed REA file exceeded its byte limit" }))
        if (budget) {
          if (budget.read + chunk.byteLength > MAX_PACKAGE_BYTES)
            return Effect.fail(new ManagedReaError({ detail: "REA package inventory exceeded 512 MiB" }))
          budget.read += chunk.byteLength
        }
        size += chunk.byteLength
        hash.update(chunk)
        return Effect.void
      }),
    )
    if (BigInt(size) !== info.size)
      return yield* new ManagedReaError({ detail: "Managed REA file changed size during verification" })
    return { size, sha256: hash.digest("hex") }
  })
}

function downloadNode(http: HttpClient.HttpClient, url: string): Effect.Effect<Uint8Array, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const response = yield* http.execute(HttpClientRequest.get(url))
      if (response.status !== 200)
        return yield* new ManagedReaError({ detail: `Node download returned HTTP ${response.status}` })
      const contentLength = Number(response.headers["content-length"])
      if (Number.isFinite(contentLength) && contentLength > MAX_NODE_BYTES)
        return yield* new ManagedReaError({ detail: "Node download exceeded 128 MiB" })
      let size = 0
      const bounded = response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength
          return size > MAX_NODE_BYTES
            ? Effect.fail(new ManagedReaError({ detail: "Node download exceeded 128 MiB" }))
            : Effect.succeed(chunk)
        }),
      )
      const body = yield* Stream.runFold(
        bounded,
        () => ({ chunks: [] as Uint8Array[], size: 0 }),
        (state, chunk) => {
          state.size += chunk.length
          state.chunks.push(chunk)
          return state
        },
      )
      return Buffer.concat(body.chunks).subarray(0, body.size)
    }),
  ).pipe(
    Effect.timeout(Duration.millis(MAX_DOWNLOAD_MS)),
    Effect.mapError((cause) =>
      cause instanceof ManagedReaError
        ? cause
        : new ManagedReaError({ detail: "Portable Node download failed or timed out", cause }),
    ),
  )
}

export * as ManagedRea from "./managed-rea"
