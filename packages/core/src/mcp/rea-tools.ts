import path from "node:path"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { Global } from "../global"
import { Flock } from "../util/flock"
import { isReaCommand } from "./rea-command"

export type Tool = {
  name: string
  version: string
  url: string
  sha256: string
  size: number
  format: "archive" | "file"
  required: string[]
  environment: Record<string, string>
  generated?: Record<string, string>
}

export const tools: readonly Tool[] = [
  {
    name: "adb",
    version: "37.0.1",
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip",
    sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
    size: 8044989,
    format: "archive",
    required: ["platform-tools/adb.exe", "platform-tools/AdbWinApi.dll", "platform-tools/AdbWinUsbApi.dll"],
    environment: { REA_ADB_PATH: "platform-tools/adb.exe" },
  },
  {
    name: "wabt",
    version: "1.0.42",
    url: "https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-windows-x64.tar.gz",
    sha256: "62f1eb2b51aa57cf0f0b8ba333bf2c72a049930aa9c5de01dcad271c4fe48c88",
    size: 6519558,
    format: "archive",
    required: ["wabt-1.0.42/bin/wasm-validate.exe", "wabt-1.0.42/bin/wasm-objdump.exe", "wabt-1.0.42/bin/wasm2wat.exe"],
    environment: { REA_WABT_BIN_DIRECTORY: "wabt-1.0.42/bin" },
  },
  {
    name: "jadx",
    version: "0.7.1",
    url: "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar",
    sha256: "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75",
    size: 42619858,
    format: "file",
    required: ["jadx-headless-mcp.jar"],
    environment: { REA_JADX_MCP_JAR: "jadx-headless-mcp.jar" },
  },
  {
    name: "apktool",
    version: "3.0.3",
    url: "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar",
    sha256: "dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423",
    size: 15478013,
    format: "file",
    required: ["apktool.jar", "apktool.cmd"],
    environment: { REA_APKTOOL_COMMAND: "apktool.cmd" },
    generated: {
      "apktool.cmd":
        '@echo off\r\nif defined JAVA_HOME (\r\n  "%JAVA_HOME%\\bin\\java.exe" -jar "%~dp0apktool.jar" %*\r\n) else (\r\n  java -jar "%~dp0apktool.jar" %*\r\n)\r\n',
    },
  },
  {
    name: "jdk",
    version: "21.0.12.1+1",
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip",
    sha256: "f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e",
    size: 205073461,
    format: "archive",
    required: ["jdk-21.0.12.1+1/bin/java.exe", "jdk-21.0.12.1+1/bin/javac.exe"],
    environment: { JAVA_HOME: "jdk-21.0.12.1+1" },
  },
]

const File = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const Receipt = z.object({
  name: z.string(),
  version: z.string(),
  sha256: z.string(),
  platform: z.literal("win32-x64"),
  files: z.array(File).max(30000),
})
const Pointer = z.object({ directory: z.string() })
const execute = promisify(execFile)
const cache = () => path.join(Global.Path.cache, "rea-tools")

async function archiveCommand(command: string, args: string[], signal: AbortSignal) {
  const running = execute(command, args, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, signal })
  // Aborting execFile can reject before close. Join the owned extractor before deleting its staging files.
  const closed = new Promise<void>((resolve) => running.child.once("close", () => resolve()))
  try {
    return await running
  } finally {
    await closed
  }
}

export type Inspection = {
  name: string
  version: string
  state: "missing" | "ready" | "invalid"
  environment: Record<string, string>
  reason?: string
}

function relative(file: string) {
  return (
    file.length > 0 &&
    !file.includes("\\") &&
    !file.includes(":") &&
    !file.startsWith("/") &&
    file.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  )
}

async function inventory(root: string, signal?: AbortSignal) {
  const pending = [root]
  const files: z.infer<typeof File>[] = []
  let size = 0
  while (pending.length) {
    signal?.throwIfAborted()
    const directory = pending.pop()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(target)
        continue
      }
      if (!entry.isFile()) throw new Error("REA tool installation contains a link or unsupported entry")
      if (target === path.join(root, "receipt.json")) continue
      if (files.length >= 30000) throw new Error("REA tool installation contains too many files")
      const info = await fs.stat(target)
      size += info.size
      if (size > 2 * 1024 ** 3) throw new Error("REA tool installation exceeds 2 GiB")
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(target, { signal })) {
        signal?.throwIfAborted()
        hash.update(chunk)
      }
      files.push({
        path: path.relative(root, target).split(path.sep).join("/"),
        size: info.size,
        sha256: hash.digest("hex"),
      })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function inspect(tool: Tool, root = cache(), signal?: AbortSignal): Promise<Inspection> {
  signal?.throwIfAborted()
  const pointer = await fs
    .readFile(path.join(root, `${tool.name}.json`), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
  if (pointer === undefined)
    return { name: tool.name, version: tool.version, state: "missing" as const, environment: {} }
  try {
    const selected = Pointer.parse(JSON.parse(pointer)).directory
    if (!/^i-[a-z0-9-]+$/.test(selected)) throw new Error("Invalid installation directory")
    const directory = path.join(root, selected)
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Installation directory is a link")
    const receipt = Receipt.parse(JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8")))
    if (receipt.name !== tool.name || receipt.version !== tool.version || receipt.sha256 !== tool.sha256)
      throw new Error("Installation receipt does not match the pinned release")
    if (receipt.files.some((file) => !relative(file.path))) throw new Error("Invalid inventory path")
    if (tool.required.some((file) => !receipt.files.some((entry) => entry.path === file)))
      throw new Error("Required executable is missing")
    for (const [file, text] of Object.entries(tool.generated ?? {}))
      if (
        receipt.files.find((entry) => entry.path === file)?.sha256 !== createHash("sha256").update(text).digest("hex")
      )
        throw new Error("Generated tool launcher does not match this release")
    if (JSON.stringify(await inventory(directory, signal)) !== JSON.stringify(receipt.files))
      throw new Error("Installed files changed or are incomplete")
    return {
      name: tool.name,
      version: tool.version,
      state: "ready" as const,
      environment: Object.fromEntries(
        Object.entries(tool.environment).map(([key, value]) => [key, path.join(directory, value)]),
      ),
    }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      name: tool.name,
      version: tool.version,
      state: "invalid" as const,
      environment: {},
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function install(tool: Tool, root = cache(), signal?: AbortSignal) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Managed REA tools currently require Windows x64")
  return Flock.withLock(
    `rea-tool:${tool.name}:${tool.sha256}`,
    async () => {
      const installed = await inspect(tool, root, signal)
      if (installed.state === "ready") return installed
      const id = randomUUID().replaceAll("-", "")
      const staging = path.join(root, `.staging-${id}`)
      const directory = path.join(root, `i-${tool.name}-${id}`)
      const archive = path.join(staging, "download")
      const content = path.join(staging, "content")
      const temporary = path.join(root, `.pointer-${id}`)
      await fs.mkdir(content, { recursive: true })
      try {
        const deadline = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)])
          : AbortSignal.timeout(10 * 60 * 1000)
        const response = await fetch(tool.url, { signal: deadline })
        if (!response.ok || !response.body)
          throw new Error(`REA ${tool.name} download returned HTTP ${response.status}`)
        const handle = await fs.open(archive, "wx")
        const hash = createHash("sha256")
        let size = 0
        let failed = true
        try {
          const reader = response.body.getReader()
          let complete = false
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) {
                complete = true
                break
              }
              const chunk = next.value
              size += chunk.byteLength
              if (size > tool.size) throw new Error("REA tool download exceeds its pinned size")
              hash.update(chunk)
              await handle.writeFile(chunk)
            }
          } finally {
            // This reader is never reused. Bun can fail releaseLock() on a completed native fetch stream.
            if (!complete) {
              try {
                await reader.cancel()
              } catch {
                /* Preserve the download/write failure. */
              }
            }
          }
          failed = false
        } finally {
          if (failed) await handle.close().catch(() => {})
          if (!failed) await handle.close()
        }
        if (size !== tool.size || hash.digest("hex") !== tool.sha256)
          throw new Error("REA tool download checksum or size mismatch")
        if (tool.format === "file") {
          const destination = path.join(content, tool.required[0]!)
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.rename(archive, destination)
        } else {
          const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          const listing = await archiveCommand(tar, ["-tf", archive], deadline)
          if (
            listing.stdout
              .split(/\r?\n/)
              .filter(Boolean)
              .some((entry) => !relative(entry.replace(/\/$/, "")))
          )
            throw new Error("REA tool archive contains an invalid path")
          const types = await archiveCommand(tar, ["-tvf", archive], deadline)
          if (
            types.stdout
              .split(/\r?\n/)
              .filter(Boolean)
              .some((entry) => entry[0] !== "-" && entry[0] !== "d")
          )
            throw new Error("REA tool archive contains a link or unsupported entry")
          await archiveCommand(tar, ["-xf", archive, "-C", content], deadline)
        }
        deadline.throwIfAborted()
        for (const [file, text] of Object.entries(tool.generated ?? {})) {
          if (!relative(file)) throw new Error("Invalid generated tool path")
          await fs.writeFile(path.join(content, file), text)
        }
        const files = await inventory(content, deadline)
        if (tool.required.some((file) => !files.some((entry) => entry.path === file)))
          throw new Error("REA archive lacks required executables")
        await fs.writeFile(
          path.join(content, "receipt.json"),
          JSON.stringify({ name: tool.name, version: tool.version, sha256: tool.sha256, platform: "win32-x64", files }),
        )
        await fs.rename(content, directory)
        await fs.writeFile(temporary, JSON.stringify({ directory: path.basename(directory) }))
        await fs.rename(temporary, path.join(root, `${tool.name}.json`))
        return await inspect(tool, root, deadline)
      } finally {
        await fs.rm(staging, { recursive: true, force: true })
        await fs.rm(temporary, { force: true })
      }
    },
    { dir: path.join(root, "locks"), signal },
  )
}

export async function environmentFor(
  command: string,
  args: readonly string[],
  environment: Record<string, string> = {},
  root = cache(),
  catalog: readonly Tool[] = tools,
  signal?: AbortSignal,
) {
  if (!isReaCommand(command, args)) return environment
  const result = { ...environment }
  for (const tool of catalog) {
    // Explicit selections win, including invalid paths; never silently substitute a different tool.
    const keys = Object.keys(tool.environment)
    for (const key of keys)
      if (result[key] === undefined && process.env[key] !== undefined) result[key] = process.env[key]!
    if (keys.every((key) => result[key] !== undefined)) continue
    const status = await inspect(tool, root, signal).catch((error: unknown) => {
      signal?.throwIfAborted()
      return { state: "invalid", environment: {}, reason: String(error) }
    })
    if (status.state === "invalid") {
      process.emitWarning(
        `REA ${tool.name} is unavailable; run cudia rea install ${tool.name}. ${"reason" in status ? status.reason : ""}`,
        { code: "CUDIA_REA_TOOL_UNAVAILABLE" },
      )
      continue
    }
    for (const [key, value] of Object.entries(status.environment)) if (result[key] === undefined) result[key] = value
  }
  return result
}
