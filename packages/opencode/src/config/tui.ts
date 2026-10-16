export * as TuiConfig from "./tui"

import path from "path"
import { mergeDeep, unique } from "remeda"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Context, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import { ConfigPaths } from "@/config/paths"
import { ConfigDistribution } from "@opencode-ai/core/config/distribution"
import { migrateTuiConfig } from "./tui-migrate"
import { resolveHostAttentionSoundPaths } from "./tui-host-attention"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@opencode-ai/tui/util/record"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CurrentWorkingDirectory } from "./tui-cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@opencode-ai/core/npm"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { TuiConfig } from "@opencode-ai/tui/config"

export const Info = TuiConfig.Info
export type Info = TuiConfig.Info

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = TuiConfig.Resolved

export type HostMetadata = {
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly pluginOrigins: () => Effect.Effect<ConfigPlugin.Origin[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TuiConfig") {}

function pluginScope(file: string, ctx: { directory: string }): ConfigPlugin.Scope {
  if (Filesystem.contains(ctx.directory, file)) return "local"
  // if (ctx.worktree !== "/" && Filesystem.contains(ctx.worktree, file)) return "local"
  return "global"
}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* FSUtil.Service
  const distribution = yield* Effect.promise(() => ConfigDistribution.resolve())
  let appliedOrder = 0

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      return {
        ...config,
        plugin: yield* Effect.forEach(plugins, (plugin) =>
          Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugin as ConfigPlugin.Origin["spec"], configFilepath)),
        ),
      }
    })

  const load = (text: string, configFilepath: string, readOnly = false): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (readOnly) ConfigDistribution.validate(data, configFilepath)
      if (!isRecord(data)) {
        if (readOnly) throw new Error(`Invalid distribution TUI configuration: ${configFilepath}`)
        return {} as Info
      }
      if (readOnly && "tui" in data && !isRecord(data.tui)) {
        throw new Error(`Invalid distribution TUI configuration: ${configFilepath}`)
      }
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old opencode.json shape) still get their settings applied.
      const normalized = readOnly ? normalize(data) : dropUnknownKeybinds(normalize(data))
      if (readOnly && isRecord(normalized.keybinds) && TuiKeybind.unknownKeys(normalized.keybinds).length) {
        throw new Error(`Invalid distribution TUI keybinds: ${configFilepath}`)
      }
      const parsed = readOnly
        ? yield* Schema.decodeUnknownEffect(Info, { errors: "all", onExcessProperty: "error" })(normalized).pipe(
            Effect.catch((cause) =>
              Effect.die(new Error(`Invalid distribution TUI configuration: ${configFilepath}`, { cause })),
            ),
          )
        : ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveHostAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        readOnly
          ? Effect.failCause(cause).pipe(Effect.orDie)
          : Effect.logWarning("skipping invalid tui config", {
              path: configFilepath,
              reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
            }).pipe(Effect.as({} as Info)),
      ),
    )

  const loadFile = (filepath: string, readOnly = false): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          readOnly
            ? Effect.failCause(cause).pipe(Effect.orDie)
            : Effect.logWarning("failed to read tui config", {
                path: filepath,
                reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
              }).pipe(Effect.as(undefined)),
        ),
      )
      if (text === undefined || (!text && !readOnly)) return {} as Info
      yield* Effect.logInfo("loading tui config", { path: filepath })
      return yield* load(text, filepath, readOnly)
    })

  const mergeFile = (acc: Acc, file: string, readOnly = false) =>
    Effect.gen(function* () {
      // The distribution is applied once, below all user sources, even when a
      // user path or cwd reaches it through a symlink or junction.
      if (!readOnly && distribution && (yield* Effect.promise(() => distribution.contains(file)))) return
      const data = yield* loadFile(file, readOnly)
      if (Object.keys(data).length) {
        appliedOrder += 1
        yield* Effect.logInfo("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const scope = pluginScope(file, ctx)
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec: spec as ConfigPlugin.Origin["spec"], scope, source: file })),
      ])
      acc.result = {
        ...acc.result,
        plugin: plugins.map((item) => item.spec),
      }
      acc.plugin_origins = plugins
    })

  // Every config dir we may read from: global config dir, any `.opencode`
  // folders between cwd and home, and OPENCODE_CONFIG_DIR.
  const sources = yield* ConfigPaths.sources(ctx.directory)
  const directories = sources.filter((source) => !source.readOnly).map((source) => source.path)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  const projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)

  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  for (const source of sources.filter((source) => source.readOnly)) {
    for (const file of ConfigPaths.fileInDirectory(source.path, "tui")) {
      yield* mergeFile(acc, file, true)
    }
  }

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 2. Explicit OPENCODE_TUI_CONFIG override, if set.
  if (Flag.OPENCODE_TUI_CONFIG) {
    const configFile = Flag.OPENCODE_TUI_CONFIG
    yield* mergeFile(acc, configFile)
    yield* Effect.logDebug("loaded custom tui config", { path: configFile })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    yield* mergeFile(acc, file)
  }

  // 4. `.opencode` directories (and OPENCODE_CONFIG_DIR) discovered while
  // walking up the tree. Also returned below so callers can install plugin
  // dependencies from each location.
  const dirs = unique(directories).filter((dir) => dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR)

  for (const dir of dirs) {
    if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file)
    }
  }

  const result = TuiConfig.resolve(
    {
      ...acc.result,
    },
    {
      terminalSuspend: process.platform !== "win32",
    },
  )

  return {
    config: result,
    pluginOrigins: acc.plugin_origins,
    dirs: result.plugin?.length ? dirs : [],
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const npm = yield* Npm.Service
    const data = yield* loadState({ directory })
    const deps = yield* Effect.forEach(
      data.dirs,
      (dir) =>
        npm
          .install(dir, {
            add: [
              {
                name: "@opencode-ai/plugin",
                version: InstallationLocal ? undefined : InstallationVersion,
              },
            ],
          })
          .pipe(Effect.forkScoped),
      {
        concurrency: "unbounded",
      },
    )

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    const pluginOrigins = Effect.fn("TuiConfig.pluginOrigins")(() => Effect.succeed(data.pluginOrigins))

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, pluginOrigins, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Npm.node, FSUtil.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}

export async function pluginOrigins() {
  return runPromise((svc) => svc.pluginOrigins())
}
