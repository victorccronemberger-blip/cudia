import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection } from "node:net"
import { fileURLToPath } from "node:url"
import { createUpdateServer } from "../app.js"
import { publishManifest } from "../publish.js"
import { loadPublicKeys } from "../lib/manifest.js"

const now = new Date("2026-10-15T12:00:00.000Z")
const keyId = "test-release-key"
const pair = generateKeyPairSync("ed25519")
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" })
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" })

function payload(overrides = {}) {
  return {
    schema: 1,
    product: "cudia",
    channel: "stable",
    sequence: 1,
    version: "1.2.3",
    issuedAt: "2026-10-15T11:00:00Z",
    expiresAt: "2026-10-15T13:00:00Z",
    artifacts: [
      {
        kind: "installer",
        platform: "windows",
        arch: "x64",
        variant: "normal",
        url: "https://cyara.com.br/releases/cudia-1.2.3.exe",
        size: 12345,
        sha256: "a".repeat(64),
      },
    ],
    ...overrides,
  }
}

function envelopeBytes(value, options = {}) {
  const payloadBytes = Buffer.from(JSON.stringify(value))
  return envelopeForPayloadBytes(payloadBytes, options)
}

function envelopeForPayloadBytes(payloadBytes, options = {}) {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      keyId: options.keyId ?? keyId,
      payload: payloadBytes.toString("base64"),
      signature: (options.signature ?? sign(null, payloadBytes, pair.privateKey)).toString("base64"),
    }),
  )
}

async function fixture(t, bytes, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cudia-updates-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "releases"))
  if (bytes !== undefined) await writeFile(join(dir, "releases", "stable.json"), bytes)
  const server = createUpdateServer({
    releaseDir: join(dir, "releases"),
    publicKeys: options.publicKeys ?? { [keyId]: publicPem },
    now: options.now ?? (() => now),
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  return { dir, base, server }
}

async function get(base, pathname, init) {
  return fetch(`${base}${pathname}`, init)
}

describe("passive update manifest service", () => {
  it("serves exact signed bytes and supports HEAD without a body", async (t) => {
    const bytes = envelopeBytes(payload())
    const { base } = await fixture(t, bytes)
    const response = await get(base, "/updates/v1/stable.json")
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8")
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")

    const head = await get(base, "/updates/v1/stable.json", { method: "HEAD" })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get("content-length"), String(bytes.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  })

  it("separates liveness from stable release readiness", async (t) => {
    const { base } = await fixture(t)
    assert.equal((await get(base, "/health")).status, 200)
    const ready = await get(base, "/ready")
    assert.equal(ready.status, 503)
    assert.equal(await ready.text(), '{"error":"release_unavailable"}')
  })

  it("returns fixed 404 and 405 responses without exposing paths", async (t) => {
    const { base } = await fixture(t, envelopeBytes(payload()))
    const unknown = await get(base, "/../../private-key.pem")
    assert.equal(unknown.status, 404)
    assert.equal(await unknown.text(), '{"error":"not_found"}')
    const method = await get(base, "/updates/v1/stable.json", { method: "POST" })
    assert.equal(method.status, 405)
    assert.equal(method.headers.get("allow"), "GET, HEAD")
    assert.equal(await method.text(), '{"error":"method_not_allowed"}')
  })

  it("rejects untrusted key IDs and invalid Ed25519 signatures", async (t) => {
    const good = payload()
    const untrusted = await fixture(t, envelopeBytes(good, { keyId: "another-key" }))
    assert.equal((await get(untrusted.base, "/updates/v1/stable.json")).status, 503)

    const signature = sign(null, Buffer.from(JSON.stringify(good)), pair.privateKey)
    signature[0] ^= 1
    const invalid = await fixture(t, envelopeBytes(good, { signature }))
    assert.equal((await get(invalid.base, "/updates/v1/stable.json")).status, 503)
  })

  it("rejects expired, future-dated, and wrong-channel releases", async (t) => {
    const cases = [
      payload({ expiresAt: "2026-10-15T11:59:59Z" }),
      payload({ issuedAt: "2026-10-15T12:00:01Z" }),
      payload({ channel: "preview" }),
      payload({ issuedAt: "2026-02-30T11:00:00Z" }),
    ]
    for (const value of cases) {
      const { base } = await fixture(t, envelopeBytes(value))
      assert.equal((await get(base, "/updates/v1/stable.json")).status, 503)
    }
  })

  it("rejects invalid payload structures and duplicate artifact identities", async (t) => {
    const invalid = [
      payload({ sequence: 0 }),
      payload({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      payload({ version: "1.2.3-.." }),
      payload({ version: "1.2.3+build.." }),
      payload({ extra: "unknown top-level field" }),
      payload({ artifacts: [{ ...payload().artifacts[0], url: "http://cyara.com.br/a.exe" }] }),
      payload({ artifacts: [{ ...payload().artifacts[0], url: "https://user:secret@cyara.com.br/a.exe" }] }),
      payload({ artifacts: [{ ...payload().artifacts[0], url: "https://cyara.com.br/a.exe#frag" }] }),
      payload({ artifacts: [{ ...payload().artifacts[0], size: 0 }] }),
      payload({ artifacts: [{ ...payload().artifacts[0], size: 2 * 1024 * 1024 * 1024 + 1 }] }),
      payload({ artifacts: [payload().artifacts[0], payload().artifacts[0]] }),
    ]
    for (const value of invalid) {
      const { base } = await fixture(t, envelopeBytes(value))
      assert.equal((await get(base, "/updates/v1/stable.json")).status, 503)
    }
  })

  it("rejects malformed and oversized envelope files using actual bytes", async (t) => {
    const malformed = await fixture(t, Buffer.from('{"schema":1,"payload":"'))
    assert.equal((await get(malformed.base, "/updates/v1/stable.json")).status, 503)

    const duplicatePayload = Buffer.from(JSON.stringify(payload()).replace('"sequence":1', '"sequence":1,"sequence":2'))
    const duplicated = await fixture(t, envelopeForPayloadBytes(duplicatePayload))
    assert.equal((await get(duplicated.base, "/updates/v1/stable.json")).status, 503)

    const duplicateEnvelopeBytes = envelopeBytes(payload())
    const duplicateEnvelope = await fixture(
      t,
      Buffer.from(duplicateEnvelopeBytes.toString().replace('{"schema":1,', '{"schema":1,"schema":1,')),
    )
    assert.equal((await get(duplicateEnvelope.base, "/updates/v1/stable.json")).status, 503)

    const oversized = await fixture(t, Buffer.alloc(64 * 1024 + 1, 0x20))
    assert.equal((await get(oversized.base, "/updates/v1/stable.json")).status, 503)
  })

  it("rejects unsafe trust key IDs, including inherited-object names", async (t) => {
    const { base } = await fixture(t, envelopeBytes(payload()), { publicKeys: { constructor: publicPem } })
    assert.equal((await get(base, "/updates/v1/stable.json")).status, 503)

    const privateKeyTrust = await fixture(t, envelopeBytes(payload()), { publicKeys: { [keyId]: privatePem } })
    assert.equal((await get(privateKeyTrust.base, "/updates/v1/stable.json")).status, 503)
  })

  it("keeps serving after an invalid raw request target", async (t) => {
    const { base } = await fixture(t)
    const target = new URL(base)
    const rawResponse = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: target.hostname, port: Number(target.port) })
      let received = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        received += chunk
      })
      socket.on("error", reject)
      socket.on("end", () => resolve(received))
      socket.on("connect", () => socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))
    })
    assert.match(rawResponse, /^HTTP\/1\.1 (400|404)/)
    assert.equal((await get(base, "/health")).status, 200)
  })

  it("bounds file and environment trust configuration and requires Ed25519 public keys", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-trust-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const trustPath = join(dir, "trust.json")
    const trust = JSON.stringify({ [keyId]: publicPem })
    const exact = trust + " ".repeat(16 * 1024 - Buffer.byteLength(trust))
    await writeFile(trustPath, exact)
    assert.equal(loadPublicKeys({ trustPath }).size, 1)
    await writeFile(trustPath, exact + " ")
    assert.throws(() => loadPublicKeys({ trustPath }))
    await writeFile(trustPath, "{}")
    assert.throws(() => loadPublicKeys({ trustPath, environmentKeys: exact + " " }))
    assert.throws(() => loadPublicKeys({ trustPath, environmentKeys: '{"key":null,"key":null}' }))
    const extra = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`key-${index}`, publicPem]))
    assert.throws(() => loadPublicKeys({ publicKeys: extra }))
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    assert.throws(() =>
      loadPublicKeys({ publicKeys: { [keyId]: ec.publicKey.export({ type: "spki", format: "pem" }) } }),
    )
  })

  it("publishes only validated, self-verifying envelopes atomically", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-publish-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const input = join(dir, "payload.json")
    const privateKeyFile = join(dir, "signing-key.pem")
    const output = join(dir, "releases", "stable.json")
    await mkdir(join(dir, "releases"))
    const publishable = payload({
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    await writeFile(input, JSON.stringify(publishable))
    await writeFile(privateKeyFile, privatePem, { mode: 0o600 })

    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../publish.js", import.meta.url)),
        "--input",
        input,
        "--output",
        output,
        "--key-id",
        keyId,
      ],
      { env: { ...process.env, CUDIA_RELEASE_PRIVATE_KEY_FILE: privateKeyFile }, encoding: "utf8" },
    )
    assert.equal(cli.status, 0, cli.stderr)
    assert.match(cli.stdout, /Published stable manifest/)
    const published = await publishManifest({ input, output, privateKeyFile, keyId })
    assert.equal(published.channel, "stable")
    const bytes = await readFile(output)
    const { base } = await fixture(t, bytes, { now: () => new Date() })
    assert.equal((await get(base, "/updates/v1/stable.json")).status, 200)

    const before = bytes
    await writeFile(input, JSON.stringify({ ...publishable, version: "not-semver" }))
    await assert.rejects(publishManifest({ input, output, privateKeyFile, keyId }))
    assert.deepEqual(await readFile(output), before)

    await assert.rejects(publishManifest({ input, output: privateKeyFile, privateKeyFile, keyId }))
    assert.equal(await readFile(privateKeyFile, "utf8"), privatePem)

    const failedCli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../publish.js", import.meta.url)),
        "--input",
        input,
        "--output",
        output,
        "--key-id",
        keyId,
      ],
      { env: { ...process.env, CUDIA_RELEASE_PRIVATE_KEY_FILE: privateKeyFile }, encoding: "utf8" },
    )
    assert.equal(failedCli.status, 1)
    assert.doesNotMatch(failedCli.stderr, /BEGIN PRIVATE KEY/)
    assert.match(failedCli.stderr, /Publish failed/)

    const importOnly = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../publish.js", import.meta.url).href)})`],
      { env: { ...process.env, CUDIA_RELEASE_PRIVATE_KEY_FILE: "" }, encoding: "utf8" },
    )
    assert.equal(importOnly.status, 0, importOnly.stderr)
  })
})
