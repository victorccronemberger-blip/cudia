import { createPrivateKey, createPublicKey, sign } from "node:crypto"
import { open, realpath, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, basename, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import { TextDecoder } from "node:util"
import { MAX_ENVELOPE_BYTES, readCappedFile, validateEnvelope } from "./lib/manifest.js"

const MAX_PRIVATE_KEY_BYTES = 16 * 1024
const MAX_PAYLOAD_BYTES = 48 * 1024
const UTF8 = new TextDecoder("utf-8", { fatal: true })

export async function publishManifest(options) {
  if (!options || !isAbsolute(options.input) || !isAbsolute(options.output) || !isAbsolute(options.privateKeyFile)) {
    throw new Error("invalid_arguments")
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.keyId)) throw new Error("invalid_arguments")

  const inputReal = await realpath(options.input)
  const privateKeyReal = await realpath(options.privateKeyFile)
  const outputReal = join(await realpath(dirname(options.output)), basename(options.output))
  const pathKey = (value) => (process.platform === "win32" ? value.toLowerCase() : value)
  if (pathKey(outputReal) === pathKey(privateKeyReal) || pathKey(outputReal) === pathKey(inputReal)) {
    throw new Error("invalid_arguments")
  }

  const payloadBytes = await readCappedFile(inputReal, MAX_PAYLOAD_BYTES)
  const keyBytes = await readCappedFile(privateKeyReal, MAX_PRIVATE_KEY_BYTES)
  let payload
  try {
    payload = JSON.parse(UTF8.decode(payloadBytes))
  } catch {
    throw new Error("payload_invalid")
  }
  if (payload?.channel !== "stable" && payload?.channel !== "preview") throw new Error("payload_invalid")
  const privateKey = createPrivateKey(UTF8.decode(keyBytes))
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("key_invalid")
  const publicKey = createPublicKey(privateKey)
  const envelope = Buffer.from(
    JSON.stringify({
      schema: 1,
      keyId: options.keyId,
      payload: payloadBytes.toString("base64"),
      signature: sign(null, payloadBytes, privateKey).toString("base64"),
    }),
  )
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new Error("envelope_oversized")
  validateEnvelope(envelope, new Map([[options.keyId, publicKey]]), payload.channel, options.now ?? new Date())

  const outputDir = dirname(options.output)
  const temporary = join(outputDir, `.${basename(options.output)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
  let handle
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(envelope)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, options.output)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  return { output: options.output, bytes: envelope.length, keyId: options.keyId, channel: payload.channel }
}

function parseArgs(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!value || !["--input", "--output", "--key-id"].includes(name) || name in result) {
      throw new Error("invalid_arguments")
    }
    result[name] = value
  }
  if (!result["--input"] || !result["--output"] || !result["--key-id"]) throw new Error("invalid_arguments")
  const privateKeyFile = process.env.CUDIA_RELEASE_PRIVATE_KEY_FILE
  if (!privateKeyFile) throw new Error("invalid_arguments")
  return {
    input: result["--input"],
    output: result["--output"],
    keyId: result["--key-id"],
    privateKeyFile,
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await publishManifest(parseArgs(process.argv.slice(2)))
    process.stdout.write(`Published ${result.channel} manifest (${result.bytes} bytes, key ${result.keyId})\n`)
  } catch {
    process.stderr.write("Publish failed; check the input, output, and signing-key configuration.\n")
    process.exitCode = 1
  }
}
