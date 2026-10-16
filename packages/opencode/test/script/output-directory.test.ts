import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import { prepareOutputDirectory, resolveOutputDirectory } from "../../script/output-directory"

test("build output stays in a named artifact directory", () => {
  const root = path.resolve("package")
  expect(resolveOutputDirectory(root)).toBe(path.join(root, "dist"))
  expect(resolveOutputDirectory(root, "dist-preview")).toBe(path.join(root, "dist-preview"))
  for (const invalid of [".", "..", "src", "dist-../src", "../dist", "dist/child", "dist-"]) {
    expect(() => resolveOutputDirectory(root, invalid)).toThrow()
  }
})

test("cleans only the selected artifact directory and rejects a linked output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cudia-output-"))
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("cudia-output-"))
    throw new Error("Unexpected temporary output directory")
  try {
    await mkdir(path.join(root, "dist"))
    await writeFile(path.join(root, "dist", "active.exe"), "keep")
    await mkdir(path.join(root, "dist-preview"))
    await writeFile(path.join(root, "dist-preview", "old.exe"), "replace")
    expect(await prepareOutputDirectory(root, "dist-preview")).toBe(path.join(root, "dist-preview"))
    expect(await readFile(path.join(root, "dist", "active.exe"), "utf8")).toBe("keep")
    await symlink(
      path.join(root, "dist"),
      path.join(root, "dist-linked"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await expect(prepareOutputDirectory(root, "dist-linked")).rejects.toThrow("symbolic link")
    expect(await readFile(path.join(root, "dist", "active.exe"), "utf8")).toBe("keep")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
