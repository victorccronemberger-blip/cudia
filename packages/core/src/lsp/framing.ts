export * as LSPFraming from "./framing"

import { Option, Schema } from "effect"

export const MAX_HEADER_BYTES = 8 * 1024
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/** A byte parser: UTF-8 characters and headers may span arbitrary stdio chunks. */
export function parser(accept: (message: Record<string, unknown>) => void) {
  let buffer = Buffer.alloc(0)
  let length: number | undefined
  const consume = (chunk: Uint8Array) => {
    if (buffer.length + chunk.length > MAX_MESSAGE_BYTES + MAX_HEADER_BYTES)
      throw new Error("LSP receive buffer exceeds its limit")
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length > 0) {
      if (length === undefined) {
        const end = buffer.indexOf("\r\n\r\n")
        if (end < 0) {
          if (buffer.length > MAX_HEADER_BYTES) throw new Error("LSP header exceeds its limit")
          return
        }
        if (end > MAX_HEADER_BYTES) throw new Error("LSP header exceeds its limit")
        if (
          buffer.subarray(0, end).some((byte) => byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126))
        )
          throw new Error("LSP header must contain ASCII bytes")
        const headers = buffer.subarray(0, end).toString("ascii").split("\r\n")
        if (headers.some((line) => !/^[A-Za-z0-9-]+:[\t -~]*$/.test(line))) throw new Error("LSP header is malformed")
        const sizes = headers.filter((line) => /^content-length:/i.test(line))
        if (sizes.length !== 1 || !/^content-length:\s*(0|[1-9][0-9]*)\s*$/i.test(sizes[0]!))
          throw new Error("LSP Content-Length is invalid")
        length = Number(sizes[0]!.slice(sizes[0]!.indexOf(":") + 1).trim())
        if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_MESSAGE_BYTES)
          throw new Error("LSP message exceeds its limit")
        buffer = buffer.subarray(end + 4)
      }
      if (buffer.length < length) return
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
      buffer = buffer.subarray(length)
      length = undefined
      const decoded = decode(text)
      if (Option.isNone(decoded) || !record(decoded.value) || decoded.value.jsonrpc !== "2.0")
        throw new Error("LSP message is invalid JSON-RPC")
      const pending: { value: unknown; depth: number }[] = [{ value: decoded.value, depth: 0 }]
      let nodes = 0
      while (pending.length) {
        const item = pending.pop()!
        if (++nodes > 100_000 || item.depth > 64) throw new Error("LSP JSON structure exceeds its limit")
        if (item.value === null || typeof item.value !== "object") continue
        for (const value of Object.values(item.value)) {
          if (nodes + pending.length >= 100_000) throw new Error("LSP JSON node limit exceeded")
          pending.push({ value, depth: item.depth + 1 })
        }
      }
      accept(decoded.value)
    }
  }
  return Object.assign(consume, { incomplete: () => buffer.length > 0 || length !== undefined })
}

export function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("LSP outgoing message exceeds its limit")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
