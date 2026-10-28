/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"
import { useLocal } from "../src/context/local"
import { useKV } from "../src/context/kv"
import { unwrap } from "solid-js/store"

test("compact command selects a compaction model without changing the active chat model", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(
    path.join(state, "kv.json"),
    JSON.stringify({ compaction_model: { providerID: "test", modelID: "remembered" } }),
  )
  const setup = await createTestRenderer({ width: 120, height: 40, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const model = (id: string, variants: Record<string, unknown> = {}) => ({
    id,
    providerID: "test",
    name: id === "main" ? "Main Model" : id === "remembered" ? "Remembered Model" : "Plain Model",
    api: { id, url: "http://test", npm: "test" },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 10000, output: 1000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants,
  })
  const provider = {
    id: "test",
    name: "Test provider description",
    source: "config",
    env: [],
    options: {},
    models: {
      main: model("main"),
      configured: model("configured"),
      remembered: model("remembered", { balanced: {}, deep: {} }),
      plain: model("plain"),
    },
  }
  const agents = [
    { name: "build", mode: "primary", permission: [], options: {} },
    {
      name: "compaction",
      mode: "subagent",
      model: { providerID: "test", modelID: "configured" },
      permission: [],
      options: {},
    },
  ]
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let failNext = false
  const base = createFetch((url) => {
    if (url.pathname === "/path")
      return json({ home: tmp.path, state, config: tmp.path, worktree: tmp.path, directory: tmp.path })
    if (url.pathname === "/command") return json([{ name: "compact", description: "Compact", template: "", hints: [] }])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "main" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { test: "main" }, connected: ["test"] })
    if (url.pathname === "/agent") return json(agents)
    if (url.pathname === "/session/ses_compact")
      return json({
        id: "ses_compact",
        title: "Compact",
        directory: tmp.path,
        projectID: "proj_test",
        version: "1",
        time: { created: Date.now(), updated: Date.now() },
      })
    if (url.pathname.startsWith("/session/ses_")) return json([])
  }, events)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname.endsWith("/summarize")) {
      calls.push({ path: url.pathname, body: await request.json() })
      if (failNext) {
        failNext = false
        return json({ message: "summary unavailable" }, { status: 500 })
      }
      return json(true)
    }
    return base.fetch(input, init)
  }) as typeof globalThis.fetch
  let api!: TuiPluginApi
  let prompt: TuiPromptRef | undefined
  let local!: ReturnType<typeof useLocal>
  let kv!: ReturnType<typeof useKV>
  let sessionPromptMounted = false
  let started!: () => void
  let unregister: (() => void) | undefined
  const ready = new Promise<void>((resolve) => (started = resolve))
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory: tmp.path,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch,
      events: events.source,
      args: { sessionID: "ses_compact" },
      pluginHost: {
        async start(input) {
          api = input.api
          unregister = input.runtime.setupSlots(input.api).register({
            id: "test:compact",
            slots: {
              session_prompt: (_context, props) => {
                sessionPromptMounted = true
                local = useLocal()
                kv = useKV()
                return input.api.ui.Prompt({
                  ...props,
                  get sessionID() {
                    return props.session_id
                  },
                  ref: (value) => {
                    prompt = value
                    props.ref?.(value)
                  },
                })
              },
            },
          })
          started()
        },
        async dispose() {},
      },
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Global.node, [
          [
            Global.node,
            Global.layerWith({
              home: tmp.path,
              data: path.join(tmp.path, "data"),
              cache: path.join(tmp.path, "cache"),
              config: path.join(tmp.path, "config"),
              state,
              tmp: path.join(tmp.path, "tmp"),
              bin: path.join(tmp.path, "bin"),
              log: path.join(tmp.path, "log"),
              repos: path.join(tmp.path, "repos"),
            }),
          ],
        ]),
      ),
    ),
  )
  const frame = () => setup.captureCharFrame().replaceAll("▀", "")
  async function wait(fn: () => boolean) {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > 3000) throw new Error(`condition timeout: ${frame()}`)
      await setup.renderOnce()
      await Bun.sleep(10)
    }
    await setup.renderOnce()
  }
  async function select(index: number) {
    api.keymap.dispatchCommand("dialog.select.home")
    for (let i = 0; i < index; i++) api.keymap.dispatchCommand("dialog.select.next")
    api.keymap.dispatchCommand("dialog.select.submit")
    await setup.renderOnce()
    await Bun.sleep(15)
  }
  async function submit() {
    api.keymap.dispatchCommand("dialog.select.submit")
    await setup.renderOnce()
    await Bun.sleep(15)
  }
  async function open() {
    api.keymap.dispatchCommand("session.compact")
    await wait(() => frame().includes("Compact session · select model"))
  }
  try {
    await ready
    await wait(() => api.state.ready && sessionPromptMounted && Boolean(prompt))
    const originalModel = structuredClone(local.model.current())
    const originalAgent = local.agent.current()?.name

    const parts: TuiPromptRef["current"]["parts"] = [
      {
        type: "file",
        mime: "image/png",
        filename: "image.png",
        url: "data:image/png;base64,AA==",
        source: { type: "file", path: "image.png", text: { start: 0, end: 9, value: "[Image 1]" } },
      },
    ]
    prompt!.set({ input: "[Image 1] draft survives model picker cancel", parts })
    const modelStageDraft = structuredClone(unwrap(prompt!.current))
    await open()
    expect(frame()).toContain("Remembered Model")
    expect(frame()).toContain("Test provider description")
    setup.mockInput.pressEscape()
    await wait(() => !frame().includes("Compact session · select model"))
    expect(prompt!.current).toEqual(modelStageDraft)
    expect(calls).toHaveLength(0)

    prompt!.set({ input: "[Image 1] draft survives effort picker cancel", parts })
    const effortStageDraft = structuredClone(unwrap(prompt!.current))
    await open()
    await submit()
    await wait(() => frame().includes("Compact session · select effort"))
    expect(frame()).toContain("balanced")
    expect(frame()).toContain("deep")
    setup.mockInput.pressEscape()
    await wait(() => !frame().includes("Compact session · select effort"))
    expect(prompt!.current).toEqual(effortStageDraft)
    expect(calls).toHaveLength(0)

    await open()
    await submit()
    await wait(() => frame().includes("Compact session · select effort"))
    failNext = true
    await select(2)
    await wait(() => calls.length === 1)
    expect(calls[0]).toEqual({
      path: "/session/ses_compact/summarize",
      body: {
        modelID: "main",
        providerID: "test",
        compactionModel: { providerID: "test", modelID: "remembered", variant: "deep" },
        auto: false,
      },
    })
    expect(local.model.current()).toEqual(originalModel)
    expect(local.agent.current()?.name).toBe(originalAgent)
    await wait(() => frame().includes("summary unavailable"))

    kv.set("compaction_model", { providerID: "gone", modelID: "gone" })
    await open()
    await submit()
    await wait(() => calls.length === 2)
    expect(calls[1]).toEqual({
      path: "/session/ses_compact/summarize",
      body: {
        modelID: "main",
        providerID: "test",
        compactionModel: { providerID: "test", modelID: "configured" },
        auto: false,
      },
    })
    expect(calls).toHaveLength(2)
  } finally {
    api?.ui.dialog.clear()
    unregister?.()
    api?.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 30000)
