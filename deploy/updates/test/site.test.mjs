import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUpdateServer } from "../app.js"
import { renderHome } from "../lib/site.js"

const now = new Date("2026-10-16T12:00:00.000Z")
const keyId = "site-test-key"
const keyPair = generateKeyPairSync("ed25519")
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" })

function payload(channel, overrides = {}) {
  return {
    schema: 1,
    product: "cudia",
    channel,
    sequence: channel === "stable" ? 4 : 6,
    version: channel === "stable" ? "1.17.0+cudia.stable" : "1.18.35+cudia.preview",
    issuedAt: "2026-10-16T11:00:00Z",
    expiresAt: "2026-10-17T12:00:00Z",
    artifacts: [
      {
        kind: "archive",
        platform: "windows",
        arch: "x64",
        variant: "normal",
        url: `https://cyara.com.br/releases/${channel}-normal.zip`,
        size: 1024,
        sha256: "a".repeat(64),
      },
      {
        kind: "archive",
        platform: "windows",
        arch: "x64",
        variant: "baseline",
        url: `https://cyara.com.br/releases/${channel}-baseline.zip`,
        size: 2048,
        sha256: "b".repeat(64),
      },
      ...(channel === "stable"
        ? [
            {
              kind: "installer",
              platform: "windows",
              arch: "x64",
              variant: "normal",
              url: "https://cyara.com.br/releases/stable-installer.exe",
              size: 4096,
              sha256: "c".repeat(64),
            },
          ]
        : []),
    ],
    ...overrides,
  }
}

function envelope(value) {
  const payloadBytes = Buffer.from(JSON.stringify(value))
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      keyId,
      payload: payloadBytes.toString("base64"),
      signature: sign(null, payloadBytes, keyPair.privateKey).toString("base64"),
    }),
  )
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cudia-site-"))
  const releaseDir = join(directory, "releases")
  await mkdir(releaseDir)
  await writeFile(join(releaseDir, "stable.json"), overrides.stable ?? envelope(payload("stable")))
  await writeFile(join(releaseDir, "preview.json"), overrides.preview ?? envelope(payload("preview")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createUpdateServer({ releaseDir, publicKeys: { [keyId]: publicKey }, now: () => now })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
  return { base: `http://127.0.0.1:${server.address().port}` }
}

describe("public download site", () => {
  it("renders signed channel versions, separates installer from update archive, and supports HEAD", async (t) => {
    const { base } = await fixture(t)
    const response = await fetch(`${base}/`)
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /text\/html; charset=utf-8/)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/)
    assert.match(html, /Estável/)
    assert.match(html, /Preview/)
    assert.match(html, /Runtime 1\.18\.35\+cudia\.preview/)
    assert.match(html, /Baixar instalador/)
    assert.match(html, /Instalador ainda não publicado neste canal/)
    assert.match(html, /Pacote ZIP/)
    assert.match(html, /cudia update/)
    assert.match(html, /Windows x64/)
    assert.match(html, /não é necessário instalar Node\.js, Bun ou Git/)
    assert.doesNotMatch(html, /https?:\/\/(?!cyara\.com\.br)/)

    const head = await fetch(`${base}/`, { method: "HEAD" })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(html)))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  })

  it("redirects only to the exact artifact selected from the validated signed manifest", async (t) => {
    const { base } = await fixture(t)
    const cases = [
      ["stable", "normal", "installer", "https://cyara.com.br/releases/stable-installer.exe"],
      ["stable", "baseline", "archive", "https://cyara.com.br/releases/stable-baseline.zip"],
      ["preview", "normal", "archive", "https://cyara.com.br/releases/preview-normal.zip"],
      ["preview", "baseline", "archive", "https://cyara.com.br/releases/preview-baseline.zip"],
    ]
    for (const [channel, variant, kind, location] of cases) {
      const response = await fetch(`${base}/download/windows?channel=${channel}&variant=${variant}&kind=${kind}`, {
        redirect: "manual",
      })
      assert.equal(response.status, 307)
      assert.equal(response.headers.get("location"), location)
      assert.equal(response.headers.get("cache-control"), "no-store")
    }
    const head = await fetch(`${base}/download/windows?channel=preview&variant=normal&kind=archive`, {
      method: "HEAD",
      redirect: "manual",
    })
    assert.equal(head.status, 307)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  })

  it("does not resolve missing artifacts, malformed selection, or arbitrary redirect targets", async (t) => {
    const { base } = await fixture(t)
    const paths = [
      "/download/windows?channel=preview&kind=installer",
      "/download/windows?channel=preview&kind=archive&variant=unknown",
      "/download/windows?channel=preview&kind=archive&variant=normal&url=https%3A%2F%2Fevil.example",
      "/download/windows?channel=preview&channel=stable&kind=archive",
    ]
    for (const path of paths) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" })
      assert.equal(response.status, 404)
      assert.equal(await response.text(), '{"error":"release_artifact_unavailable"}')
      assert.equal(response.headers.get("location"), null)
    }
  })

  it("never redirects from expired or tampered release metadata", async (t) => {
    const expired = payload("preview", { expiresAt: "2026-10-16T11:59:59Z" })
    const expiredFixture = await fixture(t, { preview: envelope(expired) })
    const expiredResponse = await fetch(
      `${expiredFixture.base}/download/windows?channel=preview&variant=normal&kind=archive`,
      { redirect: "manual" },
    )
    assert.equal(expiredResponse.status, 503)
    assert.equal(expiredResponse.headers.get("location"), null)

    const tampered = envelope(payload("preview"))
    tampered[tampered.length - 3] ^= 1
    const tamperedFixture = await fixture(t, { preview: tampered })
    const response = await fetch(
      `${tamperedFixture.base}/download/windows?channel=preview&variant=normal&kind=archive`,
      { redirect: "manual" },
    )
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("location"), null)
  })

  it("escapes dynamic text when rendering site copy", () => {
    const html = renderHome({
      stable: undefined,
      preview: payload("preview", { version: `1.2.3+<script>alert(1)</script>` }),
    })
    assert.doesNotMatch(html, /<script>alert/)
  })
})
