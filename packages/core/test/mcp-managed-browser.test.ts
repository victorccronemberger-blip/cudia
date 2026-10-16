import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { ManagedBrowser, type PrepareServices } from "@opencode-ai/core/mcp/managed-browser"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const nodeBytes = Buffer.from("portable-node-fixture")
const browserBytes = Buffer.from("managed-chromium-fixture")
const nodeSha256 = Hash.sha256(nodeBytes)
const platform = { platform: "win32", arch: "x64", execPath: "C:\\cudia.exe" }

const makeCore = (root: string) =>
  AppNodeBuilder.build(LayerNode.group([Global.node, FSUtil.node, EffectFlock.node, AppProcess.node]), [
    [Global.node, Global.layerWith({ cache: path.join(root, "cache"), state: path.join(root, "state") })],
  ])

const successfulRun =
  (
    filesystem: FSUtil.Interface,
    counters: { runs: number },
    observed?: Array<{ env?: Record<string, string>; extendEnv?: boolean }>,
  ) =>
  (command: Parameters<AppProcess.Interface["run"]>[0], _options?: Parameters<AppProcess.Interface["run"]>[1]) => {
    counters.runs++
    const args = command._tag === "StandardCommand" ? command.args : []
    const cwd = command._tag === "StandardCommand" ? command.options.cwd : undefined
    if (command._tag === "StandardCommand")
      observed?.push({
        env: command.options.env
          ? Object.fromEntries(
              Object.entries(command.options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
            )
          : undefined,
        extendEnv: command.options.extendEnv,
      })
    const argv = args.map(String)
    return Effect.gen(function* () {
      if (argv[0] === "install") {
        const cli = path.join(cwd!, "node_modules", "@playwright", "mcp", "cli.js")
        yield* filesystem.ensureDir(path.dirname(cli)).pipe(Effect.orDie)
        yield* filesystem.writeFileString(cli, "playwright-mcp-fixture").pipe(Effect.orDie)
        yield* filesystem
          .writeJson(path.join(path.dirname(cli), "package.json"), { version: "0.0.83" })
          .pipe(Effect.orDie)
        for (const name of ["playwright", "playwright-core"]) {
          const packagePath = path.join(cwd!, "node_modules", name)
          yield* filesystem.ensureDir(packagePath).pipe(Effect.orDie)
          yield* filesystem.writeJson(path.join(packagePath, "package.json"), { name, version: "1.64.0-alpha" })
          yield* filesystem.writeFileString(path.join(packagePath, "index.js"), `${name}-fixture`).pipe(Effect.orDie)
        }
      }
      if (argv[1] === "install-browser") {
        const browserRoot =
          command._tag === "StandardCommand" ? command.options.env?.PLAYWRIGHT_BROWSERS_PATH : undefined
        const executable = path.join(browserRoot!, "chromium-1247", "chrome-win64", "chrome.exe")
        yield* filesystem.ensureDir(path.dirname(executable)).pipe(Effect.orDie)
        yield* filesystem.writeFile(executable, browserBytes).pipe(Effect.orDie)
        yield* filesystem
          .writeFileString(path.join(path.dirname(executable), "chrome.dll"), "chromium-dll-fixture")
          .pipe(Effect.orDie)
      }
      const output =
        argv[0] === "-e"
          ? path.join(
              command._tag === "StandardCommand" ? (command.options.env?.PLAYWRIGHT_BROWSERS_PATH ?? "") : "",
              "chromium-1247",
              "chrome-win64",
              "chrome.exe",
            )
          : ""
      return {
        command: "fixture process",
        exitCode: 0,
        stdout: Buffer.from(output),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      } satisfies AppProcess.RunResult
    }).pipe(Effect.orDie)
  }

const servicesFor = (
  global: Global.Interface,
  filesystem: FSUtil.Interface,
  flock: EffectFlock.Interface,
  run: AppProcess.Interface["run"],
): PrepareServices => ({
  global,
  fs: filesystem,
  flock,
  process: { run },
  downloadNode: () => Effect.succeed(nodeBytes),
  platform,
  expectedNodeSha256: nodeSha256,
})

describe("ManagedBrowser.prepareWithServices", () => {
  test("uses the supplied environment for cold and warm launches without inheriting the process environment", async () => {
    await using tmp = await tmpdir()
    const previous = process.env.CUDIA_PARENT_SENTINEL
    process.env.CUDIA_PARENT_SENTINEL = "synthetic-only"
    try {
      const core = makeCore(tmp.path)
      const observed: Array<{ env?: Record<string, string>; extendEnv?: boolean }> = []
      const counters = { runs: 0 }
      const prepared = await Effect.gen(function* () {
        const global = yield* Global.Service
        const filesystem = yield* FSUtil.Service
        const flock = yield* EffectFlock.Service
        const services = servicesFor(global, filesystem, flock, successfulRun(filesystem, counters, observed))
        const baseEnvironment = {
          PATH: "C:\\Windows\\System32;C:\\SDK\\bin",
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          CUDIA_WINDOWS_DEFAULT: "kept",
        }
        const input = {
          args: ["--headless"],
          environment: { CUDIA_CONFIGURED: "explicit" },
          baseEnvironment,
        }
        const cold = yield* ManagedBrowser.prepareWithServices(input, services)
        const warm = yield* ManagedBrowser.prepareWithServices({ ...input, args: ["--reuse"] }, services)
        return { baseEnvironment, cold, warm }
      }).pipe(Effect.provide(core), Effect.runPromise)

      for (const item of [prepared.cold, prepared.warm]) {
        expect(item.env.CUDIA_PARENT_SENTINEL).toBeUndefined()
        expect(item.env.CUDIA_CONFIGURED).toBe("explicit")
        expect(item.env.CUDIA_WINDOWS_DEFAULT).toBe("kept")
        expect(item.env.PATH).toBe(prepared.baseEnvironment.PATH)
        expect(item.env.SystemRoot).toBe(prepared.baseEnvironment.SystemRoot)
        expect(item.env.WINDIR).toBe(prepared.baseEnvironment.WINDIR)
        expect(item.env.PLAYWRIGHT_BROWSERS_PATH).toBeDefined()
        expect(item.env.BUN_BE_BUN).toBe("0")
      }
      expect(prepared.warm.command).toBe(prepared.cold.command)
      expect(observed).toHaveLength(3)
      for (const [index, child] of observed.entries()) {
        expect(child.extendEnv).toBe(false)
        expect(child.env?.CUDIA_PARENT_SENTINEL).toBeUndefined()
        expect(child.env?.CUDIA_CONFIGURED).toBe("explicit")
        expect(child.env?.CUDIA_WINDOWS_DEFAULT).toBe("kept")
        expect(child.env?.PATH).toBe(prepared.baseEnvironment.PATH)
        expect(child.env?.SystemRoot).toBe(prepared.baseEnvironment.SystemRoot)
        if (index > 0) expect(child.env?.PLAYWRIGHT_BROWSERS_PATH).toBeDefined()
        expect(child.env?.BUN_BE_BUN).toBe(index === 0 ? "1" : "0")
      }
    } finally {
      if (previous === undefined) delete process.env.CUDIA_PARENT_SENTINEL
      else process.env.CUDIA_PARENT_SENTINEL = previous
    }
  })

  test("reuses complete package and browser inventories, rebuilding when a DLL or package file is missing/changed", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const counters = { runs: 0, downloads: 0 }
    const output = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const process = successfulRun(filesystem, counters)
      const services = servicesFor(global, filesystem, flock, process)
      const install = (args: string[], overrides: Partial<PrepareServices> = {}) =>
        ManagedBrowser.prepareWithServices(
          { args, environment: { HTTP_PROXY: "http://proxy.test" } },
          {
            ...services,
            ...overrides,
            downloadNode: () => {
              counters.downloads++
              return Effect.succeed(nodeBytes)
            },
          },
        )
      const first = yield* install(["--headless"])
      const cached = yield* install(["--version"], { platform: { ...platform, isBun: false } })
      expect(cached.command).toBe(first.command)
      expect(cached.args).toEqual([first.args[0], "--version"])
      expect(cached.env.HTTP_PROXY).toBe("http://proxy.test")
      expect(cached.env.BUN_BE_BUN).toBe("0")
      expect(cached.env.PLAYWRIGHT_BROWSERS_PATH).toBeDefined()
      expect(counters.downloads).toBe(1)
      expect(counters.runs).toBe(3)

      const browserDir = path.join(cached.env.PLAYWRIGHT_BROWSERS_PATH!, "chromium-1247", "chrome-win64")
      yield* filesystem.remove(path.join(browserDir, "chrome.dll"))
      const rebuiltAfterDll = yield* install(["--browser-recovered"])
      expect(rebuiltAfterDll.command).not.toBe(first.command)
      expect(counters.downloads).toBe(2)
      expect(counters.runs).toBe(6)

      const packageFile = path.join(
        path.dirname(rebuiltAfterDll.env.PLAYWRIGHT_BROWSERS_PATH!),
        "node_modules",
        "playwright-core",
        "index.js",
      )
      yield* filesystem.writeFileString(packageFile, "changed package fixture")
      const rebuiltAfterPackage = yield* install(["--fresh"])
      expect(rebuiltAfterPackage.command).not.toBe(rebuiltAfterDll.command)
      expect(counters.downloads).toBe(3)
      expect(counters.runs).toBe(9)
      return { first, rebuilt: rebuiltAfterPackage }
    }).pipe(Effect.provide(core), Effect.runPromise)

    expect(output.first.command).toContain("node.exe")
    expect(output.rebuilt.args.at(-1)).toBe("--fresh")
  })

  test("serializes concurrent preparation by the runtime and lock digest", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const counters = { runs: 0, downloads: 0 }
    const prepared = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const base = successfulRun(filesystem, counters)
      const process: AppProcess.Interface["run"] = (command, options) =>
        Effect.sleep(Duration.millis(15)).pipe(Effect.flatMap(() => base(command, options)))
      const services = servicesFor(global, filesystem, flock, process)
      const make = () => ManagedBrowser.prepareWithServices({ args: ["--headless"] }, services)
      return yield* Effect.all([make(), make()], { concurrency: "unbounded" })
    }).pipe(Effect.provide(core), Effect.runPromise)

    expect(prepared[0]?.command).toBe(prepared[1]?.command)
    expect(counters.runs).toBe(3)
  })

  test("interrupts an in-flight install without writing a ready receipt, then recovers", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const entered = Promise.withResolvers<void>()
    let hang = true
    let interrupted = false
    let runs = 0
    const program = Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const base = successfulRun(filesystem, { runs: 0 })
      const process: AppProcess.Interface["run"] = (command, options) => {
        runs++
        const args = command._tag === "StandardCommand" ? command.args.map(String) : []
        if (hang && args[1] === "install-browser") {
          entered.resolve()
          return Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          )
        }
        return base(command, options)
      }
      const services = servicesFor(global, filesystem, flock, process)
      return yield* ManagedBrowser.prepareWithServices({ args: ["--headless"] }, services)
    }).pipe(Effect.provide(core))

    const controller = new AbortController()
    const pending = Effect.runPromiseExit(program, { signal: controller.signal })
    await entered.promise
    controller.abort()
    const exit = await pending
    expect(exit._tag).toBe("Failure")
    expect(interrupted).toBe(true)

    hang = false
    const recovered = await Effect.runPromise(program)
    expect(recovered.command).toContain("node.exe")
    expect(runs).toBe(5)
  })

  test("interrupts a real Windows process tree before releasing the cache lock, then recovers", async () => {
    if (process.platform !== "win32") return
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    const pidFile = path.join(tmp.path, "owned-processes.json")
    const controller = new AbortController()
    const fixedScript = [
      'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })',
      "await Bun.write(process.argv[1], JSON.stringify([process.pid, child.pid]))",
      "setInterval(() => {}, 1000)",
    ].join(";\n")
    const state = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      const nativeProcess = yield* AppProcess.Service
      const fallback = successfulRun(filesystem, { runs: 0 })
      let firstInstall = true
      const processService: AppProcess.Interface["run"] = (command, options) => {
        const args = command._tag === "StandardCommand" ? command.args.map(String) : []
        if (args[0] === "install" && firstInstall) {
          firstInstall = false
          return nativeProcess.run(
            ChildProcess.make(process.execPath, ["-e", fixedScript, pidFile], {
              cwd: tmp.path,
              env: { BUN_BE_BUN: "1" },
              extendEnv: true,
              stdin: "ignore",
            }),
            { timeout: Duration.seconds(20), maxOutputBytes: 4096, maxErrorBytes: 4096 },
          )
        }
        return fallback(command, options)
      }
      const services = servicesFor(global, filesystem, flock, processService)
      const pending = Effect.runPromiseExit(
        ManagedBrowser.prepareWithServices({ args: ["--owned-process-tree"] }, services),
        { signal: controller.signal },
      )
      return { pending, global, filesystem, services }
    }).pipe(Effect.provide(core), Effect.runPromise)

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let ownedPids: number[] = []
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          ownedPids = JSON.parse(await fs.readFile(pidFile, "utf8")) as number[]
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      expect(ownedPids).toHaveLength(2)
      expect(ownedPids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true)

      // The helper owns the cache lock and is blocked in the real AppProcess.run call here.
      controller.abort(new Error("test interruption"))
      const interrupted = await state.pending
      expect(interrupted._tag).toBe("Failure")
      const goneBy = Date.now() + 5_000
      while (Date.now() < goneBy && ownedPids.some(alive)) await new Promise((resolve) => setTimeout(resolve, 50))
      expect(ownedPids.filter(alive)).toEqual([])

      const noReceipt = await Effect.gen(function* () {
        const roots = yield* state.filesystem.readDirectoryEntries(path.join(state.global.cache, "managed-browser"))
        const receipts = yield* Effect.forEach(roots, (entry) =>
          state.filesystem.existsSafe(path.join(state.global.cache, "managed-browser", entry.name, "receipt.json")),
        )
        return receipts.every((exists) => !exists)
      }).pipe(Effect.provide(core), Effect.runPromise)
      expect(noReceipt).toBe(true)

      const recovered = await Effect.runPromise(
        ManagedBrowser.prepareWithServices({ args: ["--retry-after-tree"] }, state.services).pipe(Effect.provide(core)),
      )
      expect(recovered.args.at(-1)).toBe("--retry-after-tree")
      expect(recovered.env.PLAYWRIGHT_BROWSERS_PATH).toBeDefined()
    } finally {
      if (!controller.signal.aborted) controller.abort(new Error("test cleanup"))
      await state.pending
      for (const pid of ownedPids.filter(alive)) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
      }
    }
  })

  test("rejects unsupported platforms before cache access or network", async () => {
    await using tmp = await tmpdir()
    let downloads = 0
    const core = makeCore(tmp.path)
    const result = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      return yield* ManagedBrowser.prepareWithServices(
        { args: [] },
        {
          global,
          fs: filesystem,
          flock,
          process: { run: () => Effect.die("process must not run") },
          downloadNode: () => {
            downloads++
            return Effect.succeed(nodeBytes)
          },
          platform: { platform: "linux", arch: "x64", execPath: "/cudia" },
        },
      )
    }).pipe(Effect.provide(core), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
    expect(downloads).toBe(0)
  })

  test("requires the embedded Bun runtime only when a cache must be prepared", async () => {
    await using tmp = await tmpdir()
    const core = makeCore(tmp.path)
    let downloads = 0
    const result = await Effect.gen(function* () {
      const global = yield* Global.Service
      const filesystem = yield* FSUtil.Service
      const flock = yield* EffectFlock.Service
      return yield* ManagedBrowser.prepareWithServices(
        { args: [] },
        {
          global,
          fs: filesystem,
          flock,
          process: { run: () => Effect.die("process must not run") },
          downloadNode: () => {
            downloads++
            return Effect.succeed(nodeBytes)
          },
          platform: { ...platform, isBun: false },
          expectedNodeSha256: nodeSha256,
        },
      )
    }).pipe(Effect.provide(core), Effect.runPromiseExit)

    expect(result._tag).toBe("Failure")
    expect(downloads).toBe(0)
  })
})
