import path from "node:path"
import { open, symlink } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ManagedRea, type PrepareServices } from "@opencode-ai/core/mcp/managed-rea"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const nodeBytes = Buffer.from("portable-node-fixture")
const nodeSha256 = Hash.sha256(nodeBytes)
const platform = { platform: "win32", arch: "x64", execPath: "C:\\cudia.exe", isBun: true }

const makeCore = (root: string) =>
  AppNodeBuilder.build(LayerNode.group([Global.node, FSUtil.node, EffectFlock.node]), [
    [Global.node, Global.layerWith({ cache: path.join(root, "cache"), state: path.join(root, "state") })],
  ])

const successfulRun =
  (
    filesystem: FSUtil.Interface,
    counters: { runs: number },
    observed?: Array<{ command: string; args: string[]; env?: Record<string, string>; extendEnv?: boolean }>,
  ) =>
  (
    command: Parameters<PrepareServices["process"]["run"]>[0],
    _options?: Parameters<PrepareServices["process"]["run"]>[1],
  ) => {
    counters.runs++
    if (command._tag !== "StandardCommand") return Effect.die("Expected a standard process command")
    const args = command.args.map(String)
    observed?.push({
      command: command.command,
      args,
      env: command.options.env
        ? Object.fromEntries(
            Object.entries(command.options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          )
        : undefined,
      extendEnv: command.options.extendEnv,
    })
    return Effect.gen(function* () {
      if (args[0] === "install") {
        const rea = path.join(command.options.cwd!, "node_modules", "rea-agents")
        const scripts = path.join(rea, "scripts")
        yield* filesystem.ensureDir(scripts).pipe(Effect.orDie)
        yield* filesystem
          .writeJson(path.join(rea, "package.json"), { name: "rea-agents", version: "6.5.0" })
          .pipe(Effect.orDie)
        yield* filesystem
          .writeFileString(path.join(scripts, "rea.mjs"), "process.stdout.write('REA fixture')")
          .pipe(Effect.orDie)
        yield* filesystem
          .writeFileString(path.join(rea, "runtime.mjs"), "export const fixture = true")
          .pipe(Effect.orDie)
      }
      return {
        command: "fixture process",
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      } satisfies import("@opencode-ai/core/process").AppProcess.RunResult
    }).pipe(Effect.orDie)
  }

const servicesFor = (
  global: Global.Interface,
  filesystem: FSUtil.Interface,
  flock: EffectFlock.Interface,
  run: PrepareServices["process"]["run"],
  overrides: Partial<PrepareServices> = {},
): PrepareServices => ({
  global,
  fs: filesystem,
  flock,
  process: { run },
  downloadNode: () => Effect.succeed(nodeBytes),
  platform,
  expectedNodeSha256: nodeSha256,
  ...overrides,
})

describe("ManagedRea.prepareWithServices", () => {
  test("installs the pinned CLI once, preserves the caller environment, and validates the warm package cache", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const counters = { runs: 0, downloads: 0 }
    const observed: Array<{ command: string; args: string[]; env?: Record<string, string>; extendEnv?: boolean }> = []
    const result = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const services = servicesFor(global, filesystem, flock, successfulRun(filesystem, counters, observed), {
        downloadNode: () => {
          counters.downloads++
          return Effect.succeed(nodeBytes)
        },
      })
      const input = {
        args: ["mcp", "--fixture"],
        environment: { CUDIA_CONFIGURED: "explicit", CUDIA_SYNTHETIC_SECRET: "keep-this-value" },
        baseEnvironment: { Path: "C:\\Windows\\System32", HTTP_PROXY: "http://proxy.fixture" },
      }
      const first = yield* ManagedRea.prepareWithServices(input, services)
      const warm = yield* ManagedRea.prepareWithServices(
        { ...input, args: ["mcp", "--warm"], environment: { ...input.environment, pAtH: "C:\\operator\\bin" } },
        services,
      )
      const packageFile = path.join(path.dirname(first.command), "node_modules", "rea-agents", "runtime.mjs")
      yield* filesystem.writeFileString(packageFile, "changed fixture bytes")
      const rebuilt = yield* ManagedRea.prepareWithServices({ ...input, args: ["mcp", "--rebuilt"] }, services)
      yield* filesystem.remove(path.join(path.dirname(rebuilt.command), "node_modules", "rea-agents", "runtime.mjs"))
      const restored = yield* ManagedRea.prepareWithServices(input, services)
      return { first, warm, rebuilt, restored, input }
    }).pipe(Effect.provide(core), Effect.runPromise)

    expect(result.first.command).toContain("node.exe")
    expect(result.first.args).toEqual([expect.stringContaining("rea.mjs"), "mcp", "--fixture"])
    expect(result.first.env.PATH).toBe(`${path.dirname(result.first.command)}${path.delimiter}C:\\Windows\\System32`)
    expect(Object.keys(result.first.env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"])
    expect(result.first.env.HTTP_PROXY).toBe("http://proxy.fixture")
    expect(result.first.env.CUDIA_CONFIGURED).toBe("explicit")
    expect(result.first.env.CUDIA_SYNTHETIC_SECRET).toBe("keep-this-value")
    expect(result.first.env.BUN_BE_BUN).toBe("0")
    expect(result.warm.command).toBe(result.first.command)
    expect(result.warm.env.PATH).toBe(`${path.dirname(result.warm.command)}${path.delimiter}C:\\operator\\bin`)
    expect(Object.keys(result.warm.env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"])
    expect(result.warm.args.at(-1)).toBe("--warm")
    expect(result.rebuilt.command).not.toBe(result.first.command)
    expect(result.rebuilt.args.at(-1)).toBe("--rebuilt")
    expect(result.restored.command).not.toBe(result.rebuilt.command)
    expect(counters.downloads).toBe(3)
    expect(counters.runs).toBe(3)
    expect(observed).toHaveLength(3)
    expect(observed[0]).toMatchObject({
      args: ["install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"],
      extendEnv: false,
    })
    expect(observed[0]?.env).toMatchObject({
      BUN_BE_BUN: "1",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_userconfig: expect.stringContaining(".npmrc"),
    })
  })

  test("rejects a bad portable Node digest before invoking the installer or writing a receipt", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    let runs = 0
    const exit = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const services = servicesFor(
        global,
        filesystem,
        flock,
        () => {
          runs++
          return Effect.die("Installer must not run after checksum mismatch")
        },
        { downloadNode: () => Effect.succeed(Buffer.from("unexpected node bytes")) },
      )
      return yield* ManagedRea.prepareWithServices({ args: ["mcp"] }, services).pipe(Effect.exit)
    }).pipe(Effect.provide(core), Effect.runPromise)

    expect(exit._tag).toBe("Failure")
    expect(runs).toBe(0)
  })

  test("serializes simultaneous preparation and reuses the verified installation", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const counters = { runs: 0 }
    const result = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const run = successfulRun(filesystem, counters)
      const process: PrepareServices["process"]["run"] = (command, options) =>
        Effect.sleep(Duration.millis(10)).pipe(Effect.flatMap(() => run(command, options)))
      const services = servicesFor(global, filesystem, flock, process)
      return yield* Effect.all(
        [0, 1].map((index) => ManagedRea.prepareWithServices({ args: ["mcp", String(index)] }, services)),
        { concurrency: "unbounded" },
      )
    }).pipe(Effect.provide(core), Effect.runPromise)

    expect(result[0]?.command).toBe(result[1]?.command)
    expect(counters.runs).toBe(1)
  })

  test("interruption leaves no receipt and a later request can prepare a fresh attempt", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const entered = Promise.withResolvers<void>()
    let interrupted = false
    let hang = true
    const result = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const fallback = successfulRun(filesystem, { runs: 0 })
      const process: PrepareServices["process"]["run"] = (command, options) => {
        const args = command._tag === "StandardCommand" ? command.args.map(String) : []
        if (hang && args[0] === "install") {
          entered.resolve()
          return Effect.never.pipe(Effect.ensuring(Effect.sync(() => (interrupted = true))))
        }
        return fallback(command, options)
      }
      const services = servicesFor(global, filesystem, flock, process)
      return { global, filesystem, services }
    }).pipe(Effect.provide(core), Effect.runPromise)
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(ManagedRea.prepareWithServices({ args: ["mcp"] }, result.services), {
      signal: controller.signal,
    })
    await entered.promise
    controller.abort(new Error("fixture cancellation"))
    expect((await pending)._tag).toBe("Failure")
    expect(interrupted).toBe(true)

    const cacheRoot = path.join(result.global.cache, "managed-rea")
    const cacheContents = await result.filesystem
      .readDirectoryEntries(cacheRoot)
      .pipe(Effect.provide(core), Effect.runPromise)
    expect(cacheContents.every((entry) => entry.name !== "receipt.json")).toBe(true)
    hang = false
    const recovered = await Effect.runPromise(
      ManagedRea.prepareWithServices({ args: ["mcp", "--recovered"] }, result.services).pipe(Effect.provide(core)),
    )
    expect(recovered.args.at(-1)).toBe("--recovered")
  }, 15000)

  test("reports unsupported platforms before cache access or download", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    let downloads = 0
    const exit = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const services = servicesFor(global, filesystem, flock, () => Effect.die("Process must not run"), {
        platform: { platform: "linux", arch: "x64", execPath: "/cudia" },
        downloadNode: () => {
          downloads++
          return Effect.succeed(nodeBytes)
        },
      })
      return yield* ManagedRea.prepareWithServices({ args: ["mcp"] }, services).pipe(Effect.exit)
    }).pipe(Effect.provide(core), Effect.runPromise)

    expect(exit._tag).toBe("Failure")
    expect(downloads).toBe(0)
  })

  for (const invalid of ["escaping-directory", "aggregate-budget"] as const) {
    test(`rejects an installed ${invalid} without publishing a receipt`, async () => {
      await using tmp = await tmpdir()
      const core = makeCore(tmp.path)
      const result = await Effect.gen(function* () {
        const global = yield* Global.Service
        const filesystem = yield* FSUtil.Service
        const flock = yield* EffectFlock.Service
        const install = successfulRun(filesystem, { runs: 0 })
        const run: PrepareServices["process"]["run"] = (command, options) =>
          Effect.gen(function* () {
            const result = yield* install(command, options)
            if (command._tag !== "StandardCommand") return result
            const modules = path.join(command.options.cwd!, "node_modules")
            yield* Effect.tryPromise(async () => {
              if (invalid === "escaping-directory") {
                await symlink(tmp.path, path.join(modules, "escape"), "junction")
                return
              }
              for (const name of ["large-a", "large-b"]) {
                const handle = await open(path.join(modules, name), "w")
                try {
                  await handle.truncate(256 * 1024 * 1024 + 1)
                } finally {
                  await handle.close()
                }
              }
            }).pipe(Effect.orDie)
            return result
          })
        const exit = yield* ManagedRea.prepareWithServices(
          { args: ["mcp"] },
          servicesFor(global, filesystem, flock, run),
        ).pipe(Effect.exit)
        const identities = yield* filesystem.readDirectoryEntries(path.join(global.cache, "managed-rea"))
        const ready = yield* filesystem.exists(
          path.join(global.cache, "managed-rea", identities[0]!.name, "receipt.json"),
        )
        return { exit, ready }
      }).pipe(Effect.provide(core), Effect.runPromise)
      expect(result.exit._tag).toBe("Failure")
      expect(result.ready).toBe(false)
    })
  }

  test("cancels every parallel cache reader and leaves the published receipt unchanged", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const entered = Promise.withResolvers<void>()
    let readers = 0
    const prepared = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const services = servicesFor(global, filesystem, flock, successfulRun(filesystem, { runs: 0 }))
      const installed = yield* ManagedRea.prepareWithServices({ args: ["mcp"] }, services)
      const receiptPath = path.join(path.dirname(path.dirname(installed.command)), "receipt.json")
      const receipt = yield* filesystem.readFileString(receiptPath)
      const stream: FSUtil.Interface["stream"] = (file, options) =>
        file.includes("node_modules")
          ? Stream.fromEffect(
              Effect.sync(() => {
                readers++
                entered.resolve()
              }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => readers--))),
            )
          : filesystem.stream(file, options)
      return { services: { ...services, fs: { ...filesystem, stream } }, receiptPath, receipt }
    }).pipe(Effect.provide(core), Effect.runPromise)
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(ManagedRea.prepareWithServices({ args: ["mcp"] }, prepared.services), {
      signal: controller.signal,
    })
    await entered.promise
    controller.abort()
    expect((await pending)._tag).toBe("Failure")
    expect(readers).toBe(0)
    expect(await Bun.file(prepared.receiptPath).text()).toBe(prepared.receipt)
  })
})
