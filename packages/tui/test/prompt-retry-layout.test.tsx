import { expect, mock, test } from "bun:test"
import type { TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"
import type { HostSlotPlugin } from "../src/plugin/slots"

const sessionID = "ses_retry_layout"
const errors = [
  {
    message: "Short retry failure: the endpoint refused the request; TAIL_SHORT",
    head: "Short retry failure",
    tail: "TAIL_SHORT",
  },
  {
    message:
      "First diagnostic line\nSecond line explains the provider state\nThird line includes more context\nFourth line ends in TAIL_MULTILINE",
    head: "First diagnostic line",
    tail: "TAIL_MULTILINE",
  },
  {
    message: `UNBROKEN_START_${"x".repeat(120)}_TAIL_UNBROKEN`,
    head: "UNBROKEN_START_",
    tail: "_TAIL_UNBROKEN",
  },
]
const longPath =
  "C:\\Users\\victoria\\OneDrive - Example_日本語\\Documents\\Codex\\a-very-long-project-location\\packages\\tui"

async function waitFor(fn: () => boolean, render: () => Promise<void>, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await render()
    await Bun.sleep(10)
  }
}

test("retry prompt stays one row and exposes the complete error without losing the draft", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const setup = await createTestRenderer({ width: 50, height: 12, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/path")
      return json({ home: tmp.path, state, config: tmp.path, worktree: longPath, directory: longPath })
    if (url.pathname === "/session/status")
      return json({ [sessionID]: { type: "retry", attempt: 2, message: errors[0].message, next: Date.now() + 60_000 } })
  }, events)

  let api!: TuiPluginApi
  let prompt!: TuiPromptRef
  let unregister: (() => void) | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => (started = resolve))
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory: longPath,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: {},
      pluginHost: {
        async start(input) {
          api = input.api
          const slots = input.runtime.setupSlots(input.api)
          unregister = slots.register({
            id: "test:prompt-retry-layout",
            slots: {
              home_prompt: (_context, props) =>
                input.api.ui.Prompt({
                  ...props,
                  sessionID,
                  ref: (value) => {
                    if (value) prompt = value
                    props.ref?.(value)
                  },
                }),
            },
          } satisfies HostSlotPlugin)
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

  try {
    await ready
    await waitFor(
      () => api.state.ready,
      () => setup.renderOnce(),
    )
    await waitFor(
      () => api.state.session.status(sessionID)?.type === "retry",
      () => setup.renderOnce(),
    )
    await setup.renderOnce()
    api.ui.dialog.clear()
    await setup.renderOnce()
    await waitFor(
      () => {
        const frame = setup.captureCharFrame().replaceAll("▀", "")
        return frame.includes("error details") && frame.includes("interrupt")
      },
      () => setup.renderOnce(),
    )
    await waitFor(
      () => Boolean(prompt),
      () => setup.renderOnce(),
    )
    prompt.set({ input: "keep this draft", parts: [] })
    await setup.renderOnce()

    const rows = () => setup.captureCharFrame().replaceAll("▀", "").split("\n")
    const frame = rows()
    const retryRows = () => rows().filter((row) => row.includes("error details") && row.includes("interrupt"))
    expect(retryRows()).toHaveLength(1)
    expect(retryRows()[0]).toContain("esc")
    expect(frame.join("\n")).toContain("keep this draft")

    for (const [index, error] of errors.entries()) {
      if (index > 0) {
        events.emit({
          directory: longPath,
          payload: {
            id: `evt_retry_layout_${index}`,
            type: "session.status",
            properties: {
              sessionID,
              status: { type: "retry", attempt: index + 2, message: error.message, next: Date.now() + 60_000 },
            },
          },
        })
        await waitFor(
          () => {
            const status = api.state.session.status(sessionID)
            return status?.type === "retry" && status.message === error.message
          },
          () => setup.renderOnce(),
        )
      }

      api.keymap.dispatchCommand("prompt.retry.details")
      await setup.renderOnce()
      await waitFor(
        () => rows().some((row) => row.includes("Retry Error")),
        () => setup.renderOnce(),
      )
      expect(rows().join("\n")).toContain("Retry Error")

      if (index === 0) {
        setup.resize(120, 36)
        await setup.renderOnce()
        expect(rows().join("\n")).toContain("Retry Error")
        setup.resize(50, 12)
        await setup.renderOnce()
        expect(rows().join("\n")).toContain("Retry Error")
      }

      setup.mockInput.pressKey("END")
      await setup.renderOnce()
      await waitFor(
        () => rows().join("\n").includes(error.tail),
        () => setup.renderOnce(),
      )
      expect(rows().join("\n")).toContain(error.tail)
      setup.mockInput.pressKey("HOME")
      await setup.renderOnce()
      await waitFor(
        () => rows().join("\n").includes(error.head),
        () => setup.renderOnce(),
      )
      expect(rows().join("\n")).toContain(error.head)

      setup.mockInput.pressEscape()
      await setup.renderOnce()
      await waitFor(
        () => !rows().some((row) => row.includes("Retry Error")),
        () => setup.renderOnce(),
      )
      expect(rows().join("\n")).toContain("keep this draft")
      await waitFor(
        () => prompt.focused,
        () => setup.renderOnce(),
      )
      expect(retryRows()).toHaveLength(1)
      expect(retryRows()[0]).toContain("esc")
    }
  } finally {
    if (prompt && !setup.renderer.isDestroyed) prompt.set({ input: "", parts: [] })
    if (api) {
      api.ui.dialog.clear()
    }
    unregister?.()
    api?.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 20000)
