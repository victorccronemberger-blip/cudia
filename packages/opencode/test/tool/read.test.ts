import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AmbientInstructions } from "@opencode-ai/core/harness/ambient-instructions"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import path from "path"
import { symlink } from "fs/promises"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TextPage } from "../../src/util/text-page"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "../../src/session/session"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function recorded(result: Tool.ExecuteResult): SessionV1.WithParts {
  const messageID = MessageID.ascending()
  const cwd = process.cwd()
  return {
    info: {
      id: messageID,
      sessionID: ctx.sessionID,
      role: "assistant",
      agent: "build",
      mode: "build",
      parentID: MessageID.ascending(),
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test"),
      path: { cwd, root: cwd },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1 },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID,
        sessionID: ctx.sessionID,
        type: "tool",
        tool: "read",
        callID: "recorded-read",
        state: {
          status: "completed",
          input: {},
          title: result.title,
          output: result.output,
          metadata: result.metadata,
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}, durable = false, automatic = true) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
      ...(durable ? [Database.node, Session.node, SessionProjector.node] : []),
    ]),
    automatic
      ? [
          [
            AmbientInstructions.node,
            Layer.succeed(
              AmbientInstructions.Service,
              AmbientInstructions.Service.of({ current: () => ({ automatic: true, source: "cli" }) }),
            ),
          ],
        ]
      : [],
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))
const itDurable = testEffect(Layer.mergeAll(readLayer({}, true), testInstanceStoreLayer))
const itManual = testEffect(Layer.mergeAll(readLayer({}, false, false), testInstanceStoreLayer))
const configuredReadIt = (config: ConfigV1.Info) =>
  testEffect(
    Layer.mergeAll(readLayer(), TestConfig.layer({ get: () => Effect.succeed(config) }), testInstanceStoreLayer),
  )

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )
const git = Effect.fn("ReadToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.read external_directory permission", () => {
  itManual.live("default mode reads source and instruction documents without automatic rule attachments", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "nested", "source.ts")
      const instructions = path.join(dir, "nested", "AGENTS.md")
      yield* put(path.join(dir, "AGENTS.md"), "ROOT_RULE_MUST_NOT_BE_PROMOTED")
      yield* put(instructions, "NESTED_RULE_AS_SOURCE_DATA")
      yield* put(file, "export const ordinarySource = true")
      const result = yield* exec(dir, { filePath: file })
      expect(result.output).toContain("ordinarySource")
      expect(result.output).not.toContain("MUST_NOT_BE_PROMOTED")
      expect(result.output).not.toContain("NESTED_RULE")
      expect(result.metadata.loaded).toEqual([])
      const document = yield* exec(dir, { filePath: instructions })
      expect(document.output).toContain("NESTED_RULE_AS_SOURCE_DATA")
      expect(document.metadata.loaded).toEqual([])
    }),
  )

  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([path.relative(dir, full(target))])
      }),
    )
  }

  it.live("uses worktree-relative path for read permission so user rules match like edit/write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "src", "secret.ts"), "shh")

      const { items, next } = asks()
      yield* exec(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("src", "secret.ts")])
    }),
  )

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )

  it.live("checks both the in-project symlink alias and its canonical external target", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "external through symlink")
      yield* Effect.promise(() =>
        symlink(outer, path.join(dir, "escape"), process.platform === "win32" ? "junction" : "dir"),
      )

      const { items, next } = asks()
      const result = yield* exec(dir, { filePath: path.join(dir, "escape", "secret.txt") }, next)
      expect(result.output).toContain("external through symlink")
      expect(
        items.some(
          (item) =>
            item.permission === "external_directory" && item.metadata.filepath === path.join(outer, "secret.txt"),
        ),
      ).toBe(true)
      const reads = items.filter((item) => item.permission === "read").flatMap((item) => item.patterns)
      expect(reads).toContain(path.join("escape", "secret.txt"))
      expect(reads).toContain(path.relative(dir, path.join(outer, "secret.txt")))
    }),
  )
})

describe("tool.read legacy env file permission records", () => {
  const cases = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development.local",
    ".env.example",
    ".envrc",
    "environment.ts",
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const filename of cases) {
        it.live(`${filename} completes without a permission prompt`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const result = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                const rules = Permission.merge(info.permission, [
                  { permission: "read", pattern: filename, action: "ask" },
                  { permission: "read", pattern: "*", action: "deny" },
                ])
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, rules)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new PermissionV1.DeniedError({ ruleset: rules })
                        }
                      }
                    }),
                }

                const result = yield* run({ filePath: path.join(dir, filename) }, next)
                return { asked, output: result.output }
              }),
            )

            expect(result.asked).toBe(false)
            expect(result.output).toContain("content")
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = yield* load(path.join(FIXTURES_DIR, "models-api.json"))
      const target = 60 * 1024
      const content = base.length >= target ? base : base.repeat(Math.ceil(target / base.length))
      yield* put(path.join(test.directory, "large.json"), content)

      const result = yield* run({ filePath: path.join(test.directory, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(result.output).toContain("Use offset=")
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(50 * 1024)
      expect(result.output.split("\n").length).toBeLessThanOrEqual(2000)
    }),
  )

  it.instance("stops streaming after the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "huge.txt")
      const content = `${"x".repeat(80)}\n`.repeat(50_000)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10.")
      expect(result.metadata.display).not.toHaveProperty("totalLines")
      expect(result.output).toContain("Use offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  configuredReadIt({ tool_output: { max_bytes: 512, max_lines: 12 } }).live(
    "counts the complete numbered file envelope against configured byte and line limits",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "bounded.txt")
        yield* put(filepath, Array.from({ length: 40 }, (_, index) => `row${index + 1} 界界界界界界`).join("\n"))
        const first = yield* exec(dir, { filePath: filepath })
        expect(Buffer.byteLength(first.output, "utf8")).toBeLessThanOrEqual(512)
        expect(first.output.split("\n").length).toBeLessThanOrEqual(12)
        expect(first.metadata.truncated).toBe(true)
        expect(first.metadata.nextOffset).toBeGreaterThan(1)
        expect(first.output).toContain(`Use offset=${first.metadata.nextOffset}`)
        const next = yield* exec(dir, { filePath: filepath, offset: first.metadata.nextOffset })
        expect(next.output).toContain(`${first.metadata.nextOffset}: row${first.metadata.nextOffset}`)
        expect(Buffer.byteLength(next.output, "utf8")).toBeLessThanOrEqual(512)
        expect(next.output.split("\n").length).toBeLessThanOrEqual(12)
      }),
  )

  configuredReadIt({ tool_output: { max_bytes: 100_000, max_lines: 10_000 } }).live(
    "retains default ceilings when configured limits are larger",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "many.txt")
        yield* put(filepath, "line\n".repeat(3000))
        const result = yield* exec(dir, { filePath: filepath })
        expect(result.output.split("\n").length).toBeLessThanOrEqual(2000)
        expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(50 * 1024)
        expect(result.metadata.truncated).toBe(true)
        expect(result.metadata.nextOffset).toBeGreaterThan(1)
      }),
  )

  configuredReadIt({ tool_output: { max_bytes: 512, max_lines: 1 } }).live(
    "fails explicitly when a normal file envelope cannot fit without progress",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "small.txt")
        yield* put(filepath, "body")
        expect((yield* fail(dir, { filePath: filepath })).message).toContain("output budget")
      }),
  )

  it.live("rejects zero and excessive line limits instead of returning a page without progress", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "small.txt")
      yield* put(filepath, "body")
      for (const args of [{ offset: 0 }, { limit: 0 }, { limit: 2001 }])
        expect((yield* fail(dir, { filePath: filepath, ...args })).message).toContain("invalid arguments")
      expect((yield* fail(dir, { filePath: filepath, snapshot: "a".repeat(64) })).message).toContain(
        "only supported for directory",
      )
    }),
  )

  it.live("stops an enormous Unicode line with bounded streaming and an exact-text recovery hint", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "enormous.txt")
      yield* put(filepath, "A" + "😀界".repeat(1_000_000))
      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* exec(dir, { filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (input, options) =>
              fs.stream(input, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )
      expect(counter.bytes).toBeLessThanOrEqual(128 * 1024)
      expect(result.output.isWellFormed()).toBe(true)
      expect(result.output).toContain("textPage: {}")
      expect(result.output).not.toContain("Use offset=")
      expect(result.metadata.nextOffset).toBeUndefined()
      expect(result.metadata.display).not.toHaveProperty("totalLines")
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(50 * 1024)
    }),
  )

  it.live("normalizes CRLF across stream chunks and preserves a final unterminated line", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "crlf.txt")
      yield* put(filepath, "first\r\n界😀\r\nlast")
      const fs = yield* FSUtil.Service
      const result = yield* exec(dir, { filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (input, options) => fs.stream(input, { ...options, chunkSize: 1 }),
          }),
        ),
      )
      expect(result.output).toContain("1: first\n2: 界😀\n3: last")
      expect(result.metadata.display).toMatchObject({ text: "first\n界😀\nlast", totalLines: 3, truncated: false })
    }),
  )

  it.live("does not scan the remaining file to invent a total after a line-limited page", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "tail.txt")
      yield* put(filepath, "row\n".repeat(100_000))
      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* exec(dir, { filePath: filepath, limit: 10 }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (input, options) =>
              fs.stream(input, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )
      expect(counter.bytes).toBeLessThanOrEqual(128 * 1024)
      expect(result.output).toContain("Showing lines 1-10. Use offset=11")
      expect(result.metadata.display).not.toHaveProperty("totalLines")
      expect(result.metadata.nextOffset).toBe(11)
    }),
  )

  it.live("performs native read permission before content streams, media opens, or directory enumeration", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "file.txt")
      yield* put(filepath, "protected")
      const fs = yield* FSUtil.Service
      const counters = { stream: 0, open: 0, directory: 0 }
      const denied = { ...ctx, ask: () => Effect.die(new Error("read denied before content I/O")) }
      const restricted = FSUtil.Service.of({
        ...fs,
        stream: (input, options) => {
          counters.stream++
          return fs.stream(input, options)
        },
        open: (input, options) => {
          counters.open++
          return fs.open(input, options)
        },
        readDirectoryEntriesBounded: (input, options) => {
          counters.directory++
          return fs.readDirectoryEntriesBounded(input, options)
        },
      })
      for (const filePath of [filepath, dir])
        expect(
          (yield* fail(dir, { filePath }, denied).pipe(Effect.provideService(FSUtil.Service, restricted))).message,
        ).toContain("read denied")
      expect(counters).toEqual({ stream: 0, open: 0, directory: 0 })
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
      expect(result.metadata.display).toMatchObject({
        type: "file",
        path: path.join(test.directory, "small.txt"),
        text: "hello world",
        lineStart: 1,
        lineEnd: 1,
        totalLines: 1,
        truncated: false,
      })
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const first = yield* exec(dir, { filePath: path.join(dir, "dir"), limit: 5 })
      const result = yield* exec(dir, {
        filePath: path.join(dir, "dir"),
        offset: 6,
        limit: 5,
        snapshot: first.metadata.snapshot,
      })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
      expect(result.metadata.display).toMatchObject({
        type: "directory",
        path: path.join(dir, "dir"),
        entries: ["file-5.txt", "file-6.txt", "file-7.txt", "file-8.txt", "file-9.txt"],
        offset: 6,
        totalEntries: 10,
        truncated: false,
      })
    }),
  )

  configuredReadIt({ tool_output: { max_bytes: 512, max_lines: 10 } }).live(
    "reconstructs directory pages with complete entries, bounded envelopes, and an unchanged snapshot",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const directory = path.join(dir, "listing")
        const names = Array.from({ length: 12 }, (_, index) => `entry-${String(index).padStart(2, "0")}-界界.txt`)
        yield* Effect.forEach(names, (name) => put(path.join(directory, name), "body"))
        const recovered: string[] = []
        let offset = 1
        let snapshot: string | undefined
        for (let page = 0; page < names.length; page++) {
          const result = yield* exec(dir, { filePath: directory, offset, snapshot })
          expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(512)
          expect(result.output.split("\n").length).toBeLessThanOrEqual(10)
          expect(result.metadata.snapshot).toMatch(/^[a-f0-9]{64}$/)
          expect(result.output).toContain(`snapshot=${result.metadata.snapshot}`)
          if (snapshot) expect(result.metadata.snapshot).toBe(snapshot)
          snapshot = result.metadata.snapshot
          const display = result.metadata.display
          if (display?.type !== "directory") throw new Error("expected directory display")
          expect(display.entries.length).toBeGreaterThan(0)
          recovered.push(...display.entries)
          if (!result.metadata.truncated) break
          expect(result.metadata.nextOffset).toBe(offset + display.entries.length)
          expect(result.output).toContain(`Use offset=${result.metadata.nextOffset}`)
          offset = result.metadata.nextOffset!
        }
        expect(recovered).toEqual(names)
      }),
  )

  it.live("requires a directory snapshot and rejects continuation after the listing changes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const directory = path.join(dir, "listing")
      yield* put(path.join(directory, "a.txt"), "a")
      yield* put(path.join(directory, "b.txt"), "b")
      const first = yield* exec(dir, { filePath: directory, limit: 1 })
      expect((yield* fail(dir, { filePath: directory, offset: 2 })).message).toContain("Pass snapshot")
      expect((yield* fail(dir, { filePath: directory, offset: 2, snapshot: "0".repeat(64) })).message).toContain(
        "Directory listing changed",
      )
      const other = path.join(dir, "other-listing")
      yield* put(path.join(other, "a.txt"), "a")
      yield* put(path.join(other, "b.txt"), "b")
      expect((yield* fail(dir, { filePath: other, offset: 2, snapshot: first.metadata.snapshot })).message).toContain(
        "Directory listing changed",
      )
      yield* put(path.join(directory, "aa.txt"), "new listing entry")
      expect(
        (yield* fail(dir, { filePath: directory, offset: 2, snapshot: first.metadata.snapshot })).message,
      ).toContain("Restart at offset 1")
      const restarted = yield* exec(dir, { filePath: directory, limit: 1 })
      expect(restarted.metadata.snapshot).not.toBe(first.metadata.snapshot)
    }),
  )

  configuredReadIt({ tool_output: { max_bytes: 64, max_lines: 20 } }).live(
    "fails when a directory envelope cannot carry a complete next entry",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const directory = path.join(dir, "listing")
        yield* put(path.join(directory, "entry.txt"), "body")
        expect((yield* fail(dir, { filePath: directory })).message).toContain("next complete entry")
      }),
  )

  it.live("propagates bounded directory enumeration failures rather than falling back to an unbounded scan", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const directory = path.join(dir, "listing")
      yield* Effect.forEach(["a", "b", "c"], (name) => put(path.join(directory, name), "body"))
      const fs = yield* FSUtil.Service
      const error = yield* fail(dir, { filePath: directory }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            readDirectoryEntries: () => Effect.die(new Error("unbounded enumeration must not run")),
            readDirectoryEntriesBounded: (input) => fs.readDirectoryEntriesBounded(input, { maxEntries: 2 }),
          }),
        ),
      )
      expect(error.message).toContain("Directory listing exceeded entries limit of 2")
    }),
  )

  it.live("uses bounded enumeration for missing-file suggestions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "nearby.txt"), "body")
      const fs = yield* FSUtil.Service
      let scans = 0
      const error = yield* fail(dir, { filePath: path.join(dir, "nearby") }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            readDirectory: () => Effect.die(new Error("unbounded enumeration must not run")),
            readDirectoryEntriesBounded: (input) => {
              scans++
              return fs.readDirectoryEntriesBounded(input)
            },
          }),
        ),
      )
      expect(scans).toBe(1)
      expect(error.message).toContain("File not found")
      expect(error.message).toContain("Did you mean")
    }),
  )

  it.live("keeps offsets and Unicode recovery after skipping a multi-chunk oversized line", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "offset-unicode.txt")
      const skipped = "s".repeat(140_000)
      const selected = `kept 😀\r\n${"a".repeat(1999)}😀 tail\r\nlast`
      const source = `${skipped}\r\n${selected}`
      yield* put(filepath, source)
      const result = yield* exec(dir, { filePath: filepath, offset: 2, limit: 2 })
      expect(result.metadata.display).toMatchObject({ type: "file", lineStart: 2, lineEnd: 3 })
      expect(result.output).toContain("2: kept 😀")
      expect(result.output).toContain(`3: ${"a".repeat(1999)}... (line truncated`)
      expect(result.output).toContain("textPage")
      expect(result.metadata.nextOffset).toBeUndefined()
      expect(result.output).not.toContain("\uFFFD")
      const first = JSON.parse(
        (yield* exec(dir, { filePath: filepath, textPage: { limit: 1 } })).output,
      ) as Instruction.Page
      const recovered = JSON.parse(
        (yield* exec(dir, {
          filePath: filepath,
          textPage: { offset: skipped.length + 2, contentHash: first.contentHash },
        })).output,
      ) as Instruction.Page
      expect(recovered.text).toBe(selected)
    }),
  )

  it.live("distinguishes a full line page at EOF from one with another line", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "boundary.txt")
      yield* put(filepath, "one\r\ntwo\r\n")
      const complete = yield* exec(dir, { filePath: filepath, limit: 2 })
      expect(complete.metadata.truncated).toBe(false)
      expect(complete.metadata.nextOffset).toBeUndefined()
      yield* put(filepath, "one\r\ntwo\r\nthree\r\n")
      const continued = yield* exec(dir, { filePath: filepath, limit: 2 })
      expect(continued.metadata.truncated).toBe(true)
      expect(continued.metadata.nextOffset).toBe(3)
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("textPage")
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("delivers nearby instructions before releasing image attachments", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      const nested = path.join(dir, "nested")
      yield* put(path.join(nested, "AGENTS.md"), "Image read instructions")
      yield* put(path.join(nested, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(nested, "image.png") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).not.toContain("Image read successfully")
      expect(result.output).toContain("Image read instructions")
      expect(result.metadata.loaded).toContain(path.join(nested, "AGENTS.md"))
      expect(result.metadata.receipt).toEqual({ kind: "batch", start: 0, end: result.output.length })
      const ready = yield* exec(
        dir,
        { filePath: path.join(nested, "image.png") },
        { ...ctx, messages: [recorded(result)] },
      )
      expect(ready.output).toBe("Image read successfully")
      expect(ready.attachments).toHaveLength(1)
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("rejects oversized image and PDF ingestion without a full-file read", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      for (const item of [
        { name: "large.png", signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        { name: "large.pdf", signature: Buffer.from("%PDF-1.7\n") },
      ]) {
        const filepath = path.join(dir, item.name)
        yield* put(filepath, item.signature)
        yield* fs.truncate(filepath, 20 * 1024 * 1024 + 1)
        const error = yield* fail(dir, { filePath: filepath }).pipe(
          Effect.provideService(
            FSUtil.Service,
            FSUtil.Service.of({
              ...fs,
              readFile: () => Effect.die(new Error("unbounded full-file read must not run")),
            }),
          ),
        )
        expect(error.message).toContain("20971520 byte ingestion limit")
      }
    }),
  )

  it.live("caps actual media bytes when the file grows after the opened-handle stat", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "growing.png")
      yield* put(filepath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      const fs = yield* FSUtil.Service
      const state = { opens: 0, grown: false, bytes: 0 }
      const error = yield* fail(dir, { filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            readFile: () => Effect.die(new Error("unbounded full-file read must not run")),
            open: (input, options) =>
              fs.open(input, options).pipe(
                Effect.map((file) => {
                  if (path.resolve(input) !== path.resolve(filepath) || ++state.opens !== 2) return file
                  return new Proxy(file, {
                    get: (target, key) =>
                      key === "readAlloc"
                        ? (size: Parameters<typeof file.readAlloc>[0]) =>
                            Effect.gen(function* () {
                              if (!state.grown) {
                                state.grown = true
                                yield* fs.truncate(filepath, 20 * 1024 * 1024 + 1)
                              }
                              const chunk = yield* file.readAlloc(size)
                              if (Option.isSome(chunk)) state.bytes += chunk.value.length
                              return chunk
                            })
                        : Reflect.get(target, key, target),
                  })
                }),
              ),
          }),
        ),
      )
      expect(error.message).toContain("20971520 byte ingestion limit")
      expect(state.grown).toBe(true)
      expect(state.bytes).toBe(20 * 1024 * 1024 + 1)
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )

  it.live("falls through unsupported image mime types to text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const cases = [
        ["image.bmp", "BM text content"],
        ["photo.tiff", "II text content"],
        ["photo.avif", "avif text content"],
      ] as const

      for (const item of cases) {
        yield* put(path.join(dir, item[0]), item[1])
        const result = yield* exec(dir, { filePath: path.join(dir, item[0]) })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain(item[1])
      }
    }),
  )
})

describe("tool.read exact text pages", () => {
  it.live("returns a completed zero-length page for empty files and at EOF", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const empty = path.join(dir, "AGENTS.md")
      const nonempty = path.join(dir, "nonempty-AGENTS.md")
      yield* put(empty, "")
      yield* put(nonempty, "eof")

      const first = yield* exec(dir, { filePath: empty, textPage: {} })
      const firstPage = JSON.parse(first.output) as Instruction.Page & { complete: boolean }
      expect(firstPage.text).toBe("")
      expect(firstPage.offset).toBe(0)
      expect(firstPage.nextOffset).toBe(0)
      expect(firstPage.totalLength).toBe(0)
      expect(firstPage.complete).toBe(true)

      const initial = yield* exec(dir, { filePath: nonempty, textPage: {} })
      const initialPage = JSON.parse(initial.output) as Instruction.Page & { complete: boolean }
      const eof = yield* exec(dir, {
        filePath: nonempty,
        textPage: { offset: initialPage.totalLength, contentHash: initialPage.contentHash },
      })
      const eofPage = JSON.parse(eof.output) as Instruction.Page & { complete: boolean }
      expect(eofPage.text).toBe("")
      expect(eofPage.offset).toBe(initialPage.totalLength)
      expect(eofPage.nextOffset).toBe(initialPage.totalLength)
      expect(eofPage.complete).toBe(true)
    }),
  )

  it.live("does not return text-page contents when native read permission is denied", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "AGENTS.md")
      yield* put(filepath, "PRIVATE_TEXT_PAGE_BODY")

      const { items, next } = asks()
      const denied = {
        ...next,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => {
          items.push(req)
          if (req.permission === "read" && req.metadata.filepath === filepath) {
            return Effect.die(new Error("text-page read denied"))
          }
          return Effect.void
        },
      }
      const error = yield* fail(dir, { filePath: filepath, textPage: {} }, denied)
      expect(error.message).toContain("text-page read denied")
      expect(items.some((item) => item.permission === "read" && item.metadata.filepath === filepath)).toBe(true)
    }),
  )

  configuredReadIt({ tool_output: { max_bytes: 512, max_lines: 1 } }).live(
    "keeps the complete page JSON within configured byte and line limits",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "AGENTS.md")
        yield* put(filepath, "bounded page body ".repeat(1000))

        const result = yield* exec(dir, { filePath: filepath, textPage: {} })
        const page = JSON.parse(result.output) as Instruction.Page & { complete: boolean }
        expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(512)
        expect(result.output.split("\n")).toHaveLength(1)
        expect(page.text.length).toBeLessThan(1000)
        expect(page.complete).toBe(false)
      }),
  )

  configuredReadIt({ tool_output: { max_bytes: 32, max_lines: 1 } }).live(
    "fails explicitly when the configured byte limit cannot fit a page envelope",
    () =>
      Effect.gen(function* () {
        const bytesDir = yield* tmpdirScoped()
        const filepath = path.join(bytesDir, "AGENTS.md")
        yield* put(filepath, "body")
        const byteError = yield* fail(bytesDir, { filePath: filepath, textPage: {} })
        expect(byteError.message).toContain("Text page envelope exceeds the output budget")
      }),
  )

  itDurable.instance(
    "uses only selected instruction receipts from the current session, even when durable rows exist",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "target.txt")
        const instructions = path.join(test.directory, "nested", "AGENTS.md")
        yield* put(instructions, "Durably delivered rule")
        yield* put(filepath, "target")
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
          time: { created: 1 },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "assistant",
          agent: "build",
          mode: "build",
          parentID: user.id,
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("test"),
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        })
        const call = { ...ctx, sessionID: chat.id, messageID: assistant.id, callID: "current-read" }
        const prepared = yield* run({ filePath: filepath }, call)
        const unrecorded = yield* run({ filePath: filepath }, call)
        expect(unrecorded.output).toContain("Durably delivered rule")
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistant.id,
          type: "tool",
          tool: "read",
          callID: "previous-read",
          state: {
            status: "completed",
            input: { filePath: filepath },
            output: prepared.output,
            title: prepared.title,
            metadata: prepared.metadata,
            time: { start: 2, end: 3 },
          },
        })
        const selected: SessionV1.WithParts = { info: assistant, parts: [part] }
        const afterRecording = yield* run({ filePath: filepath }, { ...call, messages: [selected] })
        expect(afterRecording.metadata.loaded).toEqual([])
        expect(afterRecording.output).not.toContain("Durably delivered rule")

        // A durable row omitted from the selected context is not delivery evidence.
        const staleContext = yield* run({ filePath: filepath }, call)
        expect(staleContext.output).toContain("Durably delivered rule")

        const other = yield* sessions.create({})
        const foreign = yield* run({ filePath: filepath }, { ...call, sessionID: other.id, messages: [selected] })
        expect(foreign.output).toContain("Durably delivered rule")

        const compacted = yield* sessions.updatePart({
          ...part,
          state: { ...part.state, time: { ...part.state.time, compacted: 4 } },
        })
        const afterOmission = yield* run(
          { filePath: filepath },
          { ...call, messages: [{ info: assistant, parts: [compacted] }] },
        )
        expect(afterOmission.output).toContain("Durably delivered rule")

        const clipped = { ...part, state: { ...part.state, output: part.state.output.slice(0, 16) } }
        const afterClipping = yield* run(
          { filePath: filepath },
          { ...call, messages: [{ info: assistant, parts: [clipped] }] },
        )
        expect(afterClipping.output).toContain("Durably delivered rule")
      }),
  )

  it.live("reconstructs long Unicode lines and line endings without exceeding the JSON budget", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "long.txt")
      const text = "\uFEFF" + 'A😀界\"\\\r\n'.repeat(1800) + "tail"
      yield* put(filepath, text)
      const pages: string[] = []
      let offset = 0
      let contentHash: string | undefined
      for (let count = 0; count < 40; count++) {
        const result = yield* exec(dir, { filePath: filepath, textPage: { offset, contentHash } })
        const page = JSON.parse(result.output) as Instruction.Page & { complete: boolean }
        expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(6000)
        expect(page.contentHash).toBe(TextPage.hash(text))
        expect(page.offset).toBe(offset)
        expect(page.totalLength).toBe(text.length)
        expect(page.nextOffset).toBeGreaterThan(offset)
        pages.push(page.text)
        if (page.complete) break
        offset = page.nextOffset
        contentHash = page.contentHash
      }
      expect(pages.join("")).toBe(text)
    }),
  )

  it.live("requires explicit paging when instructions exceed automatic delivery limits", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const nested = path.join(dir, "nested")
      const instructions = path.join(nested, "AGENTS.md")
      const target = path.join(nested, "target.txt")
      const text = "\uFEFF" + "Scoped rule 😀. ".repeat(1800)
      yield* put(instructions, text)
      yield* put(target, "TARGET_AFTER_ALL_INSTRUCTIONS")
      const blocked = yield* fail(dir, { filePath: target })
      expect(blocked.message).toContain("16384-byte input limit")
      expect(blocked.message).toContain(instructions)
      expect(blocked.message).toContain("explicitly read it with textPage")

      const messages: SessionV1.WithParts[] = []
      let offset = 0
      let contentHash: string | undefined
      for (let count = 0; count < 40; count++) {
        const result = yield* exec(
          dir,
          { filePath: instructions, textPage: { offset, contentHash } },
          { ...ctx, messages },
        )
        const page = JSON.parse(result.output) as Instruction.Page & { complete: boolean }
        messages.push(recorded(result))
        if (count === 0) {
          const stillBlocked = yield* fail(dir, { filePath: target }, { ...ctx, messages })
          expect(stillBlocked.message).toContain("16384-byte input limit")
        }
        if (page.complete) break
        offset = page.nextOffset
        contentHash = page.contentHash
      }
      expect(Instruction.loaded(messages).has(instructions)).toBe(true)
      const ready = yield* exec(dir, { filePath: target }, { ...ctx, messages })
      expect(ready.metadata.pendingInstructions).toBeUndefined()
      expect(ready.output).toContain("TARGET_AFTER_ALL_INSTRUCTIONS")

      const image = path.join(nested, "image.png")
      yield* put(
        image,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1QAAAAASUVORK5CYII=",
          "base64",
        ),
      )
      const withheld = yield* fail(dir, { filePath: image })
      expect(withheld.message).toContain("16384-byte input limit")
      expect(withheld.message).toContain("explicitly read it with textPage")
      const attachment = yield* exec(dir, { filePath: image }, { ...ctx, messages })
      expect(attachment.attachments).toHaveLength(1)
    }),
  )

  it.live("does not treat constructed or concurrent unrecorded responses as delivered instructions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "nested", "target.txt")
      const instructions = path.join(dir, "nested", "AGENTS.md")
      yield* put(instructions, "Instruction must be delivered")
      yield* put(filepath, "target")
      const results = yield* Effect.all([exec(dir, { filePath: filepath }), exec(dir, { filePath: filepath })], {
        concurrency: "unbounded",
      })
      for (const result of results) {
        expect(result.output).toContain("Instruction must be delivered")
        expect(result.metadata.loaded).toEqual([instructions])
      }
      const repeated = yield* exec(dir, { filePath: filepath })
      expect(repeated.output).toContain("Instruction must be delivered")
      const afterRecording = yield* exec(dir, { filePath: filepath }, { ...ctx, messages: [recorded(repeated)] })
      expect(afterRecording.metadata.loaded).toEqual([])
      expect(afterRecording.output).not.toContain("Instruction must be delivered")
    }),
  )

  it.live("detects changed text, split Unicode offsets, and invalid paging combinations", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "text.txt")
      yield* put(filepath, "A😀" + "x".repeat(10_000))
      const first = yield* exec(dir, { filePath: filepath, textPage: { limit: 10 } })
      const page = JSON.parse(first.output) as Instruction.Page
      const split = yield* fail(dir, { filePath: filepath, textPage: { offset: 2, contentHash: page.contentHash } })
      expect(split.message).toContain("surrogate pair")
      const missingHash = yield* fail(dir, { filePath: filepath, textPage: { offset: 10 } })
      expect(missingHash.message).toContain("contentHash")
      const mixed = yield* fail(dir, { filePath: filepath, offset: 1, textPage: {} })
      expect(mixed.message).toContain("without the line")
      yield* put(filepath, "B😀" + "x".repeat(10_000))
      const changed = yield* fail(dir, {
        filePath: filepath,
        textPage: { offset: page.nextOffset, contentHash: page.contentHash },
      })
      expect(changed.message).toContain("File content changed")
      const restarted = yield* exec(dir, { filePath: filepath, textPage: {} })
      expect(JSON.parse(restarted.output).text.startsWith("B😀")).toBe(true)
    }),
  )
})

describe("tool.read loaded instructions", () => {
  configuredReadIt({ tool_output: { max_bytes: 512, max_lines: 1 } }).live(
    "delivers only complete bounded prerequisite receipts before releasing exact target pages",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const filepath = path.join(dir, "nested", "target.txt")
        const instructions = path.join(dir, "nested", "AGENTS.md")
        yield* put(instructions, "Instruction before target")
        yield* put(filepath, "TARGET_AFTER_RECEIPT")
        const pending = yield* exec(dir, { filePath: filepath, textPage: {} })
        expect(Buffer.byteLength(pending.output, "utf8")).toBeLessThanOrEqual(512)
        expect(pending.output.split("\n")).toHaveLength(1)
        expect(pending.output).not.toContain("TARGET_AFTER_RECEIPT")
        expect(pending.metadata.loaded).toEqual([instructions])
        expect(pending.metadata.receipt).toEqual({ kind: "batch", start: 0, end: pending.output.length })
        const selected = recorded(pending)
        expect(Instruction.loaded([selected]).has(instructions)).toBe(true)
        const clipped = recorded({ ...pending, output: pending.output.slice(0, -1) })
        expect(Instruction.loaded([clipped]).has(instructions)).toBe(false)
        const retry = yield* exec(dir, { filePath: filepath, textPage: {} }, { ...ctx, messages: [clipped] })
        expect(retry.metadata.pendingInstructions).toBe(true)
        expect(retry.output).not.toContain("TARGET_AFTER_RECEIPT")
        const ready = yield* exec(dir, { filePath: filepath, textPage: {} }, { ...ctx, messages: [selected] })
        expect(JSON.parse(ready.output).text).toBe("TARGET_AFTER_RECEIPT")
        expect(ready.metadata.loaded).toEqual([])
      }),
  )

  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).not.toContain("test content")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.pendingInstructions).toBe(true)
      expect(result.metadata.receipt).toEqual({ kind: "batch", start: 0, end: result.output.length })
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
      const ready = yield* exec(
        dir,
        { filePath: path.join(dir, "subdir", "nested", "test.txt") },
        { ...ctx, messages: [recorded(result)] },
      )
      expect(ready.output).toContain("test content")
      expect(ready.metadata.loaded).toEqual([])
    }),
  )

  it.live("requires read permission for nearby AGENTS.md and retries after denial", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "Protected nearby instructions")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "readable target")

      const { items, next } = asks()
      const denied = {
        ...next,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => {
          items.push(req)
          if (req.permission === "read" && req.metadata.instruction === true) {
            return Effect.die(new Error("nearby instruction read denied"))
          }
          return Effect.void
        },
      }
      const error = yield* fail(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") }, denied)
      expect(error.message).toContain("nearby instruction read denied")
      expect(items.some((item) => item.permission === "read" && item.metadata.instruction === true)).toBe(true)

      const retry = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(retry.output).toContain("Protected nearby instructions")
      expect(retry.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )

  it.live("delivers instruction prerequisites before validating the target line offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const nested = path.join(dir, "nested")
      yield* put(path.join(nested, "AGENTS.md"), "Retry after target read failure")
      yield* put(path.join(nested, "file.txt"), "readable target")

      const prepared = yield* exec(dir, { filePath: path.join(nested, "file.txt"), offset: 10 })
      expect(prepared.metadata.pendingInstructions).toBe(true)
      expect(prepared.metadata.receipt).toEqual({ kind: "batch", start: 0, end: prepared.output.length })
      expect(prepared.output).not.toContain("readable target")
      const error = yield* fail(
        dir,
        { filePath: path.join(nested, "file.txt"), offset: 10 },
        { ...ctx, messages: [recorded(prepared)] },
      )
      expect(error.message).toContain("out of range")

      const retry = yield* exec(dir, { filePath: path.join(nested, "file.txt") })
      expect(retry.output).toContain("Retry after target read failure")
      expect(retry.metadata.loaded).toContain(path.join(nested, "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("does not claim nearby instructions when the target is binary", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const nested = path.join(dir, "nested")
      yield* put(path.join(nested, "AGENTS.md"), "Retry after binary target")
      yield* put(path.join(nested, "target.bin"), Buffer.from([0x00, 0x01, 0x02]))

      const error = yield* fail(dir, { filePath: path.join(nested, "target.bin") })
      expect(error.message).toContain("Cannot read binary file")

      yield* put(path.join(nested, "target.txt"), "readable target")
      const retry = yield* exec(dir, { filePath: path.join(nested, "target.txt") })
      expect(retry.output).toContain("Retry after binary target")
      expect(retry.metadata.loaded).toContain(path.join(nested, "AGENTS.md"))
    }),
  )
})
