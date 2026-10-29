import { afterAll, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Consultation } from "@/consultation"
import { Storage } from "@/storage/storage"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const config = mkdtempSync(path.join(tmpdir(), "cudia-consultation-test-"))
writeFileSync(
  path.join(config, "consultation.json"),
  JSON.stringify({ enabled: true, agent: "sol-consultor", providers: ["drael"], mode: "technical" }),
)
const disabledConfig = mkdtempSync(path.join(tmpdir(), "cudia-consultation-disabled-test-"))
writeFileSync(path.join(disabledConfig, "consultation.json"), JSON.stringify({ enabled: false }))
afterAll(() => {
  rmSync(config, { recursive: true, force: true })
  rmSync(disabledConfig, { recursive: true, force: true })
})

const records = new Map<string, unknown>()
const memory = Layer.mock(Storage.Service, {
  read: <T>(key: string[]) => {
    const value = records.get(key.join("/"))
    return value === undefined
      ? Effect.fail(new Storage.NotFoundError({ message: "missing" }))
      : Effect.succeed(value as T)
  },
  write: (key: string[], value: unknown) => Effect.sync(() => void records.set(key.join("/"), value)),
  update: <T>(key: string[], fn: (draft: T) => void) => {
    const value = records.get(key.join("/")) as T
    fn(value)
    records.set(key.join("/"), value)
    return Effect.succeed(value)
  },
  remove: (key: string[]) => Effect.sync(() => void records.delete(key.join("/"))),
  list: () => Effect.succeed([]),
})
const suite = testEffect(
  LayerNode.compile(Consultation.node, [
    [Global.node, Global.layerWith({ config })],
    [Storage.node, memory],
  ]),
)
const disabledSuite = testEffect(
  LayerNode.compile(Consultation.node, [
    [Global.node, Global.layerWith({ config: disabledConfig })],
    [Storage.node, memory],
  ]),
)

function input(overrides: Partial<Consultation.Input> = {}): Consultation.Input {
  return {
    sessionID: SessionID.create(),
    providerID: "drael",
    agentName: "redteam",
    messageID: MessageID.ascending(),
    continuation: false,
    request: "Implemente e teste a correção do bug na API.",
    messages: [],
    ...overrides,
  }
}

function assistant(sessionID: SessionID, parts: SessionV1.Part[]): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      parentID: MessageID.ascending(),
      sessionID,
      role: "assistant",
      agent: "redteam",
      mode: "build",
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("drael"),
      time: { created: Date.now(), completed: Date.now() },
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts,
  }
}

function failure(sessionID: SessionID, tool: string, exit?: number) {
  const messageID = MessageID.ascending()
  const part: SessionV1.Part = {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    callID: `call-${tool}`,
    tool,
    state:
      exit === undefined
        ? { status: "error", input: {}, error: `${tool} failed`, time: { start: 0, end: 1 } }
        : {
            status: "completed",
            input: {},
            output: "failed",
            title: tool,
            metadata: { exit },
            time: { start: 0, end: 1 },
          },
  }
  return assistant(sessionID, [part])
}

disabledSuite.instance("missing consent policy disables automatic consultation", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    expect(yield* service.claim(input())).toBeUndefined()
    expect(yield* service.beforeTool(input(), "edit", { filePath: "src/a.ts" })).toBe(false)
  }),
)

suite.instance("automatically claims one Portuguese or English technical request, but not chat", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const pt = input()
    const first = yield* service.claim(pt)
    expect(first).toMatchObject({ agent: "sol-consultor", reason: "technical" })
    expect(yield* service.claim(pt)).toBeUndefined()

    const chat = input({ request: "Olá, tudo bem?", continuation: false })
    expect(yield* service.claim(chat)).toBeUndefined()
    const english = input({ request: "Please debug the Python API and add a regression test." })
    expect(yield* service.claim(english)).toMatchObject({ reason: "technical" })
  }),
)

suite.instance("requires exact provider scope and excludes child, plan, and advisor sessions", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const sessionID = SessionID.create()
    const request = "Implement the requested code change."
    for (const item of [
      input({ sessionID, providerID: "openai", request }),
      input({ sessionID, parentSessionID: SessionID.create(), request }),
      input({ sessionID, agentName: "plan", request }),
      input({ sessionID, agentName: "sol-consultor", request }),
    ]) {
      expect(yield* service.claim(item)).toBeUndefined()
    }
    expect(yield* service.claim(input({ sessionID, request }))).toMatchObject({ agent: "sol-consultor" })
  }),
)

suite.instance("defers first work tool until the claim is consumed; discovery and reads pass", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const item = input()
    expect(yield* service.beforeTool(item, "read", {})).toBe(false)
    expect(yield* service.beforeTool(item, "agent_search", {})).toBe(false)
    expect(yield* service.beforeTool(item, "bash", { command: "bun test" })).toBe(true)
    expect(yield* service.beforeTool(item, "edit", { filePath: "src/a.ts" })).toBe(true)
    const claimed = yield* service.claim(item)
    expect(claimed).toMatchObject({ reason: "technical-tool" })
    yield* service.finish(claimed!, "completed")
    expect(yield* service.beforeTool(item, "bash", { command: "bun test" })).toBe(false)
  }),
)

suite.instance("parallel work tool calls request one consultation without executing", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const item = input()
    const deferred = yield* Effect.all(
      [
        service.beforeTool(item, "bash", { command: "bun test" }),
        service.beforeTool(item, "edit", { filePath: "src/a.ts" }),
      ],
      { concurrency: "unbounded" },
    )
    expect(deferred).toEqual([true, true])
    expect(yield* service.claim(item)).toMatchObject({ reason: "technical-tool" })
  }),
)

suite.instance("excludes a delegated task for the selected consultant from work deferral", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const item = input()
    expect(yield* service.beforeTool(item, "task", { subagent_type: "sol-consultor" })).toBe(false)
    expect(yield* service.beforeTool(item, "task", { subagent_type: "general" })).toBe(true)
  }),
)

suite.instance("a classifier miss is caught before the first mutating tool", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const item = input({ request: "Please take care of this." })
    expect(yield* service.claim(item)).toBeUndefined()
    expect(yield* service.beforeTool(item, "edit", { filePath: "src/a.ts" })).toBe(true)
    expect(yield* service.claim(item)).toMatchObject({ reason: "technical-tool" })
  }),
)

suite.instance("second consultation requires two new failed tools and sends only bounded diagnostics", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const firstInput = input({ goalID: "goal-a" })
    const first = yield* service.claim(firstInput)
    yield* service.finish(first!, "completed")

    const oneFailure = failure(firstInput.sessionID, "bash", 1)
    const continuing = input({
      ...firstInput,
      continuation: true,
      messages: [oneFailure],
    })
    expect(yield* service.claim(continuing)).toBeUndefined()

    const twoFailures = failure(firstInput.sessionID, "edit")
    const recovered = yield* service.claim({ ...continuing, messages: [oneFailure, twoFailures] })
    expect(recovered).toMatchObject({ reason: "recovery" })
    expect(recovered?.prompt).toContain("New failed tool diagnostics:")
    expect(recovered?.prompt).toContain("bash")
    expect(recovered?.prompt).toContain("edit")
    yield* service.finish(recovered!, "failed")
  }),
)

suite.instance("cancelled or interrupted tool errors do not qualify as recovery failures", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const initial = input({ goalID: "goal-cancel" })
    const first = yield* service.claim(initial)
    yield* service.finish(first!, "completed")
    const cancelled = failure(initial.sessionID, "bash")
    if (cancelled.parts[0]?.type !== "tool" || cancelled.parts[0].state.status !== "error")
      throw new Error("expected an error tool fixture")
    cancelled.parts[0].state.error = "AbortError: operation cancelled"
    const interrupted = failure(initial.sessionID, "edit")
    if (interrupted.parts[0]?.type !== "tool" || interrupted.parts[0].state.status !== "error")
      throw new Error("expected an error tool fixture")
    interrupted.parts[0].state.metadata = { interrupted: true }
    expect(
      yield* service.claim({
        ...initial,
        continuation: true,
        messages: [cancelled, interrupted],
      }),
    ).toBeUndefined()
  }),
)

suite.instance("same goal continuation reuses scope; new manual objective resets it", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const firstInput = input({ goalID: "goal-a" })
    const first = yield* service.claim(firstInput)
    expect(first?.scopeID).toBe(firstInput.messageID)
    yield* service.finish(first!, "completed")
    const resumed = yield* service.claim(
      input({
        ...firstInput,
        messageID: MessageID.ascending(),
        continuation: true,
      }),
    )
    expect(resumed).toBeUndefined()
    expect(
      yield* service.claim(input({ ...firstInput, continuation: false, messageID: MessageID.ascending() })),
    ).toBeUndefined()
    const manual = yield* service.claim(input({ ...firstInput, goalID: undefined, messageID: MessageID.ascending() }))
    expect(manual).toMatchObject({ reason: "technical" })
    expect(manual?.scopeID).not.toBe(first?.scopeID)
  }),
)

suite.instance("interrupted consultation can retry once within the configured cap", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const initial = input({ goalID: "goal-retry" })
    const first = yield* service.claim(initial)
    yield* service.finish(first!, "interrupted")
    const resume = input({ ...initial, messageID: MessageID.ascending(), continuation: true })
    const second = yield* service.claim(resume)
    expect(second).toMatchObject({ reason: "technical" })
    yield* service.finish(second!, "interrupted")
    expect(yield* service.claim(resume)).toBeUndefined()
  }),
)

suite.instance("a pending claim recovered after restart is retried once and then capped", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const item = input({ goalID: "goal-crash", continuation: true })
    records.set(`consultation/${item.sessionID}`, {
      sessionID: item.sessionID,
      scopeID: item.messageID,
      goalID: item.goalID,
      request: item.request,
      attempts: [
        {
          id: "pending-before-restart",
          reason: "technical",
          status: "pending",
          checkpoint: item.messageID,
          requestedAt: 0,
          prompt: "prior claim",
        },
      ],
    })

    const retry = yield* service.claim(item)
    expect(retry).toMatchObject({ reason: "technical" })
    yield* service.finish(retry!, "interrupted")
    expect(yield* service.claim(item)).toBeUndefined()
  }),
)

suite.instance("consultation prompt redacts credentials and does not expand file references", () =>
  Effect.gen(function* () {
    const service = yield* Consultation.Service
    const item = input({ request: "Fix src/app.ts with token=supersecretvalue123 and inspect @private.txt" })
    const claimed = yield* service.claim(item)
    expect(claimed?.prompt).toContain("[redacted]")
    expect(claimed?.prompt).toContain("@private.txt")
    expect(claimed?.prompt).not.toContain("supersecretvalue123")
  }),
)
