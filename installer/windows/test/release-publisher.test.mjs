import assert from "node:assert/strict"
import { generateKeyPairSync, createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import { loadPublicKeys, validateEnvelope } from "../../../deploy/updates/lib/manifest.js"
import { fetchGithubAssetStream, preflightRelease, publishRelease, stageRelease, validateServicePublication } from "../release.mjs"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cudia-release-publisher-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pair = generateKeyPairSync("ed25519")
  const privateKeyFile = join(directory, "release-private.pem")
  const publicKeysFile = join(directory, "trusted-keys.json")
  await writeFile(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }))
  await writeFile(publicKeysFile, JSON.stringify({ "release-test": pair.publicKey.export({ type: "spki", format: "pem" }).toString() }))
  const channel = "preview"
  const version = "1.2.3-preview.7"
  const sequence = 7
  const sourceCommit = "a".repeat(40)
  const artifacts = []
  for (const kind of ["archive", "installer"]) {
    for (const variant of ["normal", "baseline"]) {
      const bytes = Buffer.from(`${kind}-${variant}-contents`)
      const path = join(directory, `${kind}-${variant}.${kind === "archive" ? "zip" : "exe"}`)
      const receiptFile = join(directory, `${kind}-${variant}-receipt.json`)
      await writeFile(path, bytes)
      const receipt = kind === "archive"
        ? { path, channel, version, sequence, variant, size: bytes.length, sha256: digest(bytes) }
        : {
            schema: 1,
            completed: true,
            compiled: true,
            developerArtifact: false,
            channel,
            version,
            sequence,
            variant,
            releaseId: `seq-${sequence}-${digest(artifacts.find((item) => item.kind === "archive" && item.variant === variant).bytes)}`,
            trust: { trustedKeys: 1 },
            installer: { path, size: bytes.length, sha256: digest(bytes) },
            sources: { "bundle.zip": digest(artifacts.find((item) => item.kind === "archive" && item.variant === variant).bytes) },
          }
      await writeFile(receiptFile, JSON.stringify(receipt))
      artifacts.push({ kind, variant, path, receiptFile, bytes })
    }
  }
  const qualificationFile = join(directory, "qualification.json")
  await writeFile(qualificationFile, JSON.stringify({
    schema: 1,
    status: "qualified",
    channel,
    version,
    sequence,
    sourceCommit,
    artifacts: artifacts.map(({ kind, variant, bytes }) => ({ kind, variant, size: bytes.length, sha256: digest(bytes) })),
    gates: [{ name: "windows-install-qualification", passed: true }],
  }))
  const ledgerFile = join(directory, "release-ledger.json")
  const older = { channel, sequence: 6, version: "1.2.2", state: "published-active-preview", unknownHistoricalField: "kept" }
  const reserved = { channel, sequence, version, state: "reserved", reservedAt: new Date().toISOString(), keyId: "release-test", purpose: "preview", artifactDirectory: directory }
  await writeFile(ledgerFile, JSON.stringify({ schema: 1, releases: [older, reserved] }))
  const notesFile = join(directory, "notes.md")
  await writeFile(notesFile, "Preview release notes")
  const plan = {
    schema: 1,
    product: "cudia",
    repository: "victorccronemberger-blip/cudia",
    channel,
    version,
    sequence,
    tag: "cudia-preview-20261016-seq7",
    sourceCommit,
    title: "CUDIA Preview 1.2.3-preview.7",
    notesFile,
    keyId: "release-test",
    privateKeyFile,
    publicKeysFile,
    ledgerFile,
    journalFile: join(directory, "publish-journal.json"),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    service: { branch: "codex/update-service", expectedParent: "b".repeat(40) },
    qualificationFile,
    artifacts: artifacts.map(({ kind, variant, path, receiptFile }) => ({ kind, variant, path, receiptFile })),
  }
  const planPath = join(directory, "release-plan.json")
  await writeFile(planPath, JSON.stringify(plan))
  return { directory, plan, planPath, artifacts, ledgerFile, publicKeysFile, pair }
}

function adapters(fixture, options = {}) {
  const events = []
  const uploaded = new Map()
  for (const artifact of options.prepopulate ?? []) uploaded.set(`${artifact.kind}-${artifact.variant}.${artifact.kind === "archive" ? "zip" : "exe"}`, { id: uploaded.size + 1, bytes: artifact.bytes })
  const github = {
    async findOrCreateDraft(release) {
      events.push("draft")
      assert.equal(release.sourceCommit, fixture.plan.sourceCommit)
      assert.equal(release.channel, fixture.plan.channel)
      assert.equal(release.repository, fixture.plan.repository)
      assert.equal(release.tag, fixture.plan.tag)
      return { id: 91, upload_url: "https://uploads.github.com/repos/victorccronemberger-blip/cudia/releases/91/assets{?name,label}", draft: options.published !== true }
    },
    async findAsset(_releaseId, name) {
      events.push(`find:${name}`)
      const entry = uploaded.get(name)
      if (!entry) return undefined
      return { id: entry.id, name }
    },
    async uploadAsset(_release, name, path) {
      events.push(`upload:${name}`)
      if (options.uploadMutation) await options.uploadMutation(path)
      uploaded.set(name, { id: uploaded.size + 1, bytes: await readFile(path) })
    },
    async downloadAsset(_releaseId, assetId) {
      events.push(`private-download:${assetId}`)
      const entry = [...uploaded.values()].find((item) => item.id === assetId)
      return Readable.from(entry.bytes)
    },
    async downloadPublic(url) {
      events.push(`public-download:${url}`)
      if (options.publicFailure) throw new Error("public_download_failed")
      const name = decodeURIComponent(url.split("/").at(-1))
      return Readable.from(uploaded.get(name)?.bytes ?? Buffer.alloc(0))
    },
    async publish() { events.push("publish-release") },
  }
  let active
  const service = {
    async assertTrust({ envelope, channel }) {
      events.push("assert-trust")
      validateEnvelope(envelope, new Map([["release-test", fixture.pair.publicKey]]), channel)
      if (options.trustFailure) throw new Error("service_trust_rejected")
    },
    async activate({ envelope }) { events.push("activate"); active = envelope },
    async readActive(channel) {
      events.push("read-active")
      if (options.readActive) return options.readActive({ active, channel })
      return active
    },
  }
  return { adapters: { github, service, activationTimeoutMs: options.activationTimeoutMs, activationPollMs: options.activationPollMs, now: options.now, sleep: options.sleep }, events, uploaded, get active() { return active } }
}

test("publisher verifies assets before activation and records the reservation without discarding ledger history", async (t) => {
  const fixtureData = await fixture(t)
  const fake = adapters(fixtureData)
  const result = await publishRelease(fixtureData.planPath, fake.adapters)
  assert.equal(result.sequence, 7)
  assert.equal(fake.events.at(-2), "activate")
  assert.equal(fake.events.at(-1), "read-active")
  assert.ok(fake.events.indexOf("publish-release") < fake.events.findIndex((event) => event.startsWith("public-download:")))
  const ledger = JSON.parse(await readFile(fixtureData.ledgerFile, "utf8"))
  assert.equal(ledger.releases[0].unknownHistoricalField, "kept")
  assert.equal(ledger.releases[0].state, "published-superseded-preview")
  const payload = validateEnvelope(fake.active, new Map([["release-test", fixtureData.pair.publicKey]]), "preview").payload
  assert.equal(payload.artifacts.length, 4)
})

test("stage accepts pending qualification, uploads only to a draft, and never signs or activates", async (t) => {
  const fixtureData = await fixture(t)
  const qualification = JSON.parse(await readFile(fixtureData.plan.qualificationFile, "utf8"))
  qualification.status = "pending"
  await writeFile(fixtureData.plan.qualificationFile, JSON.stringify(qualification))
  await writeFile(fixtureData.plan.privateKeyFile, "not a private key; staging must not read it")
  const fake = adapters(fixtureData)
  const result = await stageRelease(fixtureData.planPath, fake.adapters.github)
  assert.equal(result.draft, true)
  assert.equal(result.notActivated, true)
  assert.equal(result.assets.length, 4)
  assert.equal(JSON.parse(await readFile(fixtureData.plan.journalFile, "utf8")).state, "assets-staged")
  assert.equal(fake.events.includes("publish-release"), false)
  assert.equal(fake.events.includes("assert-trust"), false)
  assert.equal(fake.events.includes("activate"), false)
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /qualification_invalid/)
  assert.equal(fake.events.includes("assert-trust"), false)
})

test("stage refuses to add a missing asset to an already published release", async (t) => {
  const fixtureData = await fixture(t)
  const fake = adapters(fixtureData, { prepopulate: fixtureData.artifacts.slice(1), published: true })
  await assert.rejects(stageRelease(fixtureData.planPath, fake.adapters.github), /published_release_asset_missing/)
  assert.equal(fake.events.some((event) => event.startsWith("upload:")), false)
})

test("failed public download leaves the update service untouched", async (t) => {
  const fixtureData = await fixture(t)
  const fake = adapters(fixtureData, { publicFailure: true })
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /public_download_failed/)
  assert.equal(fake.events.includes("activate"), false)
})

test("existing asset bytes are checked and never replaced", async (t) => {
  const fixtureData = await fixture(t)
  const fake = adapters(fixtureData)
  const first = fixtureData.artifacts[0]
  fake.uploaded.set(`${first.kind}-${first.variant}.${first.kind === "archive" ? "zip" : "exe"}`, { id: 404, bytes: Buffer.from("tampered") })
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /asset_size_mismatch|asset_hash_mismatch/)
  assert.equal(fake.events.some((event) => event.startsWith("upload:")), false)
  assert.equal(fake.events.includes("activate"), false)
})

test("an artifact changed after preflight cannot be uploaded or activated", async (t) => {
  const fixtureData = await fixture(t)
  const fake = adapters(fixtureData, { uploadMutation: (path) => writeFile(path, "changed-after-preflight") })
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /asset_size_mismatch|asset_hash_mismatch/)
  assert.equal(fake.events.includes("activate"), false)
})

test("preflight refuses an already published or unreserved sequence", async (t) => {
  const fixtureData = await fixture(t)
  const ledger = JSON.parse(await readFile(fixtureData.ledgerFile, "utf8"))
  ledger.releases[1].state = "published-active-preview"
  await writeFile(fixtureData.ledgerFile, JSON.stringify(ledger))
  await assert.rejects(preflightRelease(fixtureData.planPath), /sequence_not_reserved|sequence_reuse_or_rollback/)
})

test("an untrusted signing key fails before any remote release operation", async (t) => {
  const fixtureData = await fixture(t)
  await writeFile(fixtureData.publicKeysFile, "{}")
  const fake = adapters(fixtureData)
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /untrusted_key/)
  assert.deepEqual(fake.events, [])
})

test("published assets resume without replacement, while a missing asset blocks mutation", async (t) => {
  const fixtureData = await fixture(t)
  const existing = adapters(fixtureData, { prepopulate: fixtureData.artifacts, published: true })
  await publishRelease(fixtureData.planPath, existing.adapters)
  assert.equal(existing.events.some((event) => event.startsWith("upload:")), false)

  const incompleteFixture = await fixture(t)
  const incomplete = adapters(incompleteFixture, { prepopulate: incompleteFixture.artifacts.slice(1), published: true })
  await assert.rejects(publishRelease(incompleteFixture.planPath, incomplete.adapters), /published_release_asset_missing/)
  assert.equal(incomplete.events.some((event) => event.startsWith("upload:")), false)
  assert.equal(incomplete.events.includes("activate"), false)
})

test("a retry resumes after Git activation but before endpoint propagation", async (t) => {
  const fixtureData = await fixture(t)
  let firstRead = true
  const fake = adapters(fixtureData, {
    activationTimeoutMs: 0,
    readActive: async ({ active }) => {
      if (firstRead) {
        firstRead = false
        throw new Error("temporary 503")
      }
      return active
    },
  })
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /active_manifest_unavailable/)
  assert.ok(fake.active)
  assert.equal(JSON.parse(await readFile(fixtureData.plan.journalFile, "utf8")).state, "activation-pending")
  const ledgerBeforeRetry = JSON.parse(await readFile(fixtureData.ledgerFile, "utf8"))
  assert.equal(ledgerBeforeRetry.releases[1].state, "reserved")
  fake.adapters.activationTimeoutMs = 10
  const result = await publishRelease(fixtureData.planPath, fake.adapters)
  assert.equal(result.sequence, 7)
  assert.equal(fake.events.filter((event) => event === "assert-trust").length, 2)
  assert.equal(JSON.parse(await readFile(fixtureData.plan.journalFile, "utf8")).state, "active")
  const ledgerAfterRetry = JSON.parse(await readFile(fixtureData.ledgerFile, "utf8"))
  assert.equal(ledgerAfterRetry.releases[1].state, "published-active-preview")
})

test("changed service parent is accepted only when its trusted manifest bytes already match", async (t) => {
  const fixtureData = await fixture(t)
  const fake = adapters(fixtureData)
  const payload = { schema: 1, product: "cudia", channel: "preview", sequence: 7, version: "1.2.3-preview.7", issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), artifacts: [{ kind: "archive", platform: "windows", arch: "x64", variant: "normal", url: "https://github.com/a/b/releases/download/x/a.zip", size: 1, sha256: "a".repeat(64) }] }
  const { signManifest } = await import("../release.mjs")
  const envelope = signManifest(payload, "release-test", await readFile(join(fixtureData.directory, "release-private.pem")), loadPublicKeys({ trustPath: fixtureData.publicKeysFile }))
  const serviceKeys = JSON.parse(await readFile(fixtureData.publicKeysFile, "utf8"))
  assert.doesNotThrow(() => validateServicePublication({ remoteHash: "c".repeat(40), expectedParent: "b".repeat(40), activeManifest: envelope, serviceKeys, envelope, channel: "preview" }))
  assert.throws(() => validateServicePublication({ remoteHash: "c".repeat(40), expectedParent: "b".repeat(40), activeManifest: Buffer.from("different"), serviceKeys, envelope, channel: "preview" }), /service_parent_changed/)
  assert.throws(() => validateServicePublication({ remoteHash: "c".repeat(40), expectedParent: "b".repeat(40), activeManifest: envelope, serviceKeys: {}, envelope, channel: "preview" }), /untrusted_key/)
  assert.equal(fake.events.length, 0)
})

test("preflight rejects duplicate public asset names and a tag for another channel", async (t) => {
  const fixtureData = await fixture(t)
  fixtureData.plan.artifacts[2].path = fixtureData.plan.artifacts[0].path
  await writeFile(fixtureData.planPath, JSON.stringify(fixtureData.plan))
  await assert.rejects(preflightRelease(fixtureData.planPath), /artifact_set_invalid/)
  fixtureData.plan.artifacts[2].path = fixtureData.artifacts[2].path
  fixtureData.plan.tag = "cudia-stable-seq7"
  await writeFile(fixtureData.planPath, JSON.stringify(fixtureData.plan))
  await assert.rejects(preflightRelease(fixtureData.planPath), /plan_identity_invalid/)
})

test("activation polling retries stale manifests and transient endpoint failures", async (t) => {
  const fixtureData = await fixture(t)
  let reads = 0
  let tick = 0
  const fake = adapters(fixtureData, {
    activationTimeoutMs: 10,
    activationPollMs: 1,
    now: () => tick,
    sleep: async () => { tick++ },
    readActive: async ({ active }) => {
      reads++
      if (reads === 1) throw new Error("503")
      if (reads === 2) return Buffer.from("old manifest")
      return active
    },
  })
  await publishRelease(fixtureData.planPath, fake.adapters)
  assert.equal(reads, 3)
})

test("publisher refuses a stale ledger lock without contacting adapters", async (t) => {
  const fixtureData = await fixture(t)
  await writeFile(`${fixtureData.ledgerFile}.publisher.lock`, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }))
  const fake = adapters(fixtureData)
  await assert.rejects(publishRelease(fixtureData.planPath, fake.adapters), /publisher_lock_exists/)
  assert.deepEqual(fake.events, [])
})

test("GitHub asset redirects stay HTTPS and on the exact asset host allowlist", async () => {
  const requests = []
  const stream = await fetchGithubAssetStream(new URL("https://github.com/owner/repo/releases/download/v/a.zip"), async (url, options) => {
    requests.push({ url: url.href, options })
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/a.zip" } })
    return new Response("verified bytes", { status: 200 })
  })
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), "verified bytes")
  assert.equal(requests[1].options.headers, undefined)
  await assert.rejects(fetchGithubAssetStream(new URL("https://github.com/owner/repo/releases/download/v/a.zip"), async () => new Response(null, { status: 302, headers: { location: "http://evil.example/file" } })), /asset_url_rejected/)
})
