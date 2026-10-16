import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { FileStatus, Info } from "@opencode-ai/schema/vcs"
import { Vcs } from "@opencode-ai/core/vcs"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { parseNumstat, parseStatus, run } from "../src/vcs/readonly"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Vcs test",
      "-c",
      "user.email=vcs@example.invalid",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

function service<A, E>(directory: string, body: (vcs: Vcs.Interface) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const vcs = yield* Vcs.Service
      return yield* body(vcs)
    }).pipe(
      Effect.provide(
        LayerNode.compile(Vcs.node, [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
        ]),
      ),
    ),
  )
}

async function fixture() {
  const tmp = await tmpdir()
  await git(tmp.path, "init", "-b", "main")
  return tmp
}

async function write(directory: string, file: string, content: string | Uint8Array) {
  await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
  await fs.writeFile(path.join(directory, file), content)
}

async function commit(directory: string) {
  await git(directory, "add", "--all")
  await git(directory, "commit", "-m", "fixture")
}

describe("native read-only VCS", () => {
  test("facade uses canonical contracts and optional wire properties omit undefined", () => {
    expect(Vcs.FileStatus).toBe(FileStatus)
    expect(Vcs.Info).toBe(Info)
    expect(Schema.encodeSync(Info)({ branch: undefined, defaultBranch: undefined })).toEqual({})
  })
  test("NUL parsers retain Unicode, tabs/newlines, binary records and deletions", () => {
    expect(parseStatus("A\0-x\0D\0tab\tline\n雪\0")).toEqual([
      { file: "-x", status: "added" },
      { file: "tab\tline\n雪", status: "deleted" },
    ])
    expect(parseNumstat("-\t-\tbinary.bin\0")).toEqual(new Map([["binary.bin", { additions: 0, deletions: 0 }]]))
    expect(parseNumstat("2\t0\t\0/dev/null\0tab\tline\n雪\0").get("tab\tline\n雪")).toEqual({
      additions: 2,
      deletions: 0,
    })
    expect(() => parseNumstat("1\t0\t\0/dev/null\0")).toThrow()
    expect(() => parseStatus("A\0incomplete")).toThrow()
  })

  test("working changes include staged, unstaged, mixed, untracked, deleted, binary; preserve the index", async () => {
    await using tmp = await fixture()
    for (const file of ["staged.txt", "unstaged.txt", "mixed.txt", "deleted.txt"]) await write(tmp.path, file, "one\n")
    await write(tmp.path, "binary.bin", new Uint8Array([0, 1]))
    await commit(tmp.path)
    await write(tmp.path, "staged.txt", "one\ntwo\n")
    await write(tmp.path, "mixed.txt", "one\ntwo\n")
    await git(tmp.path, "add", "staged.txt", "mixed.txt")
    await write(tmp.path, "mixed.txt", "one\ntwo\nthree\n")
    await write(tmp.path, "unstaged.txt", "replacement\n")
    await fs.unlink(path.join(tmp.path, "deleted.txt"))
    await write(tmp.path, "binary.bin", new Uint8Array([0, 2, 3]))
    for (const file of ["-leading.txt", "space 雪.txt"]) await write(tmp.path, file, "new\nfile\n")
    const index = await fs.readFile(path.join(tmp.path, ".git", "index"))
    const staged = await git(tmp.path, "diff", "--cached", "--binary")
    const data = await service(tmp.path, (vcs) => vcs.diff("working", { context: 3 }))
    expect(data.map((item) => String(item.file)).sort()).toEqual(
      ["staged.txt", "unstaged.txt", "mixed.txt", "deleted.txt", "binary.bin", "-leading.txt", "space 雪.txt"].sort(),
    )
    expect(data.find((item) => item.file === "mixed.txt")).toMatchObject({
      additions: 2,
      deletions: 0,
      status: "modified",
    })
    expect(data.find((item) => item.file === "deleted.txt")).toMatchObject({
      additions: 0,
      deletions: 1,
      status: "deleted",
    })
    expect(data.find((item) => item.file === "binary.bin")).toMatchObject({ additions: 0, deletions: 0 })
    expect(data.find((item) => item.file === "-leading.txt")).toMatchObject({
      additions: 2,
      deletions: 0,
      status: "added",
    })
    expect(data.find((item) => item.file === "space 雪.txt")?.patch).toContain("+new")
    expect(await service(tmp.path, (vcs) => vcs.status())).toEqual(data.map(({ patch, ...item }) => item))
    expect(await fs.readFile(path.join(tmp.path, ".git", "index"))).toEqual(index)
    expect(await git(tmp.path, "diff", "--cached", "--binary")).toBe(staged)
  })

  test("unborn staged and untracked files have real patches and stats", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "staged.txt", "staged\n")
    await git(tmp.path, "add", "staged.txt")
    await write(tmp.path, "untracked.txt", "first\nsecond\n")
    const data = await service(tmp.path, (vcs) => vcs.diff("working"))
    expect(data).toHaveLength(2)
    expect(data.find((item) => item.file === "staged.txt")).toMatchObject({
      additions: 1,
      deletions: 0,
      status: "added",
    })
    expect(data.find((item) => item.file === "untracked.txt")?.patch).toContain("+second")
    await fs.unlink(path.join(tmp.path, "staged.txt"))
    expect((await service(tmp.path, (vcs) => vcs.status())).map((item) => String(item.file))).toEqual(["untracked.txt"])
  })

  test("staged deletion followed by an untracked replacement compares actual content with HEAD", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "file.txt", "original\n")
    await commit(tmp.path)
    await git(tmp.path, "rm", "file.txt")
    await write(tmp.path, "file.txt", "replacement\n")
    const data = await service(tmp.path, (vcs) => vcs.diff("working"))
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ status: "modified", additions: 1, deletions: 1 })
    expect(data[0]?.patch).toContain("-original")
    expect(data[0]?.patch).toContain("+replacement")
    await write(tmp.path, "file.txt", "original\n")
    expect(await service(tmp.path, (vcs) => vcs.diff("working"))).toEqual([])
  })

  test("subdirectory scope and linked worktrees return Location-relative paths", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "inside/file.txt", "one\n")
    await write(tmp.path, "outside.txt", "outside\n")
    await commit(tmp.path)
    const linked = path.join(tmp.path, "linked")
    await git(tmp.path, "worktree", "add", "--detach", linked, "HEAD")
    await write(linked, "inside/file.txt", "one\ntwo\n")
    await write(linked, "outside.txt", "changed\n")
    await write(linked, "inside/new.txt", "new\n")
    const data = await service(path.join(linked, "inside"), (vcs) => vcs.diff("working"))
    expect(data.map((item) => String(item.file))).toEqual(["file.txt", "new.txt"])
    for (const item of data) expect(await fs.readFile(path.join(linked, "inside", item.file), "utf8")).toContain("\n")
  })

  test("branch diff uses merge-base, default selection and same-default semantics", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "file.txt", "base\n")
    await commit(tmp.path)
    expect(await service(tmp.path, (vcs) => vcs.info())).toEqual({ branch: "main", defaultBranch: "main" })
    await write(tmp.path, "file.txt", "working\n")
    expect(await service(tmp.path, (vcs) => vcs.diff("branch"))).toEqual([])
    await git(tmp.path, "checkout", "-b", "feature")
    await write(tmp.path, "feature.txt", "feature\n")
    await commit(tmp.path)
    await git(tmp.path, "checkout", "main")
    await write(tmp.path, "main.txt", "main\n")
    await commit(tmp.path)
    await git(tmp.path, "checkout", "feature")
    const data = await service(tmp.path, (vcs) => vcs.diff("branch"))
    expect(data.map((item) => String(item.file)).sort()).toEqual(["feature.txt", "file.txt"])
    await git(tmp.path, "branch", "-D", "main")
    expect(await service(tmp.path, (vcs) => vcs.diff("branch").pipe(Effect.flip))).toMatchObject({
      reason: "unavailable",
    })
  })

  test("non-Git is empty, broken Git and unrelated histories are explicit failures", async () => {
    await using plain = await tmpdir()
    expect(await service(plain.path, (vcs) => vcs.status())).toEqual([])
    await write(plain.path, ".git", "gitdir: missing-repository\n")
    expect(await service(plain.path, (vcs) => vcs.status().pipe(Effect.flip))).toMatchObject({ reason: "command" })
    await using tmp = await fixture()
    await write(tmp.path, "main.txt", "main\n")
    await commit(tmp.path)
    await git(tmp.path, "checkout", "--orphan", "unrelated")
    await write(tmp.path, "new.txt", "new\n")
    await commit(tmp.path)
    expect(await service(tmp.path, (vcs) => vcs.diff("branch").pipe(Effect.flip))).toMatchObject({
      reason: "unavailable",
    })
  })

  test("configured external diff, textconv, fsmonitor, clean and process filters never run", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "file.txt", "one\n")
    await write(tmp.path, ".gitattributes", "*.txt filter=trap diff=trap\n")
    await commit(tmp.path)
    const sentinel = path.join(tmp.path, "sentinel").replaceAll("\\", "/")
    const command = `echo invoked >> '${sentinel}'; cat`
    for (const key of [
      "diff.external",
      "diff.trap.command",
      "diff.trap.textconv",
      "filter.trap.clean",
      "filter.trap.process",
      "core.fsmonitor",
    ])
      await git(tmp.path, "config", key, command)
    await git(tmp.path, "config", "filter.trap.required", "true")
    await write(tmp.path, "file.txt", "two\n")
    expect((await service(tmp.path, (vcs) => vcs.diff("working")))[0]?.patch).toContain("+two")
    expect(await fs.exists(sentinel)).toBe(false)
  })

  test("invalid context, output budgets and cancellation return typed failures", async () => {
    await using tmp = await fixture()
    expect(await service(tmp.path, (vcs) => vcs.diff("working", { context: NaN }).pipe(Effect.flip))).toMatchObject({
      reason: "invalid_input",
    })
    const layer = LayerNode.compile(AppProcess.node)
    const limited = await Effect.runPromise(
      Effect.gen(function* () {
        const proc = yield* AppProcess.Service
        return yield* run(proc, tmp.path, ["--version"], { limit: 1 }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )
    expect(limited).toMatchObject({ reason: "output_limit", limit: 1 })
    const controller = new AbortController()
    controller.abort(new Error("test cancellation"))
    const cancelled = await Effect.runPromise(
      Effect.gen(function* () {
        const proc = yield* AppProcess.Service
        return yield* run(proc, tmp.path, ["--version"], { signal: controller.signal }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )
    expect(cancelled).toMatchObject({ reason: "command", message: "test cancellation" })
  })

  test("active cancellation closes the scoped Git process promptly", async () => {
    await using tmp = await fixture()
    const marker = path.join(tmp.path, "started").replaceAll("\\", "/")
    const controller = new AbortController()
    const pending = Effect.runPromise(
      Effect.gen(function* () {
        const proc = yield* AppProcess.Service
        return yield* run(proc, tmp.path, ["-c", `alias.wait=!echo started > '${marker}'; sleep 30`, "wait"], {
          signal: controller.signal,
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(LayerNode.compile(AppProcess.node))),
    )
    const deadline = Date.now() + 3_000
    while (!(await fs.exists(marker)) && Date.now() < deadline) await Bun.sleep(10)
    expect(await fs.exists(marker)).toBe(true)
    const start = Date.now()
    controller.abort(new Error("active cancellation"))
    expect(await pending).toMatchObject({ reason: "command", message: "active cancellation" })
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test("aggregate patch limit fails explicitly without partial successful data", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "first.txt", "x".repeat(5_100_000) + "\n")
    await write(tmp.path, "second.txt", "y".repeat(5_100_000) + "\n")
    const result = await service(tmp.path, (vcs) => vcs.diff("working", { context: 0 }).pipe(Effect.flip))
    expect(result).toMatchObject({ reason: "output_limit" })
    expect(result.limit).toBeGreaterThan(0)
    expect(result.limit).toBeLessThan(5_000_000)
  })

  test("configured and remote HEAD defaults resolve existing refs", async () => {
    await using tmp = await fixture()
    await write(tmp.path, "file.txt", "base\n")
    await commit(tmp.path)
    await git(tmp.path, "branch", "-m", "dev")
    await git(tmp.path, "config", "init.defaultBranch", "dev")
    expect(await service(tmp.path, (vcs) => vcs.info())).toEqual({ branch: "dev", defaultBranch: "dev" })
    await git(tmp.path, "update-ref", "refs/remotes/origin/trunk", "HEAD")
    await git(tmp.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    expect(await service(tmp.path, (vcs) => vcs.info())).toEqual({ branch: "dev", defaultBranch: "trunk" })
  })

  test("submodule changes retain gitlink paths and do not recurse into their files", async () => {
    await using source = await fixture()
    await write(source.path, "file.txt", "one\n")
    await commit(source.path)
    await using tmp = await fixture()
    await git(tmp.path, "-c", "protocol.file.allow=always", "submodule", "add", source.path, "module")
    const unborn = await service(tmp.path, (vcs) => vcs.diff("working"))
    expect(unborn.find((item) => item.file === "module")?.patch).toContain("Subproject commit")
    await commit(tmp.path)
    await write(path.join(tmp.path, "module"), "file.txt", "two\n")
    const data = await service(tmp.path, (vcs) => vcs.diff("working"))
    expect(data.map((item) => String(item.file))).toEqual(["module"])
    expect(data[0]?.patch).toContain("Subproject commit")
  })

  test("escaping directory symlinks fail before working content is compared", async () => {
    await using outside = await tmpdir()
    await write(outside.path, "file.txt", "outside secret\n")
    await using tmp = await fixture()
    await write(tmp.path, "nested/file.txt", "inside\n")
    await commit(tmp.path)
    const nested = path.resolve(tmp.path, "nested")
    expect(nested.startsWith(tmp.path + path.sep)).toBe(true)
    await fs.rm(nested, { recursive: true })
    await fs.symlink(outside.path, path.join(tmp.path, "nested"), process.platform === "win32" ? "junction" : "dir")
    const result = await service(tmp.path, (vcs) => vcs.diff("working").pipe(Effect.flip))
    expect(result).toMatchObject({ reason: "command" })
    expect(result.message).toContain("symlink outside")
  })

  test.skipIf(process.platform === "win32")("POSIX unusual filenames and symlinks remain literal", async () => {
    await using tmp = await fixture()
    for (const file of ["tab\tname", "line\nname", "back\\slash", ":(glob)magic"]) await write(tmp.path, file, "one\n")
    await fs.symlink("missing-outside", path.join(tmp.path, "tracked-link"))
    await commit(tmp.path)
    for (const file of ["tab\tname", "line\nname", "back\\slash", ":(glob)magic"]) await write(tmp.path, file, "two\n")
    await fs.unlink(path.join(tmp.path, "tracked-link"))
    await fs.symlink("different-outside", path.join(tmp.path, "tracked-link"))
    await fs.symlink("missing-outside", path.join(tmp.path, "untracked-link"))
    const data = await service(tmp.path, (vcs) => vcs.diff("working"))
    expect(data.map((item) => String(item.file)).sort()).toEqual(
      ["tab\tname", "line\nname", "back\\slash", ":(glob)magic", "tracked-link"].sort(),
    )
    expect(data.find((item) => item.file === "tracked-link")?.patch).toContain("+different-outside")
  })
})
