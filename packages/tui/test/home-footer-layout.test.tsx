import { expect, mock, test } from "bun:test"
import type { TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import homeFooter from "../src/feature-plugins/home/footer"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, json } from "./fixture/tui-sdk"

const version = "1.18.35+cudia.a59dd364c1db.c1c834f879d9"
const directory =
  "C:\\Users\\victo\\OneDrive - Contoso_日本語\\Documents\\Codex\\very-long-project-location\\packages\\tui"

test("home footer stays on one row with the compiled version and a long Windows path", async () => {
  await using tmp = await tmpdir()
  let renderer!: Awaited<ReturnType<typeof createTestRenderer>>["renderer"]
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => renderer }))

  try {
    const { run } = await import("../src/app")

    for (const width of [50, 120]) {
      const state = path.join(tmp.path, `state-${width}`)
      await mkdir(state, { recursive: true })
      await Bun.write(path.join(state, "kv.json"), "{}")
      const setup = await createTestRenderer({ width, height: 12, useThread: false })
      renderer = setup.renderer
      const events = createEventSource()
      const calls = createFetch((url) => {
        if (url.pathname === "/path")
          return json({ home: "C:\\Users\\victo", state, config: "", worktree: directory, directory })
        if (url.pathname === "/mcp") return json({ fixture: { status: "connected" } })
      }, events)
      let started!: () => void
      let quit: (() => void) | undefined
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const meta: TuiPluginMeta = {
        id: "internal:home-footer",
        source: "internal",
        spec: "internal:home-footer",
        target: "internal:home-footer",
        first_time: 0,
        last_time: 0,
        time_changed: 0,
        load_count: 1,
        fingerprint: "",
        state: "same",
      }

      const task = Effect.runPromise(
        run({
          url: "http://test",
          directory,
          config: createTuiResolvedConfig({ plugin_enabled: {} }),
          fetch: calls.fetch,
          events: events.source,
          args: {},
          pluginHost: {
            async start(input) {
              quit = () => input.api.keymap.dispatchCommand("app.exit")
              const hostSlots = input.runtime.setupSlots(input.api)
              const api: TuiPluginApi = {
                ...input.api,
                app: { ...input.api.app, version },
                slots: {
                  register(plugin: TuiSlotPlugin) {
                    hostSlots.register({ ...plugin, id: "internal:home-footer" })
                    return "internal:home-footer"
                  },
                },
              }
              await homeFooter.tui(api, undefined, meta)
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
        await setup.renderOnce()
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        const footerRows = rows.filter(
          (row) => row.includes(version.slice(0, 10)) && row.includes("MCP") && row.includes("/status"),
        )

        expect(footerRows).toHaveLength(1)
        const footerRow = footerRows[0].replaceAll("▀", "")
        expect(footerRow).toContain(version.slice(0, 10))
        expect(footerRow).toMatch(/1\s*MCP/)
        expect(rows.filter((row) => row.includes(version.slice(0, 7)))).toHaveLength(1)
        expect(rows.some((row) => row.includes("Search"))).toBe(true)
        const directoryText = footerRow.slice(0, footerRow.indexOf("⊙")).trim()
        if (width === 50) {
          expect(directoryText.startsWith("…")).toBe(true)
          expect(directoryText.endsWith(":main")).toBe(true)
          expect(footerRow).not.toContain(version)
        } else {
          expect(footerRow).toContain("packages\\tui")
          expect(footerRow).toContain(version)
        }
      } finally {
        quit?.()
        await task
      }
    }
  } finally {
    mock.restore()
  }
})
