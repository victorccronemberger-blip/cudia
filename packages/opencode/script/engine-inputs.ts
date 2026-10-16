import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

const maxInputs = 20_000
const maxInventoryBytes = 4 * 1024 * 1024
const repositoryPaths = [
  "packages",
  "patches",
  "script",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  ".github/TEAM_MEMBERS",
]

export type RepositorySnapshot = {
  schema: 1
  head: string
  files: Array<
    | { path: string; tracked: true; kind: "missing" }
    | { path: string; tracked: boolean; kind: "file"; size: number; sha256: string }
  >
}

export type BundlerSnapshot = {
  schema: 1
  cwd: string
  metafileInputs: Array<{ kind: "virtual" | "file"; logicalPath: string }>
  inputs: Array<
    | { kind: "virtual"; logicalPath: string; size: number; sha256: string }
    | { kind: "file"; logicalPath: string; resolvedPath: string; size: number; sha256: string; additional?: true }
  >
}

export function snapshotRepository(root: string): RepositorySnapshot {
  const rootPath = realpathSync(resolve(root))
  const head = git(rootPath, ["rev-parse", "HEAD"]).trim()
  if (!head) throw new Error("Repository HEAD is unavailable.")
  const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...repositoryPaths]
  const listed = git(rootPath, args)
  const tracked = new Set(
    git(rootPath, ["ls-files", "--cached", "-z", "--", ...repositoryPaths])
      .split("\0")
      .filter(Boolean),
  )
  const paths = [...new Set(listed.split("\0").filter(Boolean))].sort(compareText)
  if (paths.length > maxInputs) throw new Error(`Repository input inventory exceeds ${maxInputs} files.`)

  const files = paths.map((path) => {
    const file = readRepositoryFile(rootPath, path, true)
    if (file.kind === "missing") {
      if (!tracked.has(path)) throw new Error("An untracked repository input disappeared during snapshot.")
      return { path, tracked: true as const, kind: "missing" as const }
    }
    return { path, tracked: tracked.has(path), kind: "file" as const, size: file.size, sha256: file.sha256 }
  })
  const snapshot: RepositorySnapshot = { schema: 1, head, files }
  assertInventorySize(snapshot)
  return snapshot
}

export function snapshotBundler(
  root: string,
  cwd: string,
  inputs: string[],
  virtual: Record<string, string>,
  additional: string[] = [],
): BundlerSnapshot {
  const rootPath = realpathSync(resolve(root))
  const workingDirectory = realpathSync(resolve(cwd))
  const cwdPath = relativeRoot(rootPath, workingDirectory, "Bundler working directory")
  const records = new Map<string, BundlerSnapshot["inputs"][number]>()
  const metafileInputs = new Map<string, { kind: "virtual" | "file"; logicalPath: string }>()
  const virtualEntries = new Map<
    string,
    { absolutePath: string; record: Extract<BundlerSnapshot["inputs"][number], { kind: "virtual" }> }
  >()

  for (const logical of Object.keys(virtual).sort(compareText)) {
    const normalizedLogical = logical.replaceAll("\\", "/")
    if (
      isAbsolute(logical) ||
      /^[A-Za-z]:\//.test(normalizedLogical) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalizedLogical)
    ) {
      throw new Error("Virtual bundler input keys must be relative paths.")
    }
    const absolutePath = resolve(workingDirectory, logical)
    const logicalPath = relativeRoot(rootPath, absolutePath, "Virtual input")
    const contents = virtual[logical]
    if (typeof contents !== "string") throw new Error("Virtual bundler inputs must be strings.")
    const record = {
      kind: "virtual" as const,
      logicalPath,
      size: Buffer.byteLength(contents, "utf8"),
      sha256: hash(Buffer.from(contents, "utf8")),
    }
    const key = canonicalPath(absolutePath)
    const previous = virtualEntries.get(key)
    if (previous && (previous.record.sha256 !== record.sha256 || previous.record.size !== record.size)) {
      throw new Error("Virtual bundler input paths have conflicting contents.")
    }
    virtualEntries.set(key, { absolutePath, record })
  }

  const sourceInputs = new Set(inputs)
  for (const input of sourceInputs) {
    const virtualEntry = findVirtual(input, workingDirectory, virtualEntries)
    if (virtualEntry) {
      addRecord(records, virtualEntry.record)
      metafileInputs.set(`virtual:${virtualEntry.record.logicalPath}`, {
        kind: "virtual",
        logicalPath: virtualEntry.record.logicalPath,
      })
      continue
    }
    const resolvedInput = inputPath(input, workingDirectory)
    const record = readBundlerFile(rootPath, resolvedInput, false)
    addRecord(records, record)
    metafileInputs.set(`file:${record.logicalPath}`, { kind: "file", logicalPath: record.logicalPath })
  }

  for (const additionalInput of new Set(additional)) {
    const resolvedInput = inputPath(additionalInput, workingDirectory)
    const record = readBundlerFile(rootPath, resolvedInput, true)
    addRecord(records, record)
  }

  const snapshot: BundlerSnapshot = {
    schema: 1,
    cwd: cwdPath,
    metafileInputs: [...metafileInputs.values()].sort(
      (a, b) => compareText(a.logicalPath, b.logicalPath) || compareText(a.kind, b.kind),
    ),
    inputs: [...records.values()].sort(
      (a, b) => compareText(a.logicalPath, b.logicalPath) || compareText(a.kind, b.kind),
    ),
  }
  if (snapshot.inputs.length > maxInputs) throw new Error(`Bundler input inventory exceeds ${maxInputs} files.`)
  assertInventorySize(snapshot)
  return snapshot
}

export function assertStableInputs(before: unknown, after: unknown, label: string): void {
  if (stableJson(before) !== stableJson(after)) throw new Error(`${label}: inputs changed between snapshots.`)
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString("utf8")
}

function readRepositoryFile(root: string, path: string, allowMissing: boolean) {
  const candidate = resolve(root, path)
  const relativePath = relativeRoot(root, candidate, "Repository input")
  if (relativePath !== path.replaceAll("\\", "/")) throw new Error("Git returned a non-canonical repository path.")
  return readRegularFile(root, candidate, allowMissing, "Repository input", false)
}

function readBundlerFile(root: string, path: string, additional: boolean) {
  const logicalPath = relativeRoot(root, path, "Bundler input")
  const file = readRegularFile(root, path, false, "Bundler input", true)
  if (file.kind !== "file") throw new Error("Bundler input is missing.")
  return {
    kind: "file" as const,
    logicalPath,
    resolvedPath: file.resolvedPath,
    size: file.size,
    sha256: file.sha256,
    ...(additional ? { additional: true as const } : {}),
  }
}

function readRegularFile(
  root: string,
  path: string,
  allowMissing: boolean,
  label: string,
  allowInternalSymlinks: boolean,
) {
  const relativePath = relativeRoot(root, path, label)
  const segments = relativePath ? relativePath.split("/") : []
  let cursor = root
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment)
    let stat
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      if (allowMissing && isMissing(error)) return { kind: "missing" as const }
      throw new Error(`${label} is unavailable.`)
    }
    if (stat.isSymbolicLink() && !allowInternalSymlinks)
      throw new Error(`${label} contains a symbolic link or reparse point.`)
    let targetStat = stat
    if (stat.isSymbolicLink() && allowInternalSymlinks) {
      let target: string
      try {
        target = realpathSync(cursor)
      } catch {
        throw new Error(`${label} is unavailable.`)
      }
      relativeRoot(root, target, label)
      try {
        targetStat = lstatSync(target)
      } catch {
        throw new Error(`${label} is unavailable.`)
      }
    }
    if (index < segments.length - 1 && !targetStat.isDirectory())
      throw new Error(`${label} has a non-directory path component.`)
    if (index === segments.length - 1 && !targetStat.isFile()) throw new Error(`${label} is not a regular file.`)
  }
  if (segments.length === 0) throw new Error(`${label} must name a file inside the repository.`)

  const resolvedPath = realpathSync(path)
  const resolvedRelative = relativeRoot(root, resolvedPath, label)
  const contents = readFileSync(resolvedPath)
  return { kind: "file" as const, resolvedPath: resolvedRelative, size: contents.byteLength, sha256: hash(contents) }
}

function inputPath(input: string, cwd: string) {
  if (typeof input !== "string" || input.length === 0) throw new Error("Bundler input path is invalid.")
  const normalized = input.replaceAll("\\", "/")
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Unsupported bundler input namespace.")
  }
  return resolve(cwd, input)
}

function findVirtual(
  input: string,
  cwd: string,
  virtual: Map<
    string,
    { absolutePath: string; record: Extract<BundlerSnapshot["inputs"][number], { kind: "virtual" }> }
  >,
) {
  if (typeof input !== "string" || input.length === 0) throw new Error("Bundler input path is invalid.")
  const normalized = input.replaceAll("\\", "/")
  const directPath = resolve(cwd, input)
  const direct = virtual.get(canonicalPath(directPath))
  if (direct) return direct

  let remainder = normalized
  while (remainder.startsWith("../")) remainder = remainder.slice(3)
  while (remainder.startsWith("..\\")) remainder = remainder.slice(3)
  if (!/^[A-Za-z]:\//.test(remainder)) return undefined
  const target = canonicalPath(resolve(remainder))
  for (const entry of virtual.values()) {
    if (target === canonicalPath(entry.absolutePath)) return entry
  }
  return undefined
}

function addRecord(records: Map<string, BundlerSnapshot["inputs"][number]>, record: BundlerSnapshot["inputs"][number]) {
  const key = record.logicalPath
  const previous = records.get(key)
  if (!previous) {
    records.set(key, record)
    return
  }
  if (previous.kind !== record.kind || previous.sha256 !== record.sha256 || previous.size !== record.size) {
    throw new Error("Bundler input paths have conflicting snapshots.")
  }
  if (previous.kind === "file" && record.kind === "file" && previous.resolvedPath !== record.resolvedPath) {
    throw new Error("Bundler input path resolves inconsistently.")
  }
  if (previous.kind === "file" && record.kind === "file" && (previous.additional || record.additional)) {
    records.set(key, { ...previous, additional: true })
  }
}

function relativeRoot(root: string, path: string, label: string) {
  const relativePath = relative(root, resolve(path))
  if (!relativePath || relativePath === ".") {
    if (resolve(path) === root) return ""
    throw new Error(`${label} is outside the repository.`)
  }
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} is outside the repository.`)
  }
  return relativePath.split(sep).join("/")
}

function canonicalPath(path: string) {
  const normalized = resolve(path).replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function hash(contents: Buffer) {
  return createHash("sha256").update(contents).digest("hex")
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function assertInventorySize(snapshot: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
  if (bytes > maxInventoryBytes) throw new Error(`Build input inventory exceeds ${maxInventoryBytes} bytes.`)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`
  }
  throw new Error("Build input snapshot is not JSON serializable.")
}
