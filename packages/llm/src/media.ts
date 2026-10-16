import { Buffer } from "node:buffer"

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export const MAX_MEDIA_ENCODED_BYTES = 28 * 1024 * 1024
export const MAX_MEDIA_DECODED_BYTES = 20 * 1024 * 1024

// Length and canonical padding bits are checked separately. Repeating groups
// make Bun/JSC reject large valid payloads before the documented byte limit.
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/

export interface ValidatedMedia {
  readonly mime: string
  readonly base64: string
  readonly dataUrl: string
  readonly bytes: Uint8Array
}

export type Inspection =
  | { readonly status: "valid"; readonly value: ValidatedMedia }
  | { readonly status: "invalid"; readonly message: string }

const invalid = (message: string): Inspection => ({ status: "invalid", message })

/** Pure, bounded preflight shared by adapters and protocol validation. No downloads or state. */
export function inspect(
  part: { readonly mediaType: string; readonly data: string | Uint8Array },
  supportedMimes: ReadonlySet<string>,
): Inspection {
  const mime = part.mediaType.toLowerCase()
  if (!supportedMimes.has(mime)) return invalid(`does not support media type ${part.mediaType}`)

  const base64 = (() => {
    if (typeof part.data !== "string") {
      if (part.data.byteLength > MAX_MEDIA_DECODED_BYTES) return undefined
      return Buffer.from(part.data).toString("base64")
    }
    if (!part.data.startsWith("data:")) return part.data
    return /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s.exec(part.data)
  })()
  if (base64 === undefined) return invalid(`media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
  if (base64 === null) return invalid("media data URL must contain valid base64")
  if (typeof base64 !== "string" && base64[1]!.toLowerCase() !== mime)
    return invalid(`media type ${part.mediaType} does not match data URL type ${base64[1]}`)
  const encoded = typeof base64 === "string" ? base64 : base64[2]!
  if (Buffer.byteLength(encoded, "utf8") > MAX_MEDIA_ENCODED_BYTES)
    return invalid(`media exceeds the ${MAX_MEDIA_ENCODED_BYTES} byte encoded limit`)
  if (!encoded || encoded.length % 4 !== 0 || !base64Pattern.test(encoded))
    return invalid("media must contain valid base64")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength > MAX_MEDIA_DECODED_BYTES)
    return invalid(`media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
  if (bytes.toString("base64") !== encoded) return invalid("media must contain canonical base64")
  return { status: "valid", value: { mime, base64: encoded, dataUrl: `data:${mime};base64,${encoded}`, bytes } }
}

export * as Media from "./media"
