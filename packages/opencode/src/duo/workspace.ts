import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"

export type Prepared = {
  schedule: "parallel" | "sequential"
  directories: [string, string]
  baseDirectory: string
  baseCommit?: string
  reason?: string
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function prepare(input: {
  directory: string
  runID: string
  maxSnapshotBytes?: number
}): Effect.Effect<Prepared> {
  return Effect.tryPromise({
    try: () => prepareWorkspace(input),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        schedule: "parallel" as const,
        directories: [path.resolve(input.directory), path.resolve(input.directory)] as [string, string],
        baseDirectory: path.resolve(input.directory),
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
  )
}

async function prepareWorkspace(input: {
  directory: string
  runID: string
  maxSnapshotBytes?: number
}): Promise<Prepared> {
  const original = path.resolve(input.directory)
  const invocationDirectory = await fs.realpath(original)
  const fallback = (reason: string, baseDirectory = invocationDirectory): Prepared => ({
    schedule: "parallel",
    directories: [invocationDirectory, invocationDirectory],
    baseDirectory,
    reason,
  })
  if (!UUID.test(input.runID)) return fallback("Duo run ID must be a UUID")
  const root = invocationDirectory
  const git = (args: string[], cwd = root, stdin?: Uint8Array) =>
    runGit(args, cwd, input.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES, stdin)
  const top = await git(["rev-parse", "--show-toplevel"])
  if (top.code !== 0) return fallback("The current directory is not inside a Git repository", root)
  const baseDirectory = await fs.realpath(top.text.trim())
  const relative = path.relative(baseDirectory, invocationDirectory)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return fallback("The invocation directory is outside the Git repository", baseDirectory)
  }
  const head = await git(["rev-parse", "--verify", "HEAD"], baseDirectory)
  if (head.code !== 0) return fallback("The Git repository has no commit yet", baseDirectory)
  const baseCommit = head.text.trim()
  const maxBytes = input.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
  const patch = await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", baseCommit], baseDirectory)
  if (patch.overflow) return fallback(`Working changes exceed the ${maxBytes}-byte snapshot limit`, baseDirectory)
  if (patch.code !== 0) return fallback("Could not capture tracked working changes", baseDirectory)
  const names = await git(["ls-files", "--others", "--exclude-standard", "-z"], baseDirectory)
  if (names.overflow) return fallback(`Working changes exceed the ${maxBytes}-byte snapshot limit`, baseDirectory)
  if (names.code !== 0) return fallback("Could not list untracked files", baseDirectory)
  const files: Array<{ relative: string; bytes: Uint8Array }> = []
  let size = patch.bytes.byteLength
  for (const relative of names.text.split("\0").filter(Boolean)) {
    const source = path.resolve(baseDirectory, relative)
    if (source !== baseDirectory && !source.startsWith(baseDirectory + path.sep)) {
      return fallback("An untracked path escapes the Git repository", baseDirectory)
    }
    const stat = await fs.lstat(source)
    if (!stat.isFile()) return fallback(`Cannot snapshot untracked non-file: ${relative}`, baseDirectory)
    size += stat.size
    if (size > maxBytes) return fallback(`Working changes exceed the ${maxBytes}-byte snapshot limit`, baseDirectory)
    files.push({ relative, bytes: await fs.readFile(source) })
  }

  const workspaceRoot = path.resolve(Global.Path.data, "duo-workspaces")
  const runRoot = path.resolve(workspaceRoot, input.runID)
  if (!runRoot.startsWith(workspaceRoot + path.sep)) return fallback("Invalid Duo workspace path", baseDirectory)
  await fs.mkdir(workspaceRoot, { recursive: true })
  try {
    await fs.mkdir(runRoot)
  } catch {
    return fallback("Duo workspace directory already exists", baseDirectory)
  }
  const worktrees: [string, string] = [path.join(runRoot, "a"), path.join(runRoot, "b")]
  for (const directory of worktrees) {
    const created = await git(["worktree", "add", "--detach", directory, baseCommit], baseDirectory)
    if (created.code !== 0) return fallback(created.stderr || "Could not create isolated Git worktree", baseDirectory)
    if (patch.bytes.byteLength) {
      const applied = await git(["apply", "--binary", "--"], directory, patch.bytes)
      if (applied.code !== 0)
        return fallback(applied.stderr || "Could not apply captured working changes", baseDirectory)
    }
    for (const file of files) {
      const destination = path.resolve(directory, file.relative)
      if (destination !== directory && !destination.startsWith(directory + path.sep)) {
        return fallback("An untracked path escapes the Duo worktree", baseDirectory)
      }
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, file.bytes, { flag: "wx" })
    }
  }
  return {
    schedule: "parallel",
    directories: worktrees.map((directory) => path.resolve(directory, relative)) as [string, string],
    baseDirectory,
    baseCommit,
  }
}

async function runGit(args: string[], cwd: string, maxBytes: number, stdin?: Uint8Array) {
  const child = Bun.spawn(["git", "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    stdin: stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  })
  if (stdin) {
    child.stdin!.write(stdin)
    child.stdin!.end()
  }
  const read = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        child.kill()
        return { bytes: new Uint8Array(), overflow: true }
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, overflow: false }
  }
  const [stdout, stderr] = await Promise.all([read(child.stdout, maxBytes), read(child.stderr, 16_384)])
  const code = await child.exited
  return {
    code,
    bytes: stdout.bytes,
    text: new TextDecoder().decode(stdout.bytes),
    stderr: new TextDecoder().decode(stderr.bytes),
    overflow: stdout.overflow,
  }
}

export * as DuoWorkspace from "./workspace"
