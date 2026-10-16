import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { TextPage } from "../../src/util/text-page"

describe("streamed text page snapshot", () => {
  test("keeps exact UTF-8 decoding and hashes across every byte boundary", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('\uFEFFA😀界\"\\\r\nend'), 0xe2, 0x82])
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
    for (let index = 0; index <= bytes.length; index++) {
      const result = await Effect.runPromise(
        TextPage.snapshot(Stream.fromIterable([bytes.slice(0, index), bytes.slice(index)]), { offset: 2, limit: 4 }),
      )
      expect(result.text).toBe(text.slice(1, 7))
      expect(result.totalLength).toBe(text.length)
      expect(result.contentHash).toBe(TextPage.hash(text))
    }
  })

  test("retains only a bounded window while hashing a larger streamed source", async () => {
    const chunk = "x😀\n".repeat(1024)
    const bytes = new TextEncoder().encode(chunk)
    const result = await Effect.runPromise(
      TextPage.snapshot(Stream.fromIterable(Array.from({ length: 128 }, () => bytes)), {
        offset: 100_000,
        limit: 4096,
      }),
    )
    expect(result.text.length).toBe(4098)
    expect(result.totalLength).toBe(chunk.length * 128)
    expect(result.contentHash).toBe(TextPage.hash(chunk.repeat(128)))
    expect(result.text).toBe(chunk.repeat(128).slice(99_999, 104_097))
  })
})
