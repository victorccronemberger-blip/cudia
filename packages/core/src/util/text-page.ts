import { createHash } from "node:crypto"
import { Effect, Stream } from "effect"

export const MAX_UNITS = 4096
export const MAX_BYTES = 6000

export class DecodeError extends Error {
  override readonly cause: unknown

  constructor(cause: unknown, encoding: "UTF-8" | "UTF-16LE" = "UTF-8") {
    super(`Invalid ${encoding} source`)
    this.name = "DecodeError"
    this.cause = cause
  }
}

export function hash(text: string) {
  return createHash("sha256").update(JSON.stringify(text), "utf8").digest("hex")
}

/** Hash the decoded source while retaining only the requested window and Unicode boundary guards. */
export function snapshot<E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  input: { offset: number; limit: number; fatal?: boolean; encoding?: "utf8" | "utf16le" },
) {
  return Effect.gen(function* () {
    const digest = createHash("sha256").update('"')
    const decoder =
      input.encoding === "utf16le"
        ? undefined
        : new TextDecoder("utf-8", { ignoreBOM: true, fatal: input.fatal ?? false })
    const start = Math.max(0, input.offset - 1)
    const stop = input.offset + input.limit + 1
    const window: string[] = []
    let totalLength = 0
    let pendingByte: number | undefined
    let pendingHigh: string | undefined
    const consume = (text: string) => {
      if (!text) return
      digest.update(JSON.stringify(text).slice(1, -1), "utf8")
      const end = totalLength + text.length
      if (end > start && totalLength < stop)
        window.push(text.slice(Math.max(0, start - totalLength), Math.min(text.length, stop - totalLength)))
      totalLength = end
    }
    const consumeDecoded = (text: string) => {
      if (!text) return
      if (pendingHigh !== undefined) {
        if (text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) text = pendingHigh + text
        else consume(pendingHigh)
        pendingHigh = undefined
      }
      if (text.length && text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) {
        pendingHigh = text.slice(-1)
        text = text.slice(0, -1)
      }
      consume(text)
    }
    const decodeUTF16LE = (chunk: Uint8Array) => {
      const units = new Uint16Array(Math.floor((chunk.length + (pendingByte === undefined ? 0 : 1)) / 2))
      let unitIndex = 0
      let byteIndex = 0
      if (pendingByte !== undefined && chunk.length) {
        units[unitIndex++] = pendingByte | (chunk[0] << 8)
        pendingByte = undefined
        byteIndex = 1
      }
      for (; byteIndex + 1 < chunk.length; byteIndex += 2) {
        units[unitIndex++] = chunk[byteIndex] | (chunk[byteIndex + 1] << 8)
      }
      if (byteIndex < chunk.length) pendingByte = chunk[byteIndex]
      const parts: string[] = []
      for (let index = 0; index < unitIndex; index += 8192)
        parts.push(String.fromCharCode(...units.subarray(index, Math.min(unitIndex, index + 8192))))
      return parts.join("")
    }
    yield* source.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const text = yield* decoder
            ? Effect.try({
                try: () => decoder.decode(chunk, { stream: true }),
                catch: (cause) => new DecodeError(cause),
              })
            : Effect.sync(() => decodeUTF16LE(chunk))
          yield* Effect.sync(() => consumeDecoded(text))
        }),
      ),
    )
    if (decoder)
      consumeDecoded(
        yield* Effect.try({
          try: () => decoder.decode(),
          catch: (cause) => new DecodeError(cause),
        }),
      )
    if (pendingByte !== undefined)
      return yield* Effect.fail(
        new DecodeError(new TypeError("UTF-16LE source ended with an incomplete code unit"), "UTF-16LE"),
      )
    if (pendingHigh !== undefined) consume(pendingHigh)
    return {
      text: window.join(""),
      start,
      totalLength,
      contentHash: digest.update('"').digest("hex"),
    }
  })
}

/** The encoder includes the entire envelope so escaping and metadata count toward the budget. */
export function format(
  text: string,
  input: { offset: number; limit: number; maxBytes: number },
  encode: (end: number) => string,
) {
  const { offset, limit, maxBytes } = input
  if (offset > text.length) return { ok: false, error: "offset" } as const
  if (offset > 0 && offset < text.length && pair(text, offset)) return { ok: false, error: "surrogate" } as const

  let end = Math.min(offset + limit, text.length)
  if (end > offset && end < text.length && pair(text, end)) end--
  if (end === offset && end < text.length) return { ok: false, error: "character" } as const

  let output = encode(end)
  while (Buffer.byteLength(output, "utf8") > maxBytes && end > offset) {
    end -= end - 1 > offset && pair(text, end - 1) ? 2 : 1
    output = encode(end)
  }
  if (Buffer.byteLength(output, "utf8") > maxBytes || (end === offset && end < text.length))
    return { ok: false, error: "budget" } as const

  return { ok: true, output, end } as const
}

function pair(text: string, offset: number) {
  const first = text.charCodeAt(offset - 1)
  const second = text.charCodeAt(offset)
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
}

export * as TextPage from "./text-page"
