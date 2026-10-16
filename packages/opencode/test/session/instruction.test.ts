import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { symlink } from "fs/promises"
import { createHash } from "node:crypto"
import { Effect, FileSystem, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstructionSource } from "@opencode-ai/core/instruction-source"
import { AmbientInstructions } from "@opencode-ai/core/harness/ambient-instructions"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

type InstructionOptions = {
  automatic?: boolean
  instructions?: string[]
  limits?: Partial<InstructionSource.Limits>
  filesystem?: (fs: FSUtil.Interface) => FSUtil.Interface
  http?: HttpClient.HttpClient
}

const instructionLayer = (
  global: Partial<Global.Interface>,
  flags: Partial<RuntimeFlags.Info> = {},
  options: InstructionOptions = {},
) => {
  const filesystem = options.filesystem
    ? Layer.effect(FSUtil.Service, FSUtil.Service.pipe(Effect.map((fs) => options.filesystem!(fs)))).pipe(
        Layer.provide(LayerNode.compile(FSUtil.node)),
      )
    : LayerNode.compile(FSUtil.node)
  const client = options.http
    ? Layer.succeed(HttpClient.HttpClient, options.http)
    : LayerNode.compile(LayerNodePlatform.httpClient)
  return AppNodeBuilder.build(Instruction.node, [
    // Existing delivery tests exercise explicit opt-in; manual tests use the
    // production default service without this override.
    ...(options.automatic === false
      ? []
      : [
          [
            AmbientInstructions.node,
            Layer.succeed(
              AmbientInstructions.Service,
              AmbientInstructions.Service.of({ current: () => ({ automatic: true, source: "cli" }) }),
            ),
          ] as const,
        ]),
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ instructions: options.instructions }) })],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
    ...(options.filesystem ? ([[FSUtil.node, filesystem]] as const) : []),
    ...(options.http
      ? ([[LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, options.http)]] as const)
      : []),
    ...(options.limits
      ? ([
          [
            InstructionSource.node,
            Layer.effect(
              InstructionSource.Service,
              Effect.gen(function* () {
                const fs = yield* FSUtil.Service
                const http = yield* HttpClient.HttpClient
                const limits = { ...InstructionSource.DEFAULT_LIMITS, ...options.limits }
                return InstructionSource.Service.of({
                  limits,
                  load: (sources, input) => InstructionSource.load(fs, input?.http ?? http, limits, sources),
                })
              }),
            ).pipe(Layer.provide(filesystem), Layer.provide(client)),
          ],
        ] as const)
      : []),
  ])
}

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>, options?: InstructionOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags, options)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(
  files: Record<string, string>,
  self: (dir: string) => Effect.Effect<A, E, R>,
  options?: InstructionOptions,
) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }, undefined, options))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: 0 },
        agent: "build",
        mode: "build",
        parentID: MessageID.make("msg_parent-loaded-1"),
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

const page = (
  filepath: string,
  text: string,
  offset = 0,
  nextOffset = text.length,
  totalLength = text.length,
  completeText = text,
) => ({
  filepath,
  contentHash: createHash("sha256").update(JSON.stringify(completeText)).digest("hex"),
  offset,
  nextOffset,
  totalLength,
  text,
})

function recordedRead(output: string, metadata: Record<string, unknown>, compacted?: number): SessionV1.WithParts[] {
  const base = loaded("unused")[0]!
  const messageID = MessageID.make("msg_message-receipt-test")
  const sessionID = SessionID.make("session-receipt-test")
  return [
    {
      ...base,
      parts: [
        {
          id: PartID.make("prt_part-receipt-test"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-receipt-test",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output,
            title: "Read",
            metadata,
            time: { start: 0, end: 1, ...(compacted === undefined ? {} : { compacted }) },
          },
        },
      ],
    },
  ] as SessionV1.WithParts[]
}

function recordedBatch(output: string): SessionV1.WithParts[] {
  return recordedRead(output, { receipt: { kind: "batch", start: 0, end: output.length } })
}

describe("Instruction.resolve", () => {
  it.live("default mode does not promote project, global, configured or nested documents", () =>
    withFiles(
      {
        "AGENTS.md": "ROOT_RULE_MUST_NOT_BE_PROMOTED",
        ".claude/CLAUDE.md": "GLOBAL_RULE_MUST_NOT_BE_PROMOTED",
        "CLAUDE.md": "CLAUDE_RULE_MUST_NOT_BE_PROMOTED",
        "CONTEXT.md": "CONTEXT_RULE_MUST_NOT_BE_PROMOTED",
        "nested/AGENTS.md": "NESTED_RULE_MUST_NOT_BE_PROMOTED",
        "nested/file.ts": "export const value = 1",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          expect(AmbientInstructions.current()).toEqual({ automatic: false, source: "default" })
          expect(yield* svc.system()).toEqual([])
          expect(Array.from(yield* svc.systemPaths())).toEqual([])
          const file = path.join(dir, "nested", "file.ts")
          const prepared = yield* svc.prepare([], file, () => Effect.die("automatic authorization was attempted"))
          expect(prepared).toEqual({ output: "", loaded: [], pending: false, hasMore: false })
          expect(yield* svc.resolve([], file, MessageID.make("msg_manual-instructions"))).toEqual([])
        }),
      { automatic: false, instructions: ["AGENTS.md", "nested/AGENTS.md"] },
    ),
  )

  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("does not cross a sibling path that shares the project root prefix", () =>
    Effect.gen(function* () {
      const parent = yield* tmpdirScoped()
      const dir = path.join(parent, "repo")
      const sibling = path.join(parent, "repo-neighbor")
      yield* writeFiles(dir, { "nested/file.ts": "const x = 1" })
      yield* writeFiles(sibling, { "nested/AGENTS.md": "Sibling-only instructions", "nested/file.ts": "const x = 2" })
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const results = yield* svc.resolve(
            [],
            path.join(sibling, "nested", "file.ts"),
            MessageID.make("msg_message-sibling-1"),
          )
          expect(results).toEqual([])
        }).pipe(provideInstruction({ home: parent, config: parent })),
      )
    }),
  )

  it.live("does not follow a project symlink outside the canonical project root", () =>
    Effect.gen(function* () {
      const parent = yield* tmpdirScoped()
      const dir = path.join(parent, "repo")
      const outside = path.join(parent, "outside")
      yield* writeFiles(dir, { "seed.txt": "project" })
      yield* writeFiles(outside, { "AGENTS.md": "Outside instructions", "nested/file.ts": "const x = 1" })
      yield* Effect.promise(() =>
        symlink(outside, path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir"),
      )
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const results = yield* svc.resolve(
            [],
            path.join(dir, "link", "nested", "file.ts"),
            MessageID.make("msg_message-symlink-1"),
          )
          expect(results).toEqual([])
        }).pipe(provideInstruction({ home: parent, config: parent })),
      )
    }),
  )

  const fileSymlinkTest = process.platform === "win32" ? it.live.skip : it.live
  fileSymlinkTest(
    "does not attach an AGENTS.md file symlink that resolves outside the project (Windows skip: file symlinks may require privilege)",
    () =>
      withFiles({ "nested/file.ts": "const x = 1" }, (dir) =>
        Effect.gen(function* () {
          const outside = yield* tmpdirScoped()
          yield* write(path.join(outside, "AGENTS.md"), "Foreign instruction file")
          yield* Effect.promise(() => symlink(path.join(outside, "AGENTS.md"), path.join(dir, "nested", "AGENTS.md")))
          const svc = yield* Instruction.Service

          const results = yield* svc.resolve(
            [],
            path.join(dir, "nested", "file.ts"),
            MessageID.make("msg_message-agent-symlink-1"),
          )
          expect(results).toEqual([])
        }),
      ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("does not claim a missing instruction file and retries it when it appears", () =>
    withFiles({ "nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "file.ts")
        const messageID = MessageID.make("msg_message-missing-instruction-1")
        expect(yield* svc.resolve([], filepath, messageID)).toEqual([])
        yield* write(path.join(dir, "nested", "AGENTS.md"), "Appeared instructions")
        expect(yield* svc.resolve([], filepath, messageID)).toHaveLength(1)
      }),
    ),
  )

  it.live("authorizes an instruction before reading or claiming it", () =>
    withFiles({ "nested/AGENTS.md": "Authorized instructions", "nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "file.ts")
        const messageID = MessageID.make("msg_message-instruction-auth-1")
        const denied = yield* svc
          .resolve([], filepath, messageID, () => Effect.die(new Error("instruction read denied")))
          .pipe(Effect.exit)
        expect(denied._tag).toBe("Failure")

        const authorized = yield* svc.resolve([], filepath, messageID, () => Effect.void)
        expect(authorized).toHaveLength(1)
        expect(authorized[0]?.content).toContain("Authorized instructions")
      }),
    ),
  )

  it.live("does not claim earlier instructions when a later candidate is denied", () =>
    withFiles(
      {
        "nested/AGENTS.md": "Nested instructions",
        "nested/deeper/AGENTS.md": "Deeper instructions",
        "nested/deeper/file.ts": "const x = 1",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const filepath = path.join(dir, "nested", "deeper", "file.ts")
          const messageID = MessageID.make("msg_message-instruction-batch-denied-1")
          let calls = 0
          const denied = yield* svc
            .resolve([], filepath, messageID, () =>
              Effect.gen(function* () {
                calls++
                if (calls === 2) return yield* Effect.die(new Error("second instruction denied"))
              }),
            )
            .pipe(Effect.exit)
          expect(denied._tag).toBe("Failure")

          const retry = yield* svc.resolve([], filepath, messageID)
          expect(retry).toHaveLength(2)
          expect(retry.some((item) => item.content.includes("Deeper instructions"))).toBe(true)
          expect(retry.some((item) => item.content.includes("Nested instructions"))).toBe(true)
        }),
    ),
  )

  it.live("does not claim an instruction whose body read fails", () =>
    withFiles({ "nested/AGENTS.md": "Retryable instructions", "nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "file.ts")
        const agents = path.join(dir, "nested", "AGENTS.md")
        const messageID = MessageID.make("msg_message-instruction-read-fail-1")
        const failed = yield* svc
          .resolve([], filepath, messageID, () => fs.remove(agents).pipe(Effect.orDie))
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        yield* write(agents, "Retryable instructions")

        const retried = yield* svc.resolve([], filepath, messageID)
        expect(retried).toHaveLength(1)
        expect(retried[0]?.content).toContain("Retryable instructions")
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )
})

describe("Instruction bounded ambient acquisition", () => {
  it.live("rejects an oversized global source explicitly and retries it after repair", () =>
    withFiles(
      { "AGENTS.md": "x".repeat(257) },
      (dir) =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          const failure = yield* instruction.system().pipe(Effect.flip)
          expect(failure).toBeInstanceOf(InstructionSource.Error)
          expect(failure).toMatchObject({ kind: "file", reason: "source_bytes", maximum: 256 })
          yield* write(path.join(dir, "AGENTS.md"), "repaired global instructions")
          expect(yield* instruction.system()).toEqual([
            `Instructions from: ${path.join(dir, "AGENTS.md")}\nrepaired global instructions`,
          ])
        }),
      { limits: { maxSourceBytes: 256 } },
    ),
  )

  it.live("bounds actual file growth after the opened-handle stat", () => {
    const state = { grown: false, bytes: 0 }
    return withFiles(
      { "AGENTS.md": "small" },
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          const failure = yield* instruction.system().pipe(Effect.flip)
          expect(failure).toMatchObject({ kind: "file", reason: "source_bytes", maximum: 256 })
          expect(state.grown).toBe(true)
          expect(state.bytes).toBe(257)
        }),
      {
        limits: { maxSourceBytes: 256 },
        filesystem: (fs) =>
          FSUtil.Service.of({
            ...fs,
            open: (input, options) =>
              fs.open(input, options).pipe(
                Effect.map(
                  (file) =>
                    new Proxy(file, {
                      get: (target, key) =>
                        key === "readAlloc"
                          ? (size: Parameters<typeof file.readAlloc>[0]) =>
                              Effect.gen(function* () {
                                if (!state.grown) {
                                  state.grown = true
                                  yield* fs.truncate(input, 257)
                                }
                                const chunk = yield* file.readAlloc(size)
                                if (Option.isSome(chunk)) state.bytes += chunk.value.length
                                return chunk
                              })
                          : Reflect.get(target, key, target),
                    }),
                ),
              ),
          }),
      },
    )
  })

  it.live("counts canonical source headers and separators in the complete aggregate budget", () =>
    Effect.gen(function* () {
      const dir = yield* tmpWithFiles({ "AGENTS.md": "global 界", "extra.rules": "extra 😀" })
      const expected = [
        `Instructions from: ${path.join(dir, "AGENTS.md")}\nglobal 界`,
        `Instructions from: ${path.join(dir, "extra.rules")}\nextra 😀`,
      ]
      const maximum = Buffer.byteLength(expected.join("\n\n"), "utf8")
      yield* Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        expect(yield* instruction.system()).toEqual(expected)
      }).pipe(
        provideInstance(dir),
        provideInstruction({ home: dir, config: dir }, undefined, {
          instructions: ["extra.rules"],
          limits: { maxTotalBytes: maximum },
        }),
      )
      yield* Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({
          kind: "file",
          reason: "total_bytes",
          maximum: maximum - 1,
        })
      }).pipe(
        provideInstance(dir),
        provideInstruction({ home: dir, config: dir }, undefined, {
          instructions: ["extra.rules"],
          limits: { maxTotalBytes: maximum - 1 },
        }),
      )
    }),
  )

  it.live("rejects malformed UTF-8 and preserves BOM in repaired instructions", () =>
    withFiles({ "AGENTS.md": "temporary" }, (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const instruction = yield* Instruction.Service
        const document = path.join(dir, "AGENTS.md")
        yield* fs.writeFile(document, Uint8Array.from([0xc3, 0x28]))
        expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({ kind: "file", reason: "malformed_utf8" })
        yield* fs.writeFileString(document, "\uFEFFcomplete 😀")
        expect(yield* instruction.system()).toEqual([`Instructions from: ${document}\n\uFEFFcomplete 😀`])
      }),
    ),
  )

  it.live("permits missing configured glob matches but fails on an existing non-file source", () =>
    withFiles(
      {},
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const instruction = yield* Instruction.Service
          expect(yield* instruction.system()).toEqual([])
          yield* fs.makeDirectory(path.join(dir, "AGENTS.md"))
          expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({ kind: "file", reason: "not_file" })
        }),
      { instructions: ["missing-*.rules"] },
    ),
  )

  it.live("fails a discovered source removed before acquisition and retries after it reappears", () => {
    const state = { removed: false }
    return withFiles(
      { "AGENTS.md": "original" },
      (dir) =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({ kind: "file", reason: "unavailable" })
          expect(state.removed).toBe(true)
          yield* write(path.join(dir, "AGENTS.md"), "restored")
          expect(yield* instruction.system()).toEqual([`Instructions from: ${path.join(dir, "AGENTS.md")}\nrestored`])
        }),
      {
        filesystem: (fs) =>
          FSUtil.Service.of({
            ...fs,
            realPath: (input) => {
              if (path.basename(input) !== "AGENTS.md" || state.removed) return fs.realPath(input)
              state.removed = true
              return fs.remove(input).pipe(Effect.andThen(fs.realPath(input)))
            },
          }),
      },
    )
  })

  it.live("does not silently swallow configured glob discovery failures", () =>
    withFiles(
      {},
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          const failure = yield* instruction.system().pipe(Effect.flip)
          expect(failure).toBeInstanceOf(InstructionSource.Error)
          expect(failure).toMatchObject({
            kind: "discovery",
            source: "ambient instruction discovery",
            reason: "unavailable",
          })
          expect(failure.message).not.toContain("glob acquisition denied")
          expect(yield* instruction.systemPaths().pipe(Effect.flip)).toBeInstanceOf(FSUtil.FileSystemError)
        }),
      {
        instructions: ["*.rules"],
        filesystem: (fs) =>
          FSUtil.Service.of({
            ...fs,
            globUp: () => Effect.fail(new FSUtil.FileSystemError({ method: "glob acquisition denied" })),
          }),
      },
    ),
  )

  it.live("stops bounded glob discovery before opening any candidate body", () => {
    const state = { opened: 0 }
    return withFiles(
      { "a.rules": "a", "b.rules": "b", "c.rules": "c" },
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({
            kind: "discovery",
            reason: "sources",
            maximum: 2,
          })
          expect(state.opened).toBe(0)
        }),
      {
        instructions: ["*.rules"],
        limits: { maxSources: 2 },
        filesystem: (fs) =>
          FSUtil.Service.of({
            ...fs,
            open: (input, options) => {
              state.opened++
              return fs.open(input, options)
            },
          }),
      },
    )
  })

  it.live("counts configured URLs before local glob candidates and performs no acquisition on overflow", () => {
    const state = { opened: 0, requests: 0 }
    return withFiles(
      { "a.rules": "a", "b.rules": "b" },
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({
            kind: "discovery",
            reason: "sources",
            maximum: 3,
          })
          expect(state).toEqual({ opened: 0, requests: 0 })
        }),
      {
        instructions: ["http://fixture.invalid/first", "http://fixture.invalid/second", "*.rules"],
        limits: { maxSources: 3 },
        filesystem: (fs) =>
          FSUtil.Service.of({
            ...fs,
            open: (input, options) => {
              state.opened++
              return fs.open(input, options)
            },
          }),
        http: HttpClient.make((request) => {
          state.requests++
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unreachable fixture body")))
        }),
      },
    )
  })

  it.live("bounds configured discovery expressions even when every glob would be empty", () =>
    withFiles(
      {},
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          expect(yield* instruction.systemPaths().pipe(Effect.flip)).toMatchObject({
            kind: "discovery",
            reason: "sources",
            maximum: 2,
          })
        }),
      { instructions: ["none-a-*", "none-b-*", "none-c-*"], limits: { maxSources: 2 } },
    ),
  )

  it.live("loads configured remote instructions in order and preserves existing transient HTTP retries", () => {
    const requests: string[] = []
    let attempts = 0
    return withFiles(
      { "AGENTS.md": "local" },
      (dir) =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          expect(yield* instruction.system()).toEqual([
            `Instructions from: ${path.join(dir, "AGENTS.md")}\nlocal`,
            "Instructions from: http://fixture.invalid/first\nfirst remote 😀",
            "Instructions from: http://fixture.invalid/second\nsecond remote",
          ])
          expect(requests).toEqual([
            "http://fixture.invalid/first",
            "http://fixture.invalid/first",
            "http://fixture.invalid/first",
            "http://fixture.invalid/second",
          ])
        }),
      {
        instructions: ["http://fixture.invalid/first", "http://fixture.invalid/second"],
        http: HttpClient.make((request) => {
          requests.push(request.url)
          const first = request.url.endsWith("/first")
          const status = first && attempts++ < 2 ? 503 : 200
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(first ? "first remote 😀" : "second remote", { status })),
          )
        }),
      },
    )
  })

  it.live("rejects actual remote body overflow, cancels consumption, and does not retry the body failure", () => {
    const state = { requests: 0, cancelled: false }
    return withFiles(
      {},
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          const failure = yield* instruction.system().pipe(Effect.flip)
          expect(failure).toMatchObject({ kind: "url", reason: "source_bytes", maximum: 1024 })
          expect(state).toEqual({ requests: 1, cancelled: true })
          expect(failure.message).not.toContain("private-query")
        }),
      {
        instructions: ["http://fixture.invalid/large?token=private-query#fragment"],
        limits: { maxSourceBytes: 1024 },
        http: HttpClient.make((request) => {
          state.requests++
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(768).fill(120))
            },
            cancel() {
              state.cancelled = true
            },
          })
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(stream, { headers: { "content-length": "1" } })),
          )
        }),
      },
    )
  })

  it.live(
    "fails the complete system batch on a permanent HTTP error and retries without dropping local instructions",
    () => {
      const state = { requests: 0, failing: true }
      return withFiles(
        { "AGENTS.md": "local stays part of the complete batch" },
        (dir) =>
          Effect.gen(function* () {
            const instruction = yield* Instruction.Service
            expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({
              kind: "url",
              reason: "http_status",
              status: 404,
            })
            expect(state.requests).toBe(1)
            state.failing = false
            expect(yield* instruction.system()).toEqual([
              `Instructions from: ${path.join(dir, "AGENTS.md")}\nlocal stays part of the complete batch`,
              "Instructions from: http://fixture.invalid/repaired\nremote restored",
            ])
            expect(state.requests).toBe(2)
          }),
        {
          instructions: ["http://fixture.invalid/repaired"],
          http: HttpClient.make((request) => {
            state.requests++
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("remote restored", { status: state.failing ? 404 : 200 }),
              ),
            )
          }),
        },
      )
    },
  )

  it.live("applies the remote deadline to a stalled body after headers and cancels its reader", () => {
    const state = { cancelled: false }
    return withFiles(
      {},
      () =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          expect(yield* instruction.system().pipe(Effect.flip)).toMatchObject({
            kind: "url",
            reason: "timeout",
            maximum: 30,
          })
          expect(state.cancelled).toBe(true)
        }),
      {
        instructions: ["http://fixture.invalid/stalled"],
        limits: { timeoutMs: 30 },
        http: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("prefix"))
                  },
                  cancel() {
                    state.cancelled = true
                  },
                }),
              ),
            ),
          ),
        ),
      },
    )
  })

  it.live("leaves all legacy nearby claims uncommitted when a later source exceeds the aggregate bound", () =>
    withFiles(
      {
        "nested/AGENTS.md": "outer ".repeat(30),
        "nested/deeper/AGENTS.md": "inner ".repeat(30),
        "nested/deeper/file.ts": "target",
      },
      (dir) =>
        Effect.gen(function* () {
          const instruction = yield* Instruction.Service
          const target = path.join(dir, "nested", "deeper", "file.ts")
          const id = MessageID.make("msg_bounded_legacy_batch")
          expect(yield* instruction.resolve([], target, id).pipe(Effect.flip)).toMatchObject({ reason: "total_bytes" })
          yield* write(path.join(dir, "nested", "AGENTS.md"), "outer repaired")
          yield* write(path.join(dir, "nested", "deeper", "AGENTS.md"), "inner repaired")
          const retry = yield* instruction.resolve([], target, id)
          expect(retry).toHaveLength(2)
          expect(retry.map((entry) => path.basename(path.dirname(entry.filepath)))).toEqual(["deeper", "nested"])
          expect(yield* instruction.resolve([], target, id)).toEqual([])
        }),
      { limits: { maxTotalBytes: 450, maxSourceBytes: 512 } },
    ),
  )
})

describe("Instruction.prepare", () => {
  it.live("preserves the resolver's nearest-ancestor-first instruction order", () =>
    withFiles(
      {
        "nested/AGENTS.md": "Outer instructions",
        "nested/deeper/AGENTS.md": "Nearest instructions",
        "nested/deeper/folder/file.ts": "x",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const filepath = path.join(dir, "nested", "deeper", "folder", "file.ts")
          const result = yield* svc.prepare([], filepath, () => Effect.void)
          const batch = JSON.parse(result.output) as Instruction.Batch
          expect(batch.instructions.map((item) => item.text)).toEqual(["Nearest instructions", "Outer instructions"])
        }),
    ),
  )

  it.live("keeps the serialized batch within its exact UTF-8 budget", () =>
    withFiles({ "nested/AGENTS.md": 'Line one\nEscaped "quote" and astral 𝌆', "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const preview = yield* svc.prepare([], filepath, () => Effect.void)
        const exactBytes = new TextEncoder().encode(preview.output).length
        const exact = yield* svc.prepare([], filepath, () => Effect.void, { maxBytes: exactBytes })
        const batch = JSON.parse(exact.output) as Instruction.Batch
        expect(exact.output).toBe(preview.output)
        expect(batch.instructions[0]?.text).toBe('Line one\nEscaped "quote" and astral 𝌆')
        expect(new TextEncoder().encode(exact.output).length).toBe(exactBytes)

        const oneShort = yield* Effect.flip(svc.prepare([], filepath, () => Effect.void, { maxBytes: exactBytes - 1 }))
        expect(oneShort).toBeInstanceOf(Instruction.BudgetError)
        expect(oneShort.message).toContain("cannot fit this document in a")
        expect(oneShort.message).toContain("JSON envelope")
      }),
    ),
  )

  it.live("fails with an actionable input-limit error for a document larger than the budget", () =>
    withFiles(
      {
        "nested/AGENTS.md": "Outer instructions",
        "nested/deeper/AGENTS.md": "N".repeat(1000),
        "nested/deeper/folder/file.ts": "x",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const filepath = path.join(dir, "nested", "deeper", "folder", "file.ts")
          const failure = yield* Effect.flip(svc.prepare([], filepath, () => Effect.void, { maxBytes: 220 }))
          expect(failure).toBeInstanceOf(Instruction.BudgetError)
          expect(failure.message).toContain("220-byte input limit")
          expect(failure.message).toContain(path.join(dir, "nested", "deeper", "AGENTS.md"))
          expect(failure.message).toContain("explicitly read it with textPage")
        }),
    ),
  )

  it.live("rejects instruction growth after authorization without marking a partial instruction delivered", () =>
    withFiles({ "nested/AGENTS.md": "small", "nested/deeper/file.ts": "target" }, (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const instruction = yield* Instruction.Service
        const target = path.join(dir, "nested", "deeper", "file.ts")
        const document = path.join(dir, "nested", "AGENTS.md")
        const failure = yield* instruction
          .prepare([], target, () => fs.writeFileString(document, "grown".repeat(2000)).pipe(Effect.orDie), {
            maxBytes: 1000,
          })
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(Instruction.BudgetError)
        expect(failure.message).toContain("1000-byte input limit")
        yield* fs.writeFileString(document, "complete instruction")
        const retry = yield* instruction.prepare([], target, () => Effect.void, { maxBytes: 1000 })
        const batch = JSON.parse(retry.output) as Instruction.Batch
        expect(batch.instructions.map((entry) => entry.text)).toEqual(["complete instruction"])
        expect(retry.loaded).toEqual([document])
      }),
    ),
  )

  it.live("does not read an oversized candidate body after authorization", () =>
    withFiles({ "nested/AGENTS.md": "T".repeat(4096), "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "nested", "AGENTS.md")
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const failure = yield* Effect.flip(
          svc.prepare(
            [],
            filepath,
            (requested, canonical) =>
              requested === agents && canonical === agents ? fs.remove(agents).pipe(Effect.orDie) : Effect.void,
            { maxBytes: 1024 },
          ),
        )
        expect(failure).toBeInstanceOf(Instruction.BudgetError)
        expect(failure.message).toContain("1024-byte input limit")
      }),
    ),
  )

  it.live("defers a supported document that does not fit the remaining batch budget", () =>
    withFiles(
      {
        "nested/AGENTS.md": "O".repeat(700),
        "nested/deeper/AGENTS.md": "N".repeat(3500),
        "nested/deeper/folder/file.ts": "x",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const filepath = path.join(dir, "nested", "deeper", "folder", "file.ts")
          const result = yield* svc.prepare([], filepath, () => Effect.void, { maxBytes: 4000 })
          const batch = JSON.parse(result.output) as Instruction.Batch
          expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(4000)
          expect(batch.instructions.map((item) => item.text)).toEqual(["N".repeat(3500)])
          expect(batch.pending).toContain(path.join(dir, "nested", "AGENTS.md"))
          expect(result.pending).toBe(true)
        }),
    ),
  )

  it.live("fails when JSON escaping makes a body exceed the fresh document envelope", () =>
    withFiles({ "nested/AGENTS.md": '"\n\\'.repeat(1200), "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const failure = yield* Effect.flip(svc.prepare([], filepath, () => Effect.void, { maxBytes: 6000 }))
        expect(failure).toBeInstanceOf(Instruction.BudgetError)
        expect(failure.message).toContain("cannot fit this document in a 6000-byte JSON envelope")
        expect(failure.message).toContain(path.join(dir, "nested", "AGENTS.md"))
      }),
    ),
  )

  it.live("continues past eight recorded instructions on a later batch", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      let parent = dir
      for (let index = 0; index < 10; index++) {
        parent = path.join(parent, `level-${index}`)
        yield* write(path.join(parent, "AGENTS.md"), `Instruction ${index}`)
      }
      const filepath = path.join(parent, "file.ts")
      yield* write(filepath, "target")

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const first = yield* svc.prepare([], filepath, () => Effect.void)
          const firstBatch = JSON.parse(first.output) as Instruction.Batch
          expect(firstBatch.instructions).toHaveLength(8)
          expect(first.hasMore).toBe(true)

          const second = yield* svc.prepare(recordedBatch(first.output), filepath, () => Effect.void)
          const secondBatch = JSON.parse(second.output) as Instruction.Batch
          expect(secondBatch.instructions).toHaveLength(2)
          expect(second.hasMore).toBe(false)
          expect(second.pending).toBe(false)
        }).pipe(provideInstruction({ home: dir, config: dir })),
      )
    }),
  )

  it.live("records empty instruction documents so later batches can advance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      let parent = dir
      for (let index = 0; index < 10; index++) {
        parent = path.join(parent, `empty-${index}`)
        yield* write(path.join(parent, "AGENTS.md"), "")
      }
      const filepath = path.join(parent, "file.ts")
      yield* write(filepath, "target")

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const first = yield* svc.prepare([], filepath, () => Effect.void)
          const firstBatch = JSON.parse(first.output) as Instruction.Batch
          expect(firstBatch.instructions).toHaveLength(8)
          expect(firstBatch.instructions.every((item) => item.text === "" && item.totalLength === 0)).toBe(true)
          expect(first.pending).toBe(true)

          const second = yield* svc.prepare(recordedBatch(first.output), filepath, () => Effect.void)
          const secondBatch = JSON.parse(second.output) as Instruction.Batch
          expect(secondBatch.instructions).toHaveLength(2)
          expect(secondBatch.instructions.every((item) => item.text === "" && item.totalLength === 0)).toBe(true)
          expect(second.pending).toBe(false)
          expect(second.hasMore).toBe(false)
        }).pipe(provideInstruction({ home: dir, config: dir })),
      )
    }),
  )

  it.live("does not return or record instructions when candidate authorization fails", () =>
    withFiles({ "nested/AGENTS.md": "Protected instructions", "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const denied = yield* svc
          .prepare([], filepath, () => Effect.die(new Error("instruction denied")))
          .pipe(Effect.exit)
        expect(denied._tag).toBe("Failure")

        const retry = yield* svc.prepare([], filepath, () => Effect.void)
        const batch = JSON.parse(retry.output) as Instruction.Batch
        expect(batch.instructions[0]?.text).toBe("Protected instructions")
      }),
    ),
  )

  it.live("recognizes only canonical in-project enabled instruction documents", () =>
    withFiles({ "nested/AGENTS.md": "Project instructions", "nested/rules.md": "ordinary" }, (dir) =>
      Effect.gen(function* () {
        const outside = yield* tmpWithFiles({ "AGENTS.md": "Outside" })
        const svc = yield* Instruction.Service
        expect(yield* svc.isDocument(path.join(dir, "nested", "AGENTS.md"))).toBe(true)
        expect(yield* svc.isDocument(path.join(dir, "nested", "rules.md"))).toBe(false)
        expect(yield* svc.isDocument(path.join(outside, "AGENTS.md"))).toBe(false)
      }),
    ),
  )

  it.live("propagates non-NotFound stat failures from document classification", () =>
    withFiles({ "nested/AGENTS.md": "instructions" }, () =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const invalid = yield* svc.isDocument("\0").pipe(Effect.exit)
        expect(invalid._tag).toBe("Failure")
      }),
    ),
  )

  const fileSymlinkTest = process.platform === "win32" ? it.live.skip : it.live
  fileSymlinkTest("deduplicates ancestor aliases that resolve to one canonical instruction file", () =>
    withFiles({ "nested/real/AGENTS.md": "Shared instructions", "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const source = path.join(dir, "nested", "real", "AGENTS.md")
        const nearAlias = path.join(dir, "nested", "deeper", "AGENTS.md")
        const outerAlias = path.join(dir, "nested", "AGENTS.md")
        yield* Effect.promise(() => symlink(source, nearAlias))
        yield* Effect.promise(() => symlink(source, outerAlias))
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const authorized: string[] = []
        const result = yield* svc.prepare([], filepath, (requested, canonical) =>
          Effect.sync(() => {
            authorized.push(requested)
            expect(canonical).toBe(source)
          }),
        )
        const batch = JSON.parse(result.output) as Instruction.Batch
        expect(batch.instructions).toHaveLength(1)
        expect(batch.instructions[0]?.filepath).toBe(source)
        expect(authorized).toEqual([nearAlias])
      }),
    ),
  )

  fileSymlinkTest("does not classify an instruction-named alias to an ordinary canonical file", () =>
    withFiles({ "nested/rules.md": "ordinary" }, (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          symlink(path.join(dir, "nested", "rules.md"), path.join(dir, "nested", "AGENTS.md")),
        )
        const svc = yield* Instruction.Service
        expect(yield* svc.isDocument(path.join(dir, "nested", "AGENTS.md"))).toBe(false)
      }),
    ),
  )
})

describe("Instruction.receipts", () => {
  it.live("accepts complete verified page coverage from completed reads", () =>
    withFiles({ "nested/AGENTS.md": "0123456789", "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const source = "0123456789"
        const one = JSON.stringify(
          page(path.join(dir, "nested", "AGENTS.md"), source.slice(0, 5), 0, 5, source.length, source),
        )
        const two = JSON.stringify(
          page(path.join(dir, "nested", "AGENTS.md"), source.slice(5), 5, 10, source.length, source),
        )
        const first = recordedRead(one, { receipt: { kind: "page", start: 0, end: one.length } })[0]!
        const second = recordedRead(two, { receipt: { kind: "page", start: 0, end: two.length } })[0]!
        const messages = [{ ...first, parts: [...first.parts, ...second.parts] }]
        const result = yield* svc.prepare(messages, filepath, () => Effect.void)
        expect((JSON.parse(result.output) as Instruction.Batch).instructions).toEqual([])
      }),
    ),
  )

  it.live("rejects gaps, conflicting overlaps, mutation, compacted, malformed receipts, and legacy fallback", () =>
    withFiles({ "nested/AGENTS.md": "0123456789", "nested/deeper/file.ts": "x" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "nested", "deeper", "file.ts")
        const agents = path.join(dir, "nested", "AGENTS.md")
        const source = "0123456789"
        const makeReceipt = (text: string, offset: number, nextOffset: number) => {
          const raw = JSON.stringify(page(agents, text, offset, nextOffset, source.length, source))
          return recordedRead(raw, { receipt: { kind: "page", start: 0, end: raw.length }, loaded: [agents] })[0]!
        }
        const gapped = makeReceipt(source.slice(0, 3), 0, 3)
        const gapTail = makeReceipt(source.slice(4), 4, 10)
        const conflictA = makeReceipt(source.slice(0, 6), 0, 6)
        const conflictB = makeReceipt("XXXXX", 5, 10)
        const mutated = makeReceipt(source.slice(0, 5), 0, 5)
        const mutatedTailRaw = JSON.stringify({ ...page(agents, "XXXXX", 5, 10, source.length, source) })
        const mutatedTail = recordedRead(mutatedTailRaw, {
          receipt: { kind: "page", start: 0, end: mutatedTailRaw.length },
        })[0]!
        const badHashRaw = JSON.stringify(
          page(agents, "X".repeat(source.length), 0, source.length, source.length, source),
        )
        const badHash = recordedRead(badHashRaw, { receipt: { kind: "page", start: 0, end: badHashRaw.length } })[0]!
        const compactedRaw = JSON.stringify(page(agents, source, 0, source.length, source.length))
        const compacted = recordedRead(
          compactedRaw,
          { receipt: { kind: "page", start: 0, end: compactedRaw.length } },
          1,
        )[0]!
        const malformed = recordedRead("not json", {
          receipt: { kind: "page", start: 0, end: 8 },
          loaded: [agents],
        })[0]!
        const badLengthRaw = JSON.stringify({ ...page(agents, "short", 0, 10, 10), contentHash: "a".repeat(64) })
        const badLength = recordedRead(badLengthRaw, {
          receipt: { kind: "page", start: 0, end: badLengthRaw.length },
        })[0]!
        const cases = [
          [gapped, gapTail],
          [conflictA, conflictB],
          [mutated, mutatedTail],
          [badHash],
          [compacted],
          [malformed],
          [badLength],
        ]
        for (const parts of cases) {
          const first = parts[0]!
          const messages = [{ ...first, parts: parts.flatMap((item) => item.parts) }]
          const result = yield* svc.prepare(messages, filepath, () => Effect.void)
          expect((JSON.parse(result.output) as Instruction.Batch).instructions[0]?.text).toBe(source)
        }
      }),
    ),
  )
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})
