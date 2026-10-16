import path from "path"
import { createHash, randomUUID } from "crypto"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import browserPackage from "./browser-deps/package.json" with { type: "text" }
import browserLock from "./browser-deps/bun.lock" with { type: "text" }
import { AppProcess, AppProcessError } from "../process"
import { LayerNode } from "../effect/layer-node"
import { Global } from "../global"
import { FSUtil } from "../fs-util"
import { EffectFlock } from "../util/effect-flock"
import { Hash } from "../util/hash"
import { httpClient } from "../effect/app-node-platform"

const LOCK_SHA256 = "3738d3008dadb06c005bf23cf386f260d2a682cc8859dcfa9f39595a6006017a"
const NODE_VERSION = "22.23.3"
const NODE_SHA256 = "9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e"
const NODE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}/win-x64/node.exe`
const MAX_NODE_BYTES = 128 * 1024 * 1024
const MAX_DOWNLOAD_MS = 3 * 60 * 1000
const MAX_INSTALL_MS = 8 * 60 * 1000
const MAX_PROCESS_OUTPUT = 1024 * 1024
const registry = "https://registry.npmjs.org/"

const BrowserManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    dependencies: Schema.Struct({ "@playwright/mcp": Schema.String }),
  }),
)

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    cacheIdentity: Schema.String,
    packageLockSha256: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    nodeVersion: Schema.String,
    nodePath: Schema.String,
    nodeSize: Schema.Number,
    nodeSha256: Schema.String,
    cliPath: Schema.String,
    cliSize: Schema.Number,
    cliSha256: Schema.String,
    embeddedPackageSha256: Schema.String,
    installedPackageSha256: Schema.String,
    packageFiles: Schema.Array(
      Schema.Struct({ relativePath: Schema.String, size: Schema.Number, sha256: Schema.String }),
    ),
    browserRoot: Schema.String,
    browserPath: Schema.String,
    browserSize: Schema.Number,
    browserSha256: Schema.String,
    browserFiles: Schema.Array(
      Schema.Struct({ relativePath: Schema.String, size: Schema.Number, sha256: Schema.String }),
    ),
  }),
)

export class UnsupportedPlatformError extends Schema.TaggedErrorClass<UnsupportedPlatformError>()(
  "ManagedBrowserUnsupportedPlatformError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message() {
    return `Managed Playwright is currently available for Windows x64; this host is ${this.platform}/${this.arch}`
  }
}

export class ManagedBrowserError extends Schema.TaggedErrorClass<ManagedBrowserError>()("ManagedBrowserError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail
  }
}

export interface PreparedBrowser {
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

const browserPackageText = browserPackage as unknown as string
const browserLockText = browserLock as unknown as string
const packageManifestSha256 = Hash.sha256(browserPackageText)
const packageLockSha256 = Hash.sha256(browserLockText)
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
      {
        global,
        fs,
        flock,
        process: appProcess,
        downloadNode: (url) => downloadNode(http, url),
      },
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
): Effect.Effect<PreparedBrowser, Error | EffectFlock.LockError | AppProcessError | FSUtil.Error> {
  return Effect.gen(function* () {
    const platform = services.platform ?? {
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    }
    const inheritedEnv =
      input.baseEnvironment ??
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
    if (platform.platform !== "win32" || platform.arch !== "x64")
      return yield* new UnsupportedPlatformError({ platform: platform.platform, arch: platform.arch })
    if (packageLockSha256 !== LOCK_SHA256)
      return yield* new ManagedBrowserError({ detail: "Embedded Playwright lockfile digest does not match" })

    const packageInfo = yield* Schema.decodeUnknownEffect(BrowserManifest)(browserPackageText).pipe(
      Effect.mapError(
        (cause) => new ManagedBrowserError({ detail: "Embedded Playwright package manifest is invalid", cause }),
      ),
    )
    const root = path.join(services.global.cache, "managed-browser", identity.slice(0, 20))
    const receiptPath = path.join(root, "receipt.json")
    const cliRelative = path.join("node_modules", "@playwright", "mcp", "cli.js")
    const packageRelative = path.join("node_modules", "@playwright", "mcp", "package.json")
    const expectedNodeSha256 = services.expectedNodeSha256 ?? NODE_SHA256

    const validateReceipt = Effect.gen(function* () {
      const raw = yield* services.fs.readFileStringSafe(receiptPath)
      if (!raw) return undefined
      const cached = Option.getOrUndefined(Schema.decodeUnknownOption(Receipt)(raw))
      if (!cached) return undefined
      if (
        cached.cacheIdentity !== identity ||
        cached.packageLockSha256 !== packageLockSha256 ||
        cached.platform !== "win32" ||
        cached.arch !== "x64" ||
        cached.nodeVersion !== NODE_VERSION ||
        cached.nodeSha256 !== expectedNodeSha256 ||
        cached.embeddedPackageSha256 !== packageManifestSha256 ||
        cached.nodeSize <= 0 ||
        cached.browserSize <= 0
      )
        return undefined

      const realRoot = yield* services.fs.realPath(root).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const installRoot = path.dirname(cached.nodePath)
      const realInstallRoot = yield* services.fs
        .realPath(installRoot)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!realRoot || !realInstallRoot || !FSUtil.contains(realRoot, realInstallRoot)) return undefined
      if (cached.nodePath !== path.join(installRoot, "node.exe")) return undefined
      if (cached.cliPath !== path.join(installRoot, cliRelative)) return undefined
      if (cached.browserRoot !== path.join(installRoot, "browsers")) return undefined
      if (path.dirname(installRoot) !== root || !path.basename(installRoot).startsWith("a-")) return undefined
      if (!FSUtil.contains(cached.browserRoot, cached.browserPath)) return undefined

      const packageFiles = yield* inventoryPlaywrightPackages(services.fs, installRoot).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!packageFiles || JSON.stringify(packageFiles) !== JSON.stringify(cached.packageFiles)) return undefined
      const browserFiles = yield* inventoryDirectory(
        services.fs,
        path.dirname(cached.browserPath),
        cached.browserRoot,
        {
          maxFiles: MAX_BROWSER_FILES,
          maxBytes: MAX_BROWSER_BYTES,
        },
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!browserFiles || JSON.stringify(browserFiles) !== JSON.stringify(cached.browserFiles)) return undefined

      const cliBytes = yield* services.fs.readFile(cached.cliPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const manifestBytes = yield* services.fs
        .readFile(path.join(installRoot, packageRelative))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const realNode = yield* services.fs.realPath(cached.nodePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const realBrowser = yield* services.fs
        .realPath(cached.browserPath)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const realBrowserRoot = yield* services.fs
        .realPath(cached.browserRoot)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const realCli = yield* services.fs.realPath(cached.cliPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (
        !cliBytes ||
        !manifestBytes ||
        !realNode ||
        !realBrowser ||
        !realBrowserRoot ||
        !realCli ||
        !FSUtil.contains(realInstallRoot, realNode) ||
        !FSUtil.contains(realBrowserRoot, realBrowser) ||
        !FSUtil.contains(realInstallRoot, realCli)
      )
        return undefined
      const nodeFile = yield* fingerprint(services.fs, cached.nodePath, MAX_NODE_BYTES).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const browserFile = yield* fingerprint(services.fs, cached.browserPath).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!nodeFile || !browserFile) return undefined
      if (nodeFile.size !== cached.nodeSize || nodeFile.sha256 !== cached.nodeSha256) return undefined
      if (browserFile.size !== cached.browserSize || browserFile.sha256 !== cached.browserSha256) return undefined
      if (cliBytes.length !== cached.cliSize || Hash.sha256(Buffer.from(cliBytes)) !== cached.cliSha256)
        return undefined
      if (Hash.sha256(Buffer.from(manifestBytes)) !== cached.installedPackageSha256) return undefined

      return {
        command: cached.nodePath,
        args: [cached.cliPath, ...input.args],
        env: { ...inheritedEnv, ...input.environment, PLAYWRIGHT_BROWSERS_PATH: cached.browserRoot, BUN_BE_BUN: "0" },
      } satisfies PreparedBrowser
    })

    return yield* services.flock.withLock(
      Effect.gen(function* () {
        const ready = yield* validateReceipt
        if (ready) return ready
        if (!(platform.isBun ?? typeof Bun !== "undefined"))
          return yield* new ManagedBrowserError({
            detail: "Preparing Playwright requires the embedded CUDIA Bun runtime",
          })

        yield* services.fs.ensureDir(root)
        const attempt = path.join(root, `a-${randomUUID().replaceAll("-", "").slice(0, 12)}`)
        const nodePath = path.join(attempt, "node.exe")
        const browserRoot = path.join(attempt, "browsers")
        const cliPath = path.join(attempt, cliRelative)
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
        const nodeEnv = {
          ...inheritedEnv,
          ...input.environment,
          BUN_BE_BUN: "0",
          PLAYWRIGHT_BROWSERS_PATH: browserRoot,
        }

        yield* services.fs.ensureDir(attempt)
        yield* services.fs.writeFileString(packagePath, browserPackageText)
        yield* services.fs.writeFileString(lockPath, browserLockText)
        yield* services.fs.writeFileString(npmrc, `registry=${registry}\n`)
        yield* services.fs.writeFileString(globalNpmrc, `registry=${registry}\n`)

        const nodeBytes = yield* services.downloadNode(NODE_URL).pipe(
          Effect.timeout(Duration.millis(MAX_DOWNLOAD_MS)),
          Effect.mapError(
            (cause) => new ManagedBrowserError({ detail: "Portable Node download failed or timed out", cause }),
          ),
        )
        if (nodeBytes.byteLength === 0 || nodeBytes.byteLength > MAX_NODE_BYTES)
          return yield* new ManagedBrowserError({ detail: "Portable Node download was empty or exceeded 128 MiB" })
        if (Hash.sha256(Buffer.from(nodeBytes)) !== expectedNodeSha256)
          return yield* new ManagedBrowserError({ detail: "Portable Node checksum did not match the pinned release" })
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
          return yield* new ManagedBrowserError({ detail: `Bun install failed with exit code ${bunInstall.exitCode}` })

        const installedPackage = yield* services.fs.readJson(path.join(attempt, packageRelative))
        if (
          !installedPackage ||
          typeof installedPackage !== "object" ||
          !("version" in installedPackage) ||
          installedPackage.version !== packageInfo.dependencies["@playwright/mcp"]
        )
          return yield* new ManagedBrowserError({
            detail: "Installed Playwright MCP package version did not match the lock",
          })
        if (!(yield* services.fs.isFile(cliPath)))
          return yield* new ManagedBrowserError({ detail: "Installed Playwright MCP CLI was not found" })

        const browserInstall = yield* services.process.run(
          ChildProcess.make(
            nodePath,
            [cliPath, "install-browser", "--no-shell", "--no-remove", "--no-progress", "chromium"],
            {
              cwd: attempt,
              env: nodeEnv,
              extendEnv: false,
              stdin: "ignore",
            },
          ),
          {
            timeout: Duration.millis(MAX_INSTALL_MS),
            maxOutputBytes: MAX_PROCESS_OUTPUT,
            maxErrorBytes: MAX_PROCESS_OUTPUT,
          },
        )
        if (browserInstall.exitCode !== 0)
          return yield* new ManagedBrowserError({
            detail: `Chromium install failed with exit code ${browserInstall.exitCode}`,
          })

        const locate = yield* services.process.run(
          ChildProcess.make(nodePath, ["-e", "process.stdout.write(require('playwright').chromium.executablePath())"], {
            cwd: attempt,
            env: nodeEnv,
            extendEnv: false,
            stdin: "ignore",
          }),
          { timeout: Duration.seconds(15), maxOutputBytes: 4096, maxErrorBytes: 4096 },
        )
        if (locate.exitCode !== 0)
          return yield* new ManagedBrowserError({
            detail: `Could not resolve the installed Chromium executable (exit ${locate.exitCode})`,
          })
        const browserPath = locate.stdout.toString("utf8").trim()
        if (!browserPath || !FSUtil.contains(browserRoot, browserPath))
          return yield* new ManagedBrowserError({
            detail: "Playwright resolved a Chromium path outside its managed browser directory",
          })
        const cliBytes = yield* services.fs
          .readFile(cliPath)
          .pipe(
            Effect.mapError(
              (cause) => new ManagedBrowserError({ detail: "Installed Playwright CLI is missing", cause }),
            ),
          )
        const manifestBytes = yield* services.fs.readFile(path.join(attempt, packageRelative))
        const packageFiles = yield* inventoryPlaywrightPackages(services.fs, attempt).pipe(
          Effect.mapError((cause) => new ManagedBrowserError({ detail: "Playwright package inventory failed", cause })),
        )
        const browserFile = yield* fingerprint(services.fs, browserPath).pipe(
          Effect.mapError(
            (cause) => new ManagedBrowserError({ detail: "Resolved Chromium executable cannot be verified", cause }),
          ),
        )
        const browserFiles = yield* inventoryDirectory(services.fs, path.dirname(browserPath), browserRoot, {
          maxFiles: MAX_BROWSER_FILES,
          maxBytes: MAX_BROWSER_BYTES,
        }).pipe(
          Effect.mapError(
            (cause) => new ManagedBrowserError({ detail: "Chromium distribution inventory failed", cause }),
          ),
        )
        const realAttempt = yield* services.fs
          .realPath(attempt)
          .pipe(
            Effect.mapError(
              (cause) => new ManagedBrowserError({ detail: "Managed browser attempt path is invalid", cause }),
            ),
          )
        const realBrowserRoot = yield* services.fs
          .realPath(browserRoot)
          .pipe(
            Effect.mapError(
              (cause) => new ManagedBrowserError({ detail: "Managed browser directory is missing", cause }),
            ),
          )
        const realBrowser = yield* services.fs
          .realPath(browserPath)
          .pipe(
            Effect.mapError(
              (cause) => new ManagedBrowserError({ detail: "Managed Chromium executable is missing", cause }),
            ),
          )
        if (!FSUtil.contains(realAttempt, realBrowserRoot) || !FSUtil.contains(realBrowserRoot, realBrowser))
          return yield* new ManagedBrowserError({
            detail: "Resolved Chromium executable escapes its managed directory",
          })
        if (browserFile.size === 0)
          return yield* new ManagedBrowserError({ detail: "Resolved Chromium executable is empty" })

        const receipt = {
          version: 1 as const,
          cacheIdentity: identity,
          packageLockSha256,
          platform: "win32",
          arch: "x64",
          nodeVersion: NODE_VERSION,
          nodePath,
          nodeSize: nodeBytes.byteLength,
          nodeSha256: Hash.sha256(Buffer.from(nodeBytes)),
          cliPath,
          cliSize: cliBytes.byteLength,
          cliSha256: Hash.sha256(Buffer.from(cliBytes)),
          embeddedPackageSha256: packageManifestSha256,
          installedPackageSha256: Hash.sha256(Buffer.from(manifestBytes)),
          packageFiles,
          browserRoot,
          browserPath,
          browserSize: browserFile.size,
          browserSha256: browserFile.sha256,
          browserFiles,
        }
        const receiptTemp = `${receiptPath}.${randomUUID()}.tmp`
        yield* services.fs.writeJson(receiptTemp, receipt)
        yield* services.fs.rename(receiptTemp, receiptPath)
        return {
          command: nodePath,
          args: [cliPath, ...input.args],
          env: { ...inheritedEnv, ...input.environment, PLAYWRIGHT_BROWSERS_PATH: browserRoot, BUN_BE_BUN: "0" },
        } satisfies PreparedBrowser
      }),
      `managed-playwright:${identity}`,
    )
  })
}

const PLAYWRIGHT_PACKAGE_PATHS = [
  path.join("node_modules", "@playwright", "mcp"),
  path.join("node_modules", "playwright"),
  path.join("node_modules", "playwright-core"),
] as const
const MAX_PACKAGE_FILES = 20_000
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024
const MAX_BROWSER_FILES = 20_000
const MAX_BROWSER_BYTES = 1024 * 1024 * 1024

function inventoryPlaywrightPackages(fs: FSUtil.Interface, root: string) {
  return Effect.gen(function* () {
    const realRoot = yield* fs.realPath(root)
    const files: { relativePath: string; size: number; sha256: string }[] = []
    let totalBytes = 0

    for (const packagePath of PLAYWRIGHT_PACKAGE_PATHS) {
      const logicalPath = path.join(root, packagePath)
      const packageRoot = yield* fs.realPath(logicalPath)
      if (!FSUtil.contains(realRoot, packageRoot))
        return yield* new ManagedBrowserError({ detail: "Playwright package path escapes managed install" })
      const packageInfo = yield* fs.stat(packageRoot)
      if (packageInfo.type !== "Directory")
        return yield* new ManagedBrowserError({ detail: "Playwright package directory is missing" })
      const packageFiles = yield* inventoryDirectory(fs, packageRoot, realRoot, {
        maxFiles: MAX_PACKAGE_FILES - files.length,
        maxBytes: MAX_PACKAGE_BYTES - totalBytes,
      })
      for (const file of packageFiles) {
        totalBytes += file.size
        if (files.length >= MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES)
          return yield* new ManagedBrowserError({ detail: "Playwright package inventory exceeded its size limit" })
        files.push({ ...file, relativePath: path.join(packagePath, file.relativePath) })
      }
    }

    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    return files
  })
}

function inventoryDirectory(
  fs: FSUtil.Interface,
  directory: string,
  containmentRoot: string,
  limits: { readonly maxFiles: number; readonly maxBytes: number },
) {
  return Effect.gen(function* () {
    const realRoot = yield* fs.realPath(directory)
    if (!FSUtil.contains(containmentRoot, realRoot))
      return yield* new ManagedBrowserError({ detail: "Managed inventory root escapes its containing directory" })
    const rootInfo = yield* fs.stat(realRoot)
    if (rootInfo.type !== "Directory")
      return yield* new ManagedBrowserError({ detail: "Managed inventory directory is missing" })
    const files: { relativePath: string; size: number; sha256: string }[] = []
    let totalBytes = 0
    const pending = [realRoot]
    while (pending.length > 0) {
      const current = pending.pop()!
      const entries = yield* fs.readDirectoryEntriesBounded(current, {
        maxEntries: limits.maxFiles,
        maxBytes: 4 * 1024 * 1024,
      })
      for (const entry of entries) {
        const target = path.join(current, entry.name)
        if (entry.type === "directory") {
          const realTarget = yield* fs.realPath(target)
          if (!FSUtil.contains(containmentRoot, realTarget))
            return yield* new ManagedBrowserError({ detail: "Managed inventory directory escapes its root" })
          pending.push(realTarget)
          continue
        }
        if (entry.type !== "file")
          return yield* new ManagedBrowserError({
            detail: "Managed inventory contains an unsupported filesystem entry",
          })
        const realTarget = yield* fs.realPath(target)
        if (!FSUtil.contains(containmentRoot, realTarget))
          return yield* new ManagedBrowserError({ detail: "Managed inventory file escapes its root" })
        if (files.length >= limits.maxFiles)
          return yield* new ManagedBrowserError({ detail: "Managed inventory exceeded its file limit" })
        const file = yield* fingerprint(fs, realTarget, limits.maxBytes - totalBytes)
        totalBytes += file.size
        if (files.length >= limits.maxFiles || totalBytes > limits.maxBytes)
          return yield* new ManagedBrowserError({ detail: "Managed inventory exceeded its size limit" })
        files.push({ relativePath: path.relative(realRoot, realTarget), ...file })
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    return files
  })
}

function fingerprint(fs: FSUtil.Interface, file: string, maxBytes = MAX_BROWSER_BYTES) {
  return Effect.gen(function* () {
    const info = yield* fs.stat(file)
    if (info.type !== "File" || info.size > BigInt(maxBytes))
      return yield* new ManagedBrowserError({ detail: "Managed runtime file is invalid or exceeded its byte limit" })
    const hash = createHash("sha256")
    let size = 0
    yield* fs.stream(file).pipe(
      Stream.runForEach((chunk) => {
        if (size + chunk.byteLength > maxBytes)
          return Effect.fail(new ManagedBrowserError({ detail: "Managed runtime file exceeded its byte limit" }))
        size += chunk.byteLength
        hash.update(chunk)
        return Effect.void
      }),
    )
    return { size, sha256: hash.digest("hex") }
  })
}

function downloadNode(http: HttpClient.HttpClient, url: string): Effect.Effect<Uint8Array, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const response = yield* http.execute(HttpClientRequest.get(url))
      if (response.status !== 200)
        return yield* new ManagedBrowserError({ detail: `Node download returned HTTP ${response.status}` })
      const contentLength = Number(response.headers["content-length"])
      if (Number.isFinite(contentLength) && contentLength > MAX_NODE_BYTES)
        return yield* new ManagedBrowserError({ detail: "Node download exceeded 128 MiB" })
      let size = 0
      const bounded = response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength
          return size > MAX_NODE_BYTES
            ? Effect.fail(new ManagedBrowserError({ detail: "Node download exceeded 128 MiB" }))
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
      cause instanceof ManagedBrowserError
        ? cause
        : new ManagedBrowserError({ detail: "Portable Node download failed or timed out", cause }),
    ),
  )
}

export * as ManagedBrowser from "./managed-browser"
