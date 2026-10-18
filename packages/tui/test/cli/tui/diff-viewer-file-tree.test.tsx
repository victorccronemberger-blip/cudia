/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount, type JSX } from "solid-js"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { DiffViewerFileTree } from "../../../src/feature-plugins/system/diff-viewer-file-tree"
import { TestTuiContexts } from "../../fixture/tui-environment"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
} from "../../../src/feature-plugins/system/diff-viewer-file-tree-utils"

const theme = {
  background: RGBA.fromHex("#000000"),
  backgroundPanel: RGBA.fromHex("#111111"),
  backgroundElement: RGBA.fromHex("#333333"),
  primary: RGBA.fromHex("#00ffff"),
  secondary: RGBA.fromHex("#0088ff"),
  selectedListItemText: RGBA.fromHex("#ffffff"),
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
}

describe("DiffViewerFileTree", () => {
  test.skip("renders sorted hierarchical file rows", async () => {
    const lines = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree
          width={32}
          files={[
            { file: "z-file.ts" },
            { file: "b/file.ts" },
            { file: "a/zeta.ts" },
            { file: "b/alpha.ts" },
            { file: "a/alpha.ts" },
          ]}
          loading={false}
          error={undefined}
          theme={theme}
          focused
        />
      )),
    )

    expect(lines).toEqual([
      "▾ a",
      "│  ├─ alpha.ts               ?",
      "│  └─ zeta.ts                ?",
      "├─ ▾ b",
      "│  ├─ alpha.ts               ?",
      "│  └─ file.ts                ?",
    ])
  })

  test("keeps loading and error quiet while rendering an empty settled state", async () => {
    const loading = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={true} error={undefined} theme={theme} />
    ))
    const failed = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={new Error("nope")} theme={theme} />
    ))
    const empty = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={undefined} theme={theme} />
    ))

    expect(loading).not.toContain("Loading diff…")
    expect(loading).not.toContain("No files")
    expect(failed).not.toContain("Failed to load diff")
    expect(failed).not.toContain("No files")
    expect(empty).toContain("No files")
  })

  test("does not render text markers for highlighted rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const src = buildFileTree(files).nodes.find((node) => node.kind === "directory" && node.name === "src")!

    const focused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree
          width={32}
          files={files}
          loading={false}
          error={undefined}
          theme={theme}
          focused
          highlightedNode={src.id}
        />
      )),
    )
    const unfocused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree width={32} files={files} loading={false} error={undefined} theme={theme} />
      )),
    )

    expect(focused).toContain("▾ src/config")
    expect(unfocused).toContain("▾ src/config")
    expect(focused.some((line) => line.includes("*"))).toBe(false)
    expect(unfocused.some((line) => line.includes("*"))).toBe(false)
  })

  test("renders collapsed and expanded directory rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const tree = buildFileTree(files)
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const collapsed = allExpandedFileTreeDirectories(tree)
    collapsed.delete(src.id)

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            width={32}
            files={files}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={collapsed}
          />
        )),
      ),
    ).toEqual(["▸ src/config"])

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            files={files}
            width={32}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={allExpandedFileTreeDirectories(tree)}
          />
        )),
      ),
    ).toEqual(["▾ src/config", "│  └─ tui.ts                 ?"])
  })
})

async function renderFrame(component: () => JSX.Element) {
  const state = await mkdtemp(path.join(tmpdir(), "tui-diff-viewer-"))
  await writeFile(path.join(state, "kv.json"), "{}")
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => (resolveReady = resolve))
  const app = await testRender(() => withTheme(component, resolveReady, state), { width: 40, height: 10 })
  try {
    await ready
    await app.flush()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
    await rm(state, { recursive: true, force: true })
  }
}

function withTheme(component: () => JSX.Element, onReady: () => void, state: string) {
  return (
    <TestTuiContexts paths={{ state }}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            <ThemeReady onReady={onReady} />
            {component()}
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function ThemeReady(props: { onReady: () => void }) {
  onMount(props.onReady)
  return null
}

function visibleLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) => line.replace(/^ ?│ ?/, "").replace(/[ │]*$/, ""))
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
    .filter((line) => line.length > 0 && !/^┌|^└|^─+$/.test(line))
}
