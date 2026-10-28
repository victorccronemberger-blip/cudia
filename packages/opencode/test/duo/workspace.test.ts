import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { prepare } from "../../src/duo/workspace"
import { tmpdir } from "../fixture/fixture"

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

describe("DuoWorkspace.prepare", () => {
  test("copies one captured dirty snapshot into two independent detached worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const nested = path.join(tmp.path, "pasta com espaço café")
    await fs.mkdir(nested)
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "before\n")
    await fs.writeFile(path.join(tmp.path, "staged.txt"), "before staged\n")
    await fs.writeFile(path.join(nested, "tracked-inside.txt"), "nested before\n")
    await git(tmp.path, "add", "tracked.txt", "staged.txt", "pasta com espaço café/tracked-inside.txt")
    await git(tmp.path, "commit", "-m", "tracked files")
    const baseCommit = await git(tmp.path, "rev-parse", "HEAD")
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "dirty unstaged\n")
    await fs.writeFile(path.join(tmp.path, "staged.txt"), "dirty staged\n")
    await fs.writeFile(path.join(nested, "tracked-inside.txt"), "dirty nested\n")
    await git(tmp.path, "add", "staged.txt")
    await fs.writeFile(path.join(tmp.path, "untracked space café.txt"), "new bytes\n")
    const originalStatus = await git(tmp.path, "status", "--porcelain=v1", "-z")

    const result = await Effect.runPromise(prepare({ directory: nested, runID: ids[0] }))
    try {
      expect(result.schedule).toBe("parallel")
      expect(result.baseCommit).toBe(baseCommit)
      expect(result.baseDirectory).toBe(tmp.path)
      expect(await fs.readFile(path.resolve(result.directories[0], "..", "tracked.txt"), "utf8")).toBe(
        "dirty unstaged\n",
      )
      expect(await fs.readFile(path.resolve(result.directories[0], "..", "staged.txt"), "utf8")).toBe("dirty staged\n")
      expect(await fs.readFile(path.join(result.directories[0], "tracked-inside.txt"), "utf8")).toBe("dirty nested\n")
      expect(await fs.readFile(path.resolve(result.directories[0], "..", "untracked space café.txt"), "utf8")).toBe(
        "new bytes\n",
      )
      expect(await fs.readFile(path.join(result.directories[1], "tracked-inside.txt"), "utf8")).toBe("dirty nested\n")
      await fs.writeFile(path.join(result.directories[0], "independent.txt"), "only A")
      await fs.writeFile(path.join(result.directories[1], "independent.txt"), "only B")
      expect(await fs.readFile(path.join(result.directories[0], "independent.txt"), "utf8")).toBe("only A")
      expect(await fs.readFile(path.join(result.directories[1], "independent.txt"), "utf8")).toBe("only B")
      expect(await git(tmp.path, "rev-parse", "HEAD")).toBe(baseCommit)
      expect(await git(tmp.path, "status", "--porcelain=v1", "-z")).toBe(originalStatus)
      expect(path.resolve(await git(result.directories[0], "rev-parse", "--show-toplevel"))).toBe(
        path.resolve(result.directories[0], ".."),
      )
    } finally {
      await cleanup(tmp.path, ids[0])
    }
  })

  test("uses sequential scheduling outside Git", async () => {
    await using tmp = await tmpdir()
    const result = await Effect.runPromise(prepare({ directory: tmp.path, runID: ids[1] }))
    expect(result.schedule).toBe("sequential")
    expect(result.directories).toEqual([tmp.path, tmp.path])
    expect(result.reason).toContain("not inside a Git repository")
  })

  test("falls back before creating worktrees when the snapshot exceeds its budget", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "large.bin"), "x".repeat(4096))
    const result = await Effect.runPromise(prepare({ directory: tmp.path, runID: ids[1], maxSnapshotBytes: 128 }))
    expect(result.schedule).toBe("sequential")
    expect(result.reason).toContain("snapshot limit")
    expect(
      await fs
        .stat(path.join(Global.Path.data, "duo-workspaces", ids[1]))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    expect(await fs.readFile(path.join(tmp.path, "large.bin"), "utf8")).toBe("x".repeat(4096))
  })
})

async function cleanup(repo: string, runID: string) {
  for (const directory of ["a", "b"].map((name) => path.join(Global.Path.data, "duo-workspaces", runID, name))) {
    await git(repo, "worktree", "remove", "--force", directory).catch(() => undefined)
  }
  await fs.rm(path.join(Global.Path.data, "duo-workspaces", runID), { recursive: true, force: true })
  await git(repo, "worktree", "prune").catch(() => undefined)
}
