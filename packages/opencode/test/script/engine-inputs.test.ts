import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { assertStableInputs, snapshotBundler, snapshotRepository } from "../../script/engine-inputs"

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "opencode-engine-inputs-"))
  const files = {
    "package.json": '{"name":"fixture"}\n',
    "packages/opencode/src/main.ts": "export const main = 1\n",
    "packages/opencode/script/build.ts": "export const build = true\n",
    "bun.lock": "fixture-lock\n",
    ".github/TEAM_MEMBERS": "fixture\n",
  }
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(root, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, contents)
  }
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root })
  execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: root })
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
    {
      cwd: root,
    },
  )
  return { root, files }
}

async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

test("repository snapshots are ordered, pathless, and report missing tracked files", async () => {
  const fixture = await repository()
  try {
    const untracked = join(fixture.root, "patches", "new.patch")
    await mkdir(dirname(untracked), { recursive: true })
    await writeFile(untracked, "untracked patch")
    const first = snapshotRepository(fixture.root)
    const second = snapshotRepository(fixture.root)
    expect(first).toEqual(second)
    expect(first.files.map((file) => file.path)).toEqual([...first.files.map((file) => file.path)].sort())
    const mainFile = first.files.find((file) => file.path === "packages/opencode/src/main.ts")
    expect(mainFile?.kind).toBe("file")
    if (mainFile?.kind === "file")
      expect(mainFile).toMatchObject({
        kind: "file",
        tracked: true,
        size: Buffer.byteLength(fixture.files["packages/opencode/src/main.ts"]),
        sha256: hash(fixture.files["packages/opencode/src/main.ts"]),
      })
    expect(first.files.find((file) => file.path === "patches/new.patch")).toMatchObject({
      kind: "file",
      tracked: false,
      sha256: hash("untracked patch"),
    })
    expect(JSON.stringify(first)).not.toContain(fixture.root)

    await writeFile(join(fixture.root, "packages/opencode/src/main.ts"), "changed source")
    await rm(join(fixture.root, "packages/opencode/script/build.ts"))
    await mkdir(join(fixture.root, "script"), { recursive: true })
    await writeFile(join(fixture.root, "script", "added.ts"), "added source")
    const changed = snapshotRepository(fixture.root)
    const changedMainFile = changed.files.find((file) => file.path === "packages/opencode/src/main.ts")
    expect(changedMainFile?.kind).toBe("file")
    expect(changedMainFile?.kind === "file" ? changedMainFile.sha256 : undefined).not.toBe(
      mainFile?.kind === "file" ? mainFile.sha256 : undefined,
    )
    expect(changed.files.find((file) => file.path === "packages/opencode/script/build.ts")).toEqual({
      path: "packages/opencode/script/build.ts",
      tracked: true,
      kind: "missing",
    })
    expect(changed.files.some((file) => file.path === "script/added.ts" && !file.tracked)).toBe(true)
    let failure = ""
    try {
      assertStableInputs(first, changed, "repository source")
    } catch (error) {
      failure = String(error)
    }
    expect(failure).toContain("repository source: inputs changed")
    expect(failure).not.toContain("changed source")
  } finally {
    await cleanup(fixture.root)
  }
})

test("bundler snapshots hash real, virtual, and additional inputs and detect mutations", async () => {
  const fixture = await repository()
  const cwd = join(fixture.root, "packages", "opencode")
  try {
    const entry = join(cwd, "src", "entry.ts")
    const dependency = join(cwd, "node_modules", "fixture", "index.js")
    const plugin = join(cwd, "script", "plugin.ts")
    const internalLink = join(cwd, "internal")
    await mkdir(dirname(entry), { recursive: true })
    await mkdir(dirname(dependency), { recursive: true })
    await mkdir(dirname(plugin), { recursive: true })
    await writeFile(entry, "import 'fixture'\n")
    await writeFile(dependency, "export const dependency = true\n")
    await writeFile(plugin, "export const plugin = true\n")
    await symlink(join(cwd, "src"), internalLink, process.platform === "win32" ? "junction" : "dir")

    const virtualText = "console.log('virtual')\n"
    const virtualPath = join(cwd, "probe-worker.js")
    const virtualMetafileKey = `${"../".repeat(10)}${virtualPath.replaceAll("\\", "/")}`
    const inputs = [relative(cwd, entry), dependency, virtualMetafileKey]
    const first = snapshotBundler(fixture.root, cwd, inputs, { "probe-worker.js": virtualText }, [plugin])
    const second = snapshotBundler(fixture.root, cwd, inputs, { "probe-worker.js": virtualText }, [plugin])
    expect(first).toEqual(second)
    expect(first.inputs).toContainEqual({
      kind: "virtual",
      logicalPath: "packages/opencode/probe-worker.js",
      size: Buffer.byteLength(virtualText),
      sha256: hash(virtualText),
    })
    expect(first.inputs).toContainEqual({
      kind: "file",
      logicalPath: "packages/opencode/script/plugin.ts",
      resolvedPath: "packages/opencode/script/plugin.ts",
      size: Buffer.byteLength("export const plugin = true\n"),
      sha256: hash("export const plugin = true\n"),
      additional: true,
    })
    expect(first.inputs.every((input) => !JSON.stringify(input).includes(fixture.root))).toBe(true)
    const internalAlias = snapshotBundler(fixture.root, cwd, ["internal/entry.ts"], {}, [])
    expect(internalAlias.inputs).toContainEqual({
      kind: "file",
      logicalPath: "packages/opencode/internal/entry.ts",
      resolvedPath: "packages/opencode/src/entry.ts",
      size: Buffer.byteLength("import 'fixture'\n"),
      sha256: hash("import 'fixture'\n"),
    })

    await writeFile(dependency, "export const dependency = false\n")
    const realChanged = snapshotBundler(fixture.root, cwd, inputs, { "probe-worker.js": virtualText }, [plugin])
    expect(() => assertStableInputs(first, realChanged, "bundler inputs")).toThrow("bundler inputs: inputs changed")

    const virtualChanged = snapshotBundler(fixture.root, cwd, inputs, { "probe-worker.js": "changed virtual" }, [
      plugin,
    ])
    expect(() => assertStableInputs(first, virtualChanged, "bundler inputs")).toThrow("bundler inputs: inputs changed")

    const added = join(cwd, "src", "extra.ts")
    await writeFile(added, "export const extra = 1\n")
    const inputSetChanged = snapshotBundler(
      fixture.root,
      cwd,
      [...inputs, "src/extra.ts"],
      { "probe-worker.js": virtualText },
      [plugin],
    )
    expect(() => assertStableInputs(first, inputSetChanged, "bundler inputs")).toThrow("bundler inputs: inputs changed")

    const virtualInputRemoved = snapshotBundler(
      fixture.root,
      cwd,
      inputs.filter((input) => input !== virtualMetafileKey),
      { "probe-worker.js": virtualText },
      [plugin],
    )
    expect(() => assertStableInputs(first, virtualInputRemoved, "bundler inputs")).toThrow(
      "bundler inputs: inputs changed",
    )

    const withPluginInput = [...inputs, plugin]
    const additionalInputRemoved = snapshotBundler(
      fixture.root,
      cwd,
      withPluginInput,
      { "probe-worker.js": virtualText },
      [plugin],
    )
    const actualWithoutPlugin = snapshotBundler(fixture.root, cwd, inputs, { "probe-worker.js": virtualText }, [plugin])
    expect(() => assertStableInputs(additionalInputRemoved, actualWithoutPlugin, "bundler inputs")).toThrow(
      "bundler inputs: inputs changed",
    )
  } finally {
    await cleanup(fixture.root)
  }
})

test("bundler snapshots reject symlinks outside root and unsupported namespaces", async () => {
  const fixture = await repository()
  const cwd = join(fixture.root, "packages", "opencode")
  const externalRoot = await mkdtemp(join(tmpdir(), "opencode-engine-inputs-external-"))
  try {
    const outsideFile = join(externalRoot, "secret.ts")
    await writeFile(outsideFile, "outside workspace")
    const linkedDirectory = join(cwd, "external")
    await symlink(externalRoot, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
    expect(() => snapshotBundler(fixture.root, cwd, ["external/secret.ts"], {}, [])).toThrow(
      /outside the repository|symbolic link or reparse point/,
    )
    expect(() => snapshotBundler(fixture.root, cwd, ["node:fs"], {}, [])).toThrow(
      /unsupported bundler input namespace/i,
    )
    expect(() => snapshotBundler(fixture.root, cwd, [outsideFile], {}, [])).toThrow("outside the repository")
  } finally {
    await cleanup(fixture.root)
    await cleanup(externalRoot)
  }
})

test("bundler snapshots reject inventories above the input count cap", async () => {
  const fixture = await repository()
  const cwd = join(fixture.root, "packages", "opencode")
  try {
    const virtual = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`worker-${index}.js`, ""]))
    expect(() => snapshotBundler(fixture.root, cwd, Object.keys(virtual), virtual)).toThrow(
      "Bundler input inventory exceeds 20000 files.",
    )
  } finally {
    await cleanup(fixture.root)
  }
})

test("stable input comparison ignores object-key order and reports only the label", () => {
  expect(() => assertStableInputs({ b: 2, a: 1 }, { a: 1, b: 2 }, "snapshot")).not.toThrow()
  expect(() => assertStableInputs({ hash: "secret-content" }, { hash: "other-content" }, "engine build")).toThrow(
    "engine build: inputs changed",
  )
})
