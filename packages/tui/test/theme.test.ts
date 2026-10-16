import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TerminalColors } from "@opentui/core"
import { DEFAULT_THEMES, addTheme, allThemes, hasTheme, resolveTheme, terminalMode } from "../src/theme"
import { discoverThemes, themeDirectories } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

test("distribution themes load from external cwd below user and project themes", async () => {
  await using tmp = await tmpdir()
  const defaults = path.join(tmp.path, "defaults")
  const project = path.join(tmp.path, "project")
  const user = path.join(tmp.path, "user")
  for (const dir of [defaults, user, path.join(project, ".opencode")])
    await mkdir(path.join(dir, "themes"), { recursive: true })
  await writeFile(path.join(defaults, "themes/shared.json"), JSON.stringify({ source: "packaged" }))
  await writeFile(path.join(defaults, "themes/only-packaged.json"), JSON.stringify({ source: "packaged" }))
  await writeFile(path.join(user, "themes/shared.json"), JSON.stringify({ source: "user" }))
  await writeFile(path.join(project, ".opencode/themes/shared.json"), JSON.stringify({ source: "project" }))
  const previous = process.env.CUDIA_DISTRIBUTION_DIR
  process.env.CUDIA_DISTRIBUTION_DIR = defaults
  try {
    const directories = await themeDirectories(project)
    expect(directories[0]).toBe(defaults)
    expect((await discoverThemes([directories[0], user])).shared).toEqual({ source: "user" })
    const themes = await discoverThemes([directories[0], user, directories[2]])
    expect(themes.shared).toEqual({ source: "project" })
    expect(themes["only-packaged"]).toEqual({ source: "packaged" })
  } finally {
    if (previous === undefined) delete process.env.CUDIA_DISTRIBUTION_DIR
    else process.env.CUDIA_DISTRIBUTION_DIR = previous
  }
})

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.opencode)
  const two = structuredClone(DEFAULT_THEMES.opencode)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.opencode)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
