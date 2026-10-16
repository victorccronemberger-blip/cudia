import { createPublicKey, verify } from "node:crypto"
import { open } from "node:fs/promises"
import { closeSync, openSync, readSync } from "node:fs"
import { TextDecoder } from "node:util"

export const MAX_ENVELOPE_BYTES = 64 * 1024
const MAX_KEYRING_BYTES = 16 * 1024
const MAX_KEYS = 8
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const UTF8 = new TextDecoder("utf-8", { fatal: true })

export class ReleaseValidationError extends Error {
  constructor(code) {
    super(code)
    this.name = "ReleaseValidationError"
    this.code = code
  }
}

export async function readCappedFile(filePath, maximumBytes) {
  const file = await open(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > maximumBytes) throw new ReleaseValidationError("oversized")
    return buffer.subarray(0, length)
  } finally {
    await file.close()
  }
}

export function loadPublicKeys(options = {}) {
  let configured = {}
  if (options.publicKeys !== undefined) configured = parseKeyring(options.publicKeys)
  else {
    const trustPath = options.trustPath
    const trustBytes = trustPath ? readCappedFileSync(trustPath, MAX_KEYRING_BYTES) : Buffer.from("{}")
    if (trustBytes.length > MAX_KEYRING_BYTES) throw new ReleaseValidationError("trust_invalid")
    configured = parseKeyring(parseJson(UTF8.decode(trustBytes), "trust_invalid"))
    if (options.environmentKeys !== undefined) {
      const envBytes = Buffer.byteLength(options.environmentKeys, "utf8")
      if (envBytes > MAX_KEYRING_BYTES) throw new ReleaseValidationError("trust_invalid")
      configured = { ...configured, ...parseKeyring(parseJson(options.environmentKeys, "trust_invalid")) }
    }
  }

  const keys = new Map()
  const entries = Object.entries(configured)
  if (entries.length > MAX_KEYS) throw new ReleaseValidationError("trust_invalid")
  for (const [keyId, pem] of entries) {
    if (
      !KEY_ID.test(keyId) ||
      ["constructor", "prototype", "__proto__"].includes(keyId) ||
      typeof pem !== "string" ||
      Buffer.byteLength(pem, "utf8") > MAX_KEYRING_BYTES ||
      !pem.trimStart().startsWith("-----BEGIN PUBLIC KEY-----")
    ) {
      throw new ReleaseValidationError("trust_invalid")
    }
    try {
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong_key_type")
      keys.set(keyId, key)
    } catch {
      throw new ReleaseValidationError("trust_invalid")
    }
  }
  return keys
}

export function validateEnvelope(bytes, keys, expectedChannel, now = new Date()) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) {
    throw new ReleaseValidationError("envelope_invalid")
  }
  let envelope
  try {
    envelope = parseJson(UTF8.decode(bytes), "envelope_invalid")
  } catch {
    throw new ReleaseValidationError("envelope_invalid")
  }
  if (!isExactRecord(envelope, ["schema", "keyId", "payload", "signature"])) {
    throw new ReleaseValidationError("envelope_invalid")
  }
  if (envelope.schema !== 1 || typeof envelope.keyId !== "string" || !KEY_ID.test(envelope.keyId)) {
    throw new ReleaseValidationError("envelope_invalid")
  }
  if (!isCanonicalBase64(envelope.payload) || !isCanonicalBase64(envelope.signature)) {
    throw new ReleaseValidationError("envelope_invalid")
  }
  const payloadBytes = Buffer.from(envelope.payload, "base64")
  const signature = Buffer.from(envelope.signature, "base64")
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_ENVELOPE_BYTES || signature.length !== 64) {
    throw new ReleaseValidationError("envelope_invalid")
  }
  const key = keys.get(envelope.keyId)
  if (!key) throw new ReleaseValidationError("untrusted_key")
  if (!verify(null, payloadBytes, key, signature)) throw new ReleaseValidationError("signature_invalid")

  let payload
  try {
    payload = parseJson(UTF8.decode(payloadBytes), "payload_invalid")
  } catch {
    throw new ReleaseValidationError("payload_invalid")
  }
  validatePayload(payload, expectedChannel, now)
  return { payload, keyId: envelope.keyId }
}

export function validatePayload(payload, expectedChannel, now = new Date()) {
  if (
    !isExactRecord(payload, [
      "schema",
      "product",
      "channel",
      "sequence",
      "version",
      "issuedAt",
      "expiresAt",
      "artifacts",
    ])
  ) {
    throw new ReleaseValidationError("payload_invalid")
  }
  if (
    payload.schema !== 1 ||
    payload.product !== "cudia" ||
    payload.channel !== expectedChannel ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 1 ||
    typeof payload.version !== "string" ||
    payload.version.length > 128 ||
    !SEMVER.test(payload.version)
  )
    throw new ReleaseValidationError("payload_invalid")

  const issuedAt = parseUtcTimestamp(payload.issuedAt)
  const expiresAt = parseUtcTimestamp(payload.expiresAt)
  const current = now instanceof Date ? now.getTime() : Number.NaN
  if (!Number.isFinite(current) || expiresAt <= issuedAt || current < issuedAt || current >= expiresAt) {
    throw new ReleaseValidationError("release_expired")
  }
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length < 1 || payload.artifacts.length > 8) {
    throw new ReleaseValidationError("payload_invalid")
  }
  const seen = new Set()
  for (const artifact of payload.artifacts) {
    if (!isExactRecord(artifact, ["kind", "platform", "arch", "variant", "url", "size", "sha256"])) {
      throw new ReleaseValidationError("payload_invalid")
    }
    if (
      !["archive", "installer"].includes(artifact.kind) ||
      artifact.platform !== "windows" ||
      artifact.arch !== "x64" ||
      !["normal", "baseline"].includes(artifact.variant) ||
      typeof artifact.url !== "string" ||
      !isSafeArtifactUrl(artifact.url) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1 ||
      artifact.size > MAX_ARTIFACT_BYTES ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      throw new ReleaseValidationError("payload_invalid")
    const identity = `${artifact.kind}\0${artifact.platform}\0${artifact.arch}\0${artifact.variant}`
    if (seen.has(identity)) throw new ReleaseValidationError("payload_invalid")
    seen.add(identity)
  }
}

function parseUtcTimestamp(value) {
  const match =
    typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value)
  if (!match) {
    throw new ReleaseValidationError("payload_invalid")
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    throw new ReleaseValidationError("payload_invalid")
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new ReleaseValidationError("payload_invalid")
  return time
}

function isSafeArtifactUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

function isCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  return Buffer.from(value, "base64").toString("base64") === value
}

function parseJson(text, code) {
  try {
    rejectDuplicateObjectKeys(text)
    return JSON.parse(text)
  } catch {
    throw new ReleaseValidationError(code)
  }
}

function rejectDuplicateObjectKeys(text) {
  let cursor = 0
  const whitespace = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor++
  }
  const string = () => {
    const start = cursor++
    while (cursor < text.length) {
      const character = text[cursor++]
      if (character === "\\") cursor++
      if (character === '"') return JSON.parse(text.slice(start, cursor))
    }
    throw new Error("invalid_json")
  }
  const value = (depth) => {
    if (depth > 64) throw new Error("json_too_deep")
    whitespace()
    if (text[cursor] === "{") {
      cursor++
      whitespace()
      if (text[cursor] === "}") {
        cursor++
        return
      }
      const seen = new Set()
      while (cursor < text.length) {
        whitespace()
        if (text[cursor] !== '"') throw new Error("invalid_json")
        const key = string()
        if (seen.has(key)) throw new Error("duplicate_key")
        seen.add(key)
        whitespace()
        if (text[cursor++] !== ":") throw new Error("invalid_json")
        value(depth + 1)
        whitespace()
        if (text[cursor] === "}") {
          cursor++
          return
        }
        if (text[cursor++] !== ",") throw new Error("invalid_json")
      }
      throw new Error("invalid_json")
    }
    if (text[cursor] === "[") {
      cursor++
      whitespace()
      if (text[cursor] === "]") {
        cursor++
        return
      }
      while (cursor < text.length) {
        value(depth + 1)
        whitespace()
        if (text[cursor] === "]") {
          cursor++
          return
        }
        if (text[cursor++] !== ",") throw new Error("invalid_json")
      }
      throw new Error("invalid_json")
    }
    if (text[cursor] === '"') {
      string()
      return
    }
    const start = cursor
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor++
    if (cursor === start) throw new Error("invalid_json")
  }
  value(0)
  whitespace()
  if (cursor !== text.length) throw new Error("invalid_json")
}

function parseKeyring(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseValidationError("trust_invalid")
  }
  return value
}

function readCappedFileSync(filePath, maximumBytes) {
  const descriptor = openSync(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maximumBytes) throw new ReleaseValidationError("trust_invalid")
    return buffer.subarray(0, length)
  } finally {
    closeSync(descriptor)
  }
}

function isExactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}
