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
import { DialogSelect } from "../src/ui/dialog-select"
import { useLocal } from "../src/context/local"
import { createSignal } from "solid-js"
import { unwrap } from "solid-js/store"

test("Duo dialog rendered integration", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const setup = await createTestRenderer({ width: 120, height: 40, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const model = (id: string, variant: string) => ({
    id,
    providerID: "test",
    name: id === "one" ? "One" : "Two",
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
    variants: { [variant]: {} },
  })
  const provider = {
    id: "test",
    name: "Test provider",
    source: "config",
    env: [],
    options: {},
    models: { one: model("one", "high"), two: model("two", "deep") },
  }
  const agents = [
    { name: "build", mode: "primary", permission: [], options: {} },
    { name: "coder", mode: "all", permission: [], options: {} },
    { name: "reviewer", mode: "subagent", permission: [], options: {} },
  ]
  let settingsCalls = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/path")
      return json({ home: tmp.path, state, config: tmp.path, worktree: tmp.path, directory: tmp.path })
    if (url.pathname === "/command") return json([{ name: "duo", description: "Duo", template: "", hints: [] }])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "one" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { test: "one" }, connected: ["test"] })
    if (url.pathname === "/agent") return json(agents)
    if (url.pathname === "/duo/settings") {
      settingsCalls++
      return json({
        participants: [
          { name: "One", model: "test/one", variant: "high" },
          { name: "Two", model: "test/two" },
        ],
        review: true,
        peerChars: 4000,
      })
    }
    if (url.pathname === "/session/ses_created")
      return json({
        id: "ses_created",
        title: "Duo",
        directory: tmp.path,
        projectID: "proj_test",
        version: "1",
        time: { created: Date.now(), updated: Date.now() },
      })
    if (url.pathname.startsWith("/session/ses_")) return json([])
  }, events)
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === "POST" && (url.pathname === "/session" || url.pathname.endsWith("/command"))) {
      requests.push({ path: url.pathname, body: await request.json() })
      if (url.pathname === "/session") {
        await Bun.sleep(40)
        return json({
          id: "ses_created",
          title: "Duo",
          directory: tmp.path,
          projectID: "proj_test",
          version: "1",
          time: { created: Date.now(), updated: Date.now() },
        })
      }
      return json({})
    }
    return calls.fetch(input, init)
  }) as typeof globalThis.fetch
  let api!: TuiPluginApi
  let prompt!: TuiPromptRef
  let local!: ReturnType<typeof useLocal>
  const [session, setSession] = createSignal<string | undefined>("ses_duo")
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
      args: {},
      pluginHost: {
        async start(input) {
          api = input.api
          unregister = input.runtime.setupSlots(input.api).register({
            id: "test:duo",
            slots: {
              home_prompt: (_context, props) => {
                local = useLocal()
                return input.api.ui.Prompt({
                  ...props,
                  get sessionID() {
                    return session()
                  },
                  ref: (value) => {
                    if (value) prompt = value
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
  async function open(input: string, parts: TuiPromptRef["current"]["parts"] = []) {
    api.keymap.dispatchCommand("prompt.autocomplete.hide")
    prompt.set({ input, parts })
    prompt.submit()
    await wait(() => frame().includes("Coordinator candidate"))
  }
  try {
    await ready
    await wait(() => api.state.ready && Boolean(prompt))
    api.ui.dialog.clear()
    api.ui.dialog.replace(() => (
      <DialogSelect title="Baseline selector" options={[{ title: "One constant", value: "one" }]} />
    ))
    await wait(() => frame().includes("One constant"))
    api.ui.dialog.clear()
    const originalModel = local.model.current()
    const originalAgent = local.agent.current()?.name
    await open("/duo")
    expect(settingsCalls).toBe(1)
    expect(requests).toEqual([])
    await select(0)
    await wait(() => frame().includes("Select model"))
    await select(1)
    await wait(() => frame().includes("Configure Duo"))
    expect(frame()).not.toContain("is unavailable")
    await select(1)
    await wait(() => frame().includes("Select variant"))
    await select(1)
    await wait(() => frame().includes("Configure Duo"))
    await select(2)
    await wait(() => frame().includes("Select agent"))
    await select(3)
    await wait(() => frame().includes("Coordinator: build"))
    await select(2)
    await wait(() => frame().includes("Select agent"))
    await select(2)
    await wait(() => frame().includes("Coordinator: coder"))
    await select(3)
    await wait(() => frame().includes("Select model"))
    await select(0)
    await wait(() => frame().includes("Configure Duo"))
    await select(4)
    await wait(() => frame().includes("Select variant"))
    await select(1)
    await wait(() => frame().includes("Configure Duo"))
    await select(5)
    await wait(() => frame().includes("Select agent"))
    await select(3)
    await wait(() => frame().includes("Configure Duo"))
    await select(6)
    expect(requests).toEqual([])
    expect(prompt.current.input).toBe("/duo")
    expect(local.model.current()).toEqual(originalModel)
    expect(local.agent.current()?.name).toBe(originalAgent)
    const parts: TuiPromptRef["current"]["parts"] = [
      { type: "file", mime: "image/png", filename: "image.png", url: "data:image/png;base64,AA==" },
    ]
    const objective = "--status literal\nsecond line  with spaces"
    await open(`/duo ${objective}`, parts)
    const retained = structuredClone(unwrap(prompt.current))
    setup.mockInput.pressEscape()
    await wait(() => !frame().includes("Configure Duo"))
    expect(prompt.current).toEqual(retained)
    expect(requests).toEqual([])
    for (const control of ["status", "resume", "cancel", "continue next instruction"]) {
      api.keymap.dispatchCommand("prompt.autocomplete.hide")
      prompt.set({ input: `/duo ${control}`, parts: [] })
      prompt.submit()
      await wait(() => requests.some((item) => item.body.arguments === control))
      expect(frame()).not.toContain("Configure Duo")
      expect(requests.at(-1)?.body.duo).toBeUndefined()
    }
    expect(requests.filter((item) => item.path === "/session")).toHaveLength(0)
    requests.splice(0)
    setSession(undefined)
    await open(`/duo ${objective}`, parts)
    await select(6)
    api.keymap.dispatchCommand("dialog.select.submit")
    prompt.set({ input: "a newer draft typed while creating", parts: [] })
    prompt.submit()
    await wait(() => requests.some((item) => item.path.endsWith("/command")))
    expect(requests.filter((item) => item.path === "/session")).toHaveLength(1)
    expect(requests.filter((item) => item.path.endsWith("/command"))).toHaveLength(1)
    expect(requests[0].body.agent).toBe("coder")
    expect(requests[0].body.model).toEqual({ providerID: "test", id: "two", variant: "deep" })
    expect(requests[1].body.arguments).toBe(objective)
    expect(requests[1].body.parts).toEqual(parts)
    expect(requests[1].body.duo).toEqual({
      participants: [
        { name: "Two", model: "test/two", variant: "deep", agent: "coder" },
        { name: "One", model: "test/one", variant: "high", agent: "reviewer" },
      ],
    })
    expect(prompt.current.input).toBe("a newer draft typed while creating")
  } finally {
    api?.ui.dialog.clear()
    unregister?.()
    api?.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 30000)
