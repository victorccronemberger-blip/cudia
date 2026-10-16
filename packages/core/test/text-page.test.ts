import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Stream } from "effect"
import { TextPage } from "../src/util/text-page"

describe("text page", () => {
  test("retains the BOM by default and rejects malformed UTF-8 in fatal mode", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff])
    const source = () => Stream.fromIterable([bytes.slice(0, 2), bytes.slice(2)])

    const decoded = await Effect.runPromise(TextPage.snapshot(source(), { offset: 0, limit: 8 }))
    expect(decoded.text).toBe("\uFEFFa�")
    expect(decoded.totalLength).toBe(3)
    expect(decoded.contentHash).toBe(TextPage.hash("\uFEFFa�"))

    const rejected = await Effect.runPromise(
      Effect.exit(TextPage.snapshot(source(), { offset: 0, limit: 8, fatal: true })),
    )
    expect(Exit.isFailure(rejected)).toBe(true)
    if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toBeInstanceOf(TextPage.DecodeError)
  })

  test("decodes UTF-16LE code units losslessly across single-byte chunks", async () => {
    const text = "\uFEFFA😀\uD800B\uDC00"
    const bytes = Buffer.from(text, "utf16le")
    const result = await Effect.runPromise(
      TextPage.snapshot(Stream.fromIterable(Array.from(bytes, (_, index) => bytes.slice(index, index + 1))), {
        offset: 0,
        limit: text.length,
        encoding: "utf16le",
      }),
    )

    expect(result.text).toBe(text)
    expect(result.totalLength).toBe(text.length)
    expect(result.contentHash).toBe(TextPage.hash(text))

    const incomplete = await Effect.runPromise(
      Effect.exit(
        TextPage.snapshot(Stream.fromIterable([new Uint8Array([0x41])]), {
          offset: 0,
          limit: 1,
          encoding: "utf16le",
        }),
      ),
    )
    expect(Exit.isFailure(incomplete)).toBe(true)
    if (Exit.isFailure(incomplete)) expect(Cause.squash(incomplete.cause)).toBeInstanceOf(TextPage.DecodeError)
  })

  test("guards UTF-16 offsets and includes the complete encoded envelope in the byte budget", () => {
    const text = "a😀b"
    const encode = (end: number) => JSON.stringify({ text: text.slice(0, end), end })

    expect(TextPage.format(text, { offset: 2, limit: 1, maxBytes: 100 }, encode)).toEqual({
      ok: false,
      error: "surrogate",
    })
    expect(TextPage.format(text, { offset: 1, limit: 1, maxBytes: 100 }, encode)).toEqual({
      ok: false,
      error: "character",
    })
    expect(TextPage.format(text, { offset: 0, limit: text.length, maxBytes: 1 }, encode)).toEqual({
      ok: false,
      error: "budget",
    })
    expect(TextPage.format(text, { offset: text.length, limit: 1, maxBytes: 100 }, encode)).toEqual({
      ok: true,
      output: JSON.stringify({ text, end: text.length }),
      end: text.length,
    })
  })
})
