import { ClientError, type OpenCode } from "@opencode-ai/runtime-client"
import type { FilesListOutput } from "@opencode-ai/runtime-client"
import type { FileContent } from "@opencode-ai/sdk/v2"
import type { FileNode } from "@/context/file/types"

export type NativeFileReadInput = {
  path: string
  location: { directory: string; workspace?: string }
}

export function presentNativeFileNodes(directory: string, entries: FilesListOutput["data"]): FileNode[] {
  const windows = /^[A-Za-z]:/.test(directory) || directory.startsWith("\\\\") || directory.startsWith("//")
  const root = (windows ? directory.replace(/\\/g, "/") : directory).replace(/\/+$/, "")
  return entries.map((entry) => {
    const path = (windows ? entry.path.replace(/\\/g, "/") : entry.path).replace(/\/+$/, "")
    return { name: path.split("/").at(-1) ?? path, path, absolute: `${root}/${path}`, type: entry.type }
  })
}

export function createNativeFileReader(config: OpenCode.ClientOptions) {
  const fetch = config.fetch ?? globalThis.fetch
  return async (input: NativeFileReadInput, options?: OpenCode.RequestOptions): Promise<FileContent> => {
    options?.signal?.throwIfAborted()
    const windows =
      /^[A-Za-z]:/.test(input.location.directory) ||
      input.location.directory.startsWith("\\\\") ||
      input.location.directory.startsWith("//")
    const path = windows ? input.path.replace(/\\/g, "/") : input.path
    // URL dot-segment normalization must never redirect a file read to another API route.
    if (
      !path ||
      path.startsWith("/") ||
      (windows && /^[A-Za-z]:/.test(path)) ||
      path.split("/").some((part) => part === "..")
    )
      throw new Error(undefined, { cause: "InvalidRelativeFilePath" })
    const encoded = path
      .split("/")
      .filter((part) => part && part !== ".")
      .map(encodeURIComponent)
      .join("/")
    if (!encoded) throw new Error(undefined, { cause: "InvalidRelativeFilePath" })
    const url = new URL(`/api/fs/read/${encoded}`, config.baseUrl)
    url.searchParams.set("location[directory]", input.location.directory)
    if (input.location.workspace !== undefined) url.searchParams.set("location[workspace]", input.location.workspace)
    const headers = new Headers(config.headers)
    for (const [key, value] of new Headers(options?.headers)) headers.set(key, value)
    const response = await fetch(url, { headers, signal: options?.signal })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
    }
    const bytes = await readFileBytes(response, options?.signal)
    options?.signal?.throwIfAborted()
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream"
    if (!bytes.includes(0)) {
      const text = decodeText(bytes)
      if (text !== undefined) return { type: "text", content: text, mimeType }
    }
    return { type: "binary", content: base64(bytes), encoding: "base64", mimeType }
  }
}

async function readFileBytes(response: Response, signal?: AbortSignal) {
  if (signal?.aborted) await response.body?.cancel(signal.reason).catch(() => undefined)
  signal?.throwIfAborted()
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    signal?.throwIfAborted()
    while (true) {
      const item = await reader.read()
      signal?.throwIfAborted()
      if (item.done) break
      chunks.push(item.value)
      length += item.value.byteLength
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function base64(bytes: Uint8Array) {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    let text = ""
    for (const byte of bytes.subarray(offset, offset + 8192)) text += String.fromCharCode(byte)
    chunks.push(text)
  }
  return btoa(chunks.join(""))
}
