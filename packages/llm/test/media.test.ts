import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Effect } from "effect"
import { Media } from "../src/media"
import { ProviderShared } from "../src/protocols/shared"

const images = new Set<string>(Media.IMAGE_MIMES)

describe("shared embedded media inspection", () => {
  test("accepts raw, typed bytes, and MIME-consistent data URLs through the same validator", () => {
    for (const data of ["AAEC", new Uint8Array([0, 1, 2]), "data:IMAGE/PNG;base64,AAEC"]) {
      const input = { data, mediaType: "IMAGE/PNG" }
      const inspected = Media.inspect(input, images)
      expect(inspected).toMatchObject({
        status: "valid",
        value: {
          mime: "image/png",
          base64: "AAEC",
          dataUrl: "data:image/png;base64,AAEC",
        },
      })
      if (inspected.status !== "valid") throw new Error("Expected valid media")
      expect([...inspected.value.bytes]).toEqual([0, 1, 2])
      expect(Effect.runSync(ProviderShared.validateMedia("fixture", { type: "media", ...input }, images))).toEqual(
        inspected.value,
      )
    }
  })

  for (const [mediaType, data, message] of [
    ["application/pdf", "!!!!", "does not support media type application/pdf"],
    ["image/png", "data:image/png;base64,?", "media data URL must contain valid base64"],
    ["image/png", "data:image/jpeg;base64,AA==", "media type image/png does not match data URL type image/jpeg"],
    ["image/png", "", "media must contain valid base64"],
    ["image/png", "AA=", "media must contain valid base64"],
    ["image/png", "AA=A", "media must contain valid base64"],
    ["image/png", "A===", "media must contain valid base64"],
    ["image/png", "AB==", "media must contain canonical base64"],
    ["image/png", "AAB=", "media must contain canonical base64"],
  ] as const) {
    test(`preserves protocol validation errors: ${mediaType} ${JSON.stringify(data)}`, () => {
      const input = { mediaType, data }
      expect(Media.inspect(input, images)).toEqual({ status: "invalid", message })
      const error = Effect.runSync(
        ProviderShared.validateMedia("fixture", { type: "media", ...input }, images).pipe(Effect.flip),
      )
      expect(error.message).toBe(`ProviderShared.request: fixture ${message}`)
    })
  }

  test("preserves encoded and decoded byte limits for raw data and byte buffers", () => {
    const encoded = { data: "A".repeat(Media.MAX_MEDIA_ENCODED_BYTES + 4), mediaType: "image/png" }
    expect(Media.inspect(encoded, images)).toEqual({
      status: "invalid",
      message: `media exceeds the ${Media.MAX_MEDIA_ENCODED_BYTES} byte encoded limit`,
    })
    const bytes = new Uint8Array(Media.MAX_MEDIA_DECODED_BYTES + 1)
    const expected = {
      status: "invalid" as const,
      message: `media exceeds the ${Media.MAX_MEDIA_DECODED_BYTES} byte decoded limit`,
    }
    expect(Media.inspect({ mediaType: "image/png", data: bytes }, images)).toEqual(expected)
    const data = Buffer.from(bytes).toString("base64")
    expect(Buffer.byteLength(data)).toBeLessThan(Media.MAX_MEDIA_ENCODED_BYTES)
    expect(Media.inspect({ mediaType: "image/png", data }, images)).toEqual(expected)
    const error = Effect.runSync(
      ProviderShared.validateMedia("fixture", { type: "media", mediaType: "image/png", data }, images).pipe(
        Effect.flip,
      ),
    )
    expect(error.message).toBe(`ProviderShared.request: fixture ${expected.message}`)
  })

  test("accepts valid 8 MiB base64 through the protocol wrapper without regex repetition failure", () => {
    const data = "A".repeat(8 * 1024 * 1024)
    const media = Effect.runSync(
      ProviderShared.validateMedia("fixture", { type: "media", mediaType: "image/png", data }, images),
    )
    expect(media.base64).toBe(data)
    expect(media.bytes.byteLength).toBe(6 * 1024 * 1024)
  })
})
