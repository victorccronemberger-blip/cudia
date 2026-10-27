import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto"
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadPublicKeys, validateEnvelope } from "../../deploy/updates/lib/manifest.js"

const REPOSITORY = "victorccronemberger-blip/cudia"
const GITHUB_ASSET_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"])
const GITHUB_UPLOAD_HOST = "uploads.github.com"
const GITHUB_RELEASE_DISCOVERY_MAX_PAGES = 10
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export async function preflightRelease(planPath) {
  const plan = await readPlan(planPath)
  const release = await inspectRelease(plan)
  return { channel: plan.channel, version: plan.version, sequence: plan.sequence, tag: plan.tag, artifacts: release.artifacts.map(({ kind, variant, size, sha256 }) => ({ kind, variant, size, sha256 })) }
}

export async function publishRelease(planPath, adapters) {
  const plan = await readPlan(planPath)
  if (!adapters?.github || !adapters?.service || typeof adapters.service.assertTrust !== "function") throw new Error("publisher_adapters_required")
  return withPublisherLocks(plan, () => publishPrepared(plan, adapters))
}

export async function stageRelease(planPath, github) {
  const plan = await readPlan(planPath, { allowPendingQualification: true })
  if (!github || typeof github.findOrCreateDraft !== "function") throw new Error("publisher_adapters_required")
  return withPublisherLocks(plan, async () => {
    const release = await inspectRelease(plan, { requireQualification: false })
    const journal = await readJournal(plan.journalFile, release.identity)
    const record = await github.findOrCreateDraft({
      repository: REPOSITORY,
      tag: plan.tag,
      title: plan.title,
      notes: await readFile(plan.notesFile, "utf8"),
      sourceCommit: plan.sourceCommit,
      channel: plan.channel,
      releaseId: journal.releaseId,
    })
    if (!record || !Number.isSafeInteger(record.id) || record.id < 1) throw new Error("draft_release_invalid")
    const staged = []
    await saveJournal(plan.journalFile, { ...journal, state: "staging-assets", releaseId: record.id, tag: plan.tag })
    for (const artifact of release.artifacts) {
      let asset = await github.findAsset(record.id, artifact.name)
      if (!asset) {
        if (record.draft === false) throw new Error("published_release_asset_missing")
        await github.uploadAsset(record, artifact.name, artifact.path, artifact.size)
        asset = await github.findAsset(record.id, artifact.name)
        if (!asset) throw new Error("uploaded_asset_missing")
      }
      await verifyAssetStream(await github.downloadAsset(record.id, asset.id), artifact)
      staged.push({ id: asset.id, kind: artifact.kind, variant: artifact.variant, name: artifact.name, size: artifact.size, sha256: artifact.sha256, url: artifact.url })
      await saveJournal(plan.journalFile, { ...journal, state: "staging-assets", releaseId: record.id, tag: plan.tag, assets: staged })
    }
    await saveJournal(plan.journalFile, { ...journal, state: "assets-staged", releaseId: record.id, tag: plan.tag, assets: staged })
    return { tag: plan.tag, releaseId: record.id, draft: record.draft !== false, notActivated: true, assets: staged }
  })
}

async function withPublisherLocks(plan, action) {
  const locks = []
  try {
    locks.push(await acquireLock(`${plan.ledgerFile}.publisher.lock`))
    locks.push(await acquireLock(`${plan.journalFile}.lock`))
    return await action()
  } finally {
    for (const lock of locks.reverse()) {
      await lock.handle.close()
      await unlink(lock.path).catch(() => {})
    }
  }
}

async function publishPrepared(plan, adapters) {
  if (!adapters?.github || !adapters?.service) throw new Error("publisher_adapters_required")
  const release = await inspectRelease(plan)
  const journalPath = plan.journalFile
  const journal = await readJournal(journalPath, release.identity)
  const payload = {
    schema: 1,
    product: "cudia",
    channel: plan.channel,
    sequence: plan.sequence,
    version: plan.version,
    issuedAt: plan.issuedAt,
    expiresAt: plan.expiresAt,
    artifacts: release.artifacts.map((item) => ({ kind: item.kind, platform: "windows", arch: "x64", variant: item.variant, url: item.url, size: item.size, sha256: item.sha256 })),
  }
  const trustedKeys = loadPublicKeys({ trustPath: plan.publicKeysFile })
  const envelope = signManifest(payload, plan.keyId, await readFile(plan.privateKeyFile), trustedKeys)
  await adapters.service.assertTrust({ branch: plan.service.branch, expectedParent: plan.service.expectedParent, channel: plan.channel, envelope })
  const record = await adapters.github.findOrCreateDraft({ repository: REPOSITORY, tag: plan.tag, title: plan.title, notes: await readFile(plan.notesFile, "utf8"), sourceCommit: plan.sourceCommit, channel: plan.channel, releaseId: journal.releaseId })
  await saveJournal(journalPath, { ...journal, state: "draft", releaseId: record.id, tag: plan.tag })

  for (const artifact of release.artifacts) {
    const asset = await adapters.github.findAsset(record.id, artifact.name)
    if (asset) {
      await verifyAssetStream(await adapters.github.downloadAsset(record.id, asset.id), artifact)
      continue
    }
    if (record.draft === false) throw new Error("published_release_asset_missing")
    await adapters.github.uploadAsset(record, artifact.name, artifact.path, artifact.size)
    const uploaded = await adapters.github.findAsset(record.id, artifact.name)
    if (!uploaded) throw new Error("uploaded_asset_missing")
    await verifyAssetStream(await adapters.github.downloadAsset(record.id, uploaded.id), artifact)
  }
  await saveJournal(journalPath, { ...journal, state: "assets-verified", releaseId: record.id, tag: plan.tag })
  await adapters.github.publish(record.id)

  for (const artifact of release.artifacts) await verifyAssetStream(await adapters.github.downloadPublic(artifact.url), artifact)
  await saveJournal(journalPath, { ...journal, state: "public-assets-verified", releaseId: record.id, tag: plan.tag, manifestSha256: hash(envelope) })
  await saveJournal(journalPath, { ...journal, state: "activation-pending", releaseId: record.id, tag: plan.tag, manifestSha256: hash(envelope) })
  await adapters.service.activate({ branch: plan.service.branch, expectedParent: plan.service.expectedParent, channel: plan.channel, envelope })
  await waitForActive(adapters, plan.channel, envelope, trustedKeys)
  await updateLedger(plan, release.identity, release.artifacts)
  await saveJournal(journalPath, { ...journal, state: "active", releaseId: record.id, tag: plan.tag, manifestSha256: hash(envelope) })
  return { channel: plan.channel, version: plan.version, sequence: plan.sequence, tag: plan.tag, manifestSha256: hash(envelope), artifacts: release.artifacts.length }
}

export function signManifest(payload, keyId, privateKeyBytes, publicKeys) {
  const key = createPrivateKey(privateKeyBytes)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("key_invalid")
  const payloadBytes = Buffer.from(JSON.stringify(payload))
  const envelope = Buffer.from(JSON.stringify({ schema: 1, keyId, payload: payloadBytes.toString("base64"), signature: sign(null, payloadBytes, key).toString("base64") }))
  validateEnvelope(envelope, publicKeys, payload.channel)
  return envelope
}

export function validateServicePublication({ remoteHash, expectedParent, activeManifest, serviceKeys, envelope, channel }) {
  validateEnvelope(envelope, loadPublicKeys({ publicKeys: serviceKeys }), channel)
  if (remoteHash !== expectedParent && (!Buffer.isBuffer(activeManifest) || !activeManifest.equals(envelope))) throw new Error("service_parent_changed")
}

async function waitForActive(adapters, channel, expected, trustedKeys) {
  const timeoutMs = adapters.activationTimeoutMs ?? 120000
  const intervalMs = adapters.activationPollMs ?? 2000
  const now = adapters.now ?? Date.now
  const sleep = adapters.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)))
  const deadline = now() + timeoutMs
  let lastMismatch = false
  while (true) {
    try {
      const active = await adapters.service.readActive(channel)
      if (Buffer.isBuffer(active) && active.equals(expected)) {
        validateEnvelope(active, trustedKeys, channel)
        return active
      }
      lastMismatch = true
    } catch {
      lastMismatch = false
    }
    const remaining = deadline - now()
    if (remaining <= 0) throw new Error(lastMismatch ? "active_manifest_mismatch" : "active_manifest_unavailable")
    await sleep(Math.min(intervalMs, remaining))
  }
}

async function readPlan(planPath, { allowPendingQualification = false } = {}) {
  if (typeof planPath !== "string" || !isAbsolute(planPath)) throw new Error("plan_path_must_be_absolute")
  const path = await assertRegularLocalFile(planPath)
  const plan = JSON.parse(await readFile(path, "utf8"))
  const required = ["schema", "product", "repository", "channel", "version", "sequence", "tag", "sourceCommit", "title", "notesFile", "keyId", "privateKeyFile", "publicKeysFile", "ledgerFile", "journalFile", "issuedAt", "expiresAt", "service", "qualificationFile", "artifacts"]
  if (!plan || Array.isArray(plan) || typeof plan !== "object" || Object.keys(plan).sort().join("\0") !== required.sort().join("\0")) throw new Error("plan_shape_invalid")
  if (plan.schema !== 1 || plan.product !== "cudia" || plan.repository !== REPOSITORY || !["stable", "preview"].includes(plan.channel) || !SEMVER.test(plan.version) || !Number.isSafeInteger(plan.sequence) || plan.sequence < 1 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(plan.sourceCommit) || typeof plan.tag !== "string" || !plan.tag.startsWith(`cudia-${plan.channel}-`) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan.tag) || typeof plan.keyId !== "string" || plan.keyId.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(plan.keyId)) throw new Error("plan_identity_invalid")
  if (!plan.service || Object.keys(plan.service).sort().join("\0") !== ["branch", "expectedParent"].sort().join("\0") || !/^codex\/[A-Za-z0-9._/-]{1,100}$/.test(plan.service.branch) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(plan.service.expectedParent)) throw new Error("service_ref_invalid")
  if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 200) throw new Error("plan_title_invalid")
  if (!Array.isArray(plan.artifacts) || plan.artifacts.length < 2 || plan.artifacts.length > 4) throw new Error("artifact_set_invalid")
  const absoluteFields = ["notesFile", "privateKeyFile", "publicKeysFile", "ledgerFile", "journalFile", "qualificationFile"]
  for (const field of absoluteFields) if (typeof plan[field] !== "string" || !isAbsolute(plan[field])) throw new Error("plan_path_invalid")
  for (const artifact of plan.artifacts) if (!artifact || Object.keys(artifact).sort().join("\0") !== ["kind", "variant", "path", "receiptFile"].sort().join("\0") || !["archive", "installer"].includes(artifact.kind) || !["normal", "baseline"].includes(artifact.variant) || !isAbsolute(artifact.path) || !isAbsolute(artifact.receiptFile)) throw new Error("artifact_plan_invalid")
  if (isWithin(CHECKOUT_ROOT, plan.privateKeyFile)) throw new Error("private_key_must_be_outside_checkout")
  await Promise.all([plan.notesFile, plan.privateKeyFile, plan.publicKeysFile, plan.ledgerFile, ...plan.artifacts.flatMap((item) => [item.path, item.receiptFile])].map(assertRegularLocalFile))
  if (allowPendingQualification) {
    try { await assertRegularLocalFile(plan.qualificationFile) } catch (error) { if (error.code !== "ENOENT") throw error }
  } else await assertRegularLocalFile(plan.qualificationFile)
  if (!loadPublicKeys({ trustPath: plan.publicKeysFile }).has(plan.keyId)) throw new Error("untrusted_key")
  if ((await lstat(plan.notesFile)).size > 64 * 1024) throw new Error("release_notes_oversized")
  await assertSafeFileTarget(plan.journalFile)
  const identities = plan.artifacts.map((item) => `${item.kind}:${item.variant}`)
  const installerIdentities = identities.filter((identity) => identity.startsWith("installer:"))
  if (new Set(identities).size !== identities.length || new Set(plan.artifacts.map((item) => basename(item.path))).size !== plan.artifacts.length || !["archive:normal", "archive:baseline"].every((item) => identities.includes(item)) || (installerIdentities.length > 0 && !["installer:normal", "installer:baseline"].every((item) => installerIdentities.includes(item)))) throw new Error("artifact_set_invalid")
  if (!Number.isFinite(Date.parse(plan.issuedAt)) || !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.issuedAt) > Date.now() || Date.parse(plan.expiresAt) <= Date.now() || Date.parse(plan.expiresAt) - Date.parse(plan.issuedAt) > 31 * 86400000) throw new Error("manifest_lifetime_invalid")
  return { ...plan, planFile: path }
}

async function inspectRelease(plan, { requireQualification = true } = {}) {
  const identity = { channel: plan.channel, version: plan.version, sequence: plan.sequence, sourceCommit: plan.sourceCommit, tag: plan.tag }
  const ledger = JSON.parse(await readFile(plan.ledgerFile, "utf8"))
  if (!ledger || ledger.schema !== 1 || !Array.isArray(ledger.releases)) throw new Error("ledger_invalid")
  const rows = ledger.releases.filter((row) => row.channel === plan.channel && row.sequence === plan.sequence)
  if (rows.length !== 1 || rows[0].state !== "reserved" || rows[0].version !== plan.version || rows[0].keyId !== plan.keyId || (rows[0].tag && rows[0].tag !== plan.tag) || (rows[0].sourceCommit && rows[0].sourceCommit !== plan.sourceCommit)) throw new Error("sequence_not_reserved")
  if (rows[0].artifactDirectory && plan.artifacts.some((artifact) => !isWithin(rows[0].artifactDirectory, artifact.path))) throw new Error("artifact_outside_reserved_directory")
  if (ledger.releases.some((row) => row.channel === plan.channel && typeof row.state === "string" && row.state.startsWith("published-") && row.sequence >= plan.sequence)) throw new Error("sequence_reuse_or_rollback")
  const artifacts = []
  for (const item of plan.artifacts) {
    const path = await assertRegularLocalFile(item.path)
    const receipt = JSON.parse(await readFile(await assertRegularLocalFile(item.receiptFile), "utf8"))
    const bytesInfo = await hashFile(path)
    if (bytesInfo.size < 1 || bytesInfo.size > MAX_ARTIFACT_BYTES) throw new Error("artifact_size_invalid")
    if (item.kind === "archive") {
      if (receipt.channel !== plan.channel || receipt.version !== plan.version || receipt.sequence !== plan.sequence || receipt.variant !== item.variant || receipt.size !== bytesInfo.size || receipt.sha256 !== bytesInfo.sha256) throw new Error("archive_receipt_mismatch")
    } else if (receipt.schema !== 1 || receipt.completed !== true || receipt.compiled !== true || receipt.developerArtifact !== false || receipt.channel !== plan.channel || receipt.version !== plan.version || receipt.sequence !== plan.sequence || receipt.variant !== item.variant || receipt.installer?.size !== bytesInfo.size || receipt.installer?.sha256 !== bytesInfo.sha256 || !Number.isSafeInteger(receipt.trust?.trustedKeys) || receipt.trust.trustedKeys < 1) throw new Error("installer_receipt_mismatch")
    artifacts.push({ kind: item.kind, variant: item.variant, path, size: bytesInfo.size, sha256: bytesInfo.sha256, receipt, receiptFile: item.receiptFile, name: basename(path), url: `https://github.com/${REPOSITORY}/releases/download/${plan.tag}/${encodeURIComponent(basename(path))}` })
  }
  for (const installer of artifacts.filter((item) => item.kind === "installer")) {
    const archive = artifacts.find((item) => item.kind === "archive" && item.variant === installer.variant)
    if (installer.receipt.releaseId !== `seq-${plan.sequence}-${archive.sha256}` || installer.receipt.sources?.["bundle.zip"] !== archive.sha256) throw new Error("installer_archive_binding_mismatch")
  }
  if (requireQualification) {
    const qualification = JSON.parse(await readFile(plan.qualificationFile, "utf8"))
    if (qualification.schema !== 1 || qualification.status !== "qualified" || qualification.channel !== plan.channel || qualification.version !== plan.version || qualification.sequence !== plan.sequence || qualification.sourceCommit !== plan.sourceCommit || !Array.isArray(qualification.artifacts)) throw new Error("qualification_invalid")
    for (const artifact of artifacts) {
      const qualified = qualification.artifacts.find((item) => item.kind === artifact.kind && item.variant === artifact.variant)
      if (!qualified || qualified.size !== artifact.size || qualified.sha256 !== artifact.sha256) throw new Error("qualification_artifact_mismatch")
    }
    if (qualification.artifacts.length !== artifacts.length || !Array.isArray(qualification.gates) || qualification.gates.length === 0 || qualification.gates.some((gate) => gate.passed !== true)) throw new Error("qualification_gates_incomplete")
  }
  return { identity, artifacts }
}

async function updateLedger(plan, identity, artifacts) {
  const ledger = JSON.parse(await readFile(plan.ledgerFile, "utf8"))
  const row = ledger.releases.find((item) => item.channel === identity.channel && item.sequence === identity.sequence)
  if (!row || row.state !== "reserved") throw new Error("ledger_reservation_changed")
  for (const previous of ledger.releases) {
    if (previous.channel === identity.channel && previous !== row && previous.state === `published-active-${identity.channel}`) {
      previous.state = `published-superseded-${identity.channel}`
    }
  }
  row.state = `published-active-${identity.channel}`
  row.version = identity.version
  row.tag = identity.tag
  row.sourceCommit = identity.sourceCommit
  row.publicArtifacts = artifacts.map(({ kind, variant, name, size, sha256, url }) => ({ kind, variant, name, size, sha256, url }))
  row.publishedAt = new Date().toISOString()
  await atomicJson(plan.ledgerFile, ledger)
}

async function hashFile(filePath) {
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length
    hash.update(chunk)
    if (size > MAX_ARTIFACT_BYTES) throw new Error("artifact_size_invalid")
  }
  return { size, sha256: hash.digest("hex") }
}

async function verifyAssetStream(stream, expected) {
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > expected.size) throw new Error("asset_size_mismatch")
    hash.update(chunk)
  }
  if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw new Error("asset_hash_mismatch")
}

export async function fetchGithubAssetStream(url, fetchImpl = fetch, timeoutMs = 20 * 60 * 1000) {
  let target = url
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    if (target.protocol !== "https:" || !GITHUB_ASSET_HOSTS.has(target.hostname) || target.port || target.username || target.password) throw new Error("asset_url_rejected")
    const response = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === 5) throw new Error("asset_redirect_limit")
      const location = response.headers.get("location")
      if (!location) throw new Error("asset_redirect_invalid")
      target = new URL(location, target)
      continue
    }
    if (!response.ok || !response.body) throw new Error(`asset_download_${response.status}`)
    return Readable.fromWeb(response.body)
  }
  throw new Error("asset_redirect_limit")
}

async function responseJson(response, maximumBytes = 1024 * 1024) {
  return JSON.parse((await responseBytes(response, maximumBytes)).toString("utf8"))
}

async function responseBytes(response, maximumBytes) {
  if (!response.body) throw new Error("github_response_empty")
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new Error("github_response_oversized")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, size)
}

async function readJournal(path, identity) {
  try {
    const journal = JSON.parse(await readFile(path, "utf8"))
    if (journal.identity !== JSON.stringify(identity)) throw new Error("journal_identity_conflict")
    if (journal.releaseId !== undefined && (!Number.isSafeInteger(journal.releaseId) || journal.releaseId < 1)) throw new Error("journal_release_id_invalid")
    return journal
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { schema: 1, identity: JSON.stringify(identity), state: "preflight" }
  }
}

async function saveJournal(path, journal) {
  await atomicJson(path, journal)
}

async function atomicJson(path, value) {
  await assertSafeFileTarget(path)
  const directory = await realpath(dirname(path))
  const destination = join(directory, basename(path))
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
    await file.close()
    await rename(temporary, destination)
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function acquireLock(path) {
  await assertSafeFileTarget(path)
  try {
    const lock = await open(path, "wx", 0o600)
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    await lock.sync()
    return { handle: lock, path }
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    throw new Error("publisher_lock_exists; verify no publisher is running before removing it")
  }
}

async function assertRegularLocalFile(path) {
  if (!isAbsolute(path)) throw new Error("local_path_required")
  const full = resolve(path)
  let current = full
  while (true) {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error("path_alias_rejected")
    if (current === dirname(current)) break
    current = dirname(current)
  }
  const info = await lstat(full)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("regular_file_required")
  return full
}

async function assertSafeFileTarget(path) {
  if (!isAbsolute(path)) throw new Error("local_path_required")
  const full = resolve(path)
  await realpath(dirname(full))
  let current = dirname(full)
  while (true) {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error("path_alias_rejected")
    if (current === dirname(current)) break
    current = dirname(current)
  }
  try {
    const info = await lstat(full)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("regular_file_required")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

function isWithin(root, path) {
  const value = relative(resolve(root), resolve(path))
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GCM_GUI_PROMPT: "0" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    const stdout = []
    let outputSize = 0
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`command_timeout:${command}`))
    }, options.timeoutMs ?? 30000)
    child.stdout.on("data", (chunk) => {
      if (settled) return
      outputSize += chunk.length
      if (outputSize > (options.maxOutputBytes ?? 1024 * 1024)) {
        settled = true
        clearTimeout(timeout)
        child.kill()
        reject(new Error(`command_output_limit:${command}`))
        return
      }
      stdout.push(chunk)
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`command_start_failed:${command}:${error.code ?? "error"}`))
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`command_failed:${command}`))
        return
      }
      const output = Buffer.concat(stdout)
      resolvePromise(options.raw ? output : output.toString("utf8").trim())
    })
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

async function gitCredential() {
  const response = await run("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", timeoutMs: 15000, maxOutputBytes: 65536, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GCM_GUI_PROMPT: "0" } })
  const token = response.split(/\r?\n/).find((line) => line.startsWith("password="))?.slice(9)
  if (!token) throw new Error("github_credentials_missing")
  return token
}

export function githubAdapter(getToken, request = fetch) {
  const apiResponse = async (method, path, body, headers = {}) => {
    const token = await getToken()
    return request(`https://api.github.com${path}`, { method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body, redirect: "manual", signal: AbortSignal.timeout(30000) })
  }
  const api = async (method, path, body, headers = {}) => {
    const response = await apiResponse(method, path, body, headers)
    if (!response.ok) throw new Error(`github_api_${response.status}`)
    return response.status === 204 ? undefined : responseJson(response)
  }
  const validateIdentity = (release, { tag, title, notes, sourceCommit, channel }) => {
    if (!release || !Number.isSafeInteger(release.id) || release.id < 1 || release.tag_name !== tag || release.target_commitish !== sourceCommit || release.name !== title || release.body !== notes || release.prerelease !== (channel === "preview") || typeof release.draft !== "boolean") throw new Error("release_identity_conflict")
    return release
  }
  const discoverByTag = async (repository, identity) => {
    const matches = []
    for (let page = 1; page <= GITHUB_RELEASE_DISCOVERY_MAX_PAGES; page++) {
      const response = await apiResponse("GET", `/repos/${repository}/releases?per_page=100&page=${page}`)
      if (!response.ok) throw new Error(`github_api_${response.status}`)
      const releases = await responseJson(response)
      if (!Array.isArray(releases)) throw new Error("github_release_discovery_invalid")
      matches.push(...releases.filter((release) => release?.tag_name === identity.tag))
      const hasNext = /<[^>]+>\s*;\s*rel="next"/.test(response.headers.get("link") ?? "")
      if (!hasNext) {
        if (matches.length > 1) throw new Error("github_release_ambiguous")
        return matches.length === 1 ? validateIdentity(matches[0], identity) : undefined
      }
    }
    throw new Error("github_release_discovery_incomplete")
  }
  const validateOrFind = async (path, identity, expectedId) => {
    const response = await apiResponse("GET", path)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`github_api_${response.status}`)
    const release = validateIdentity(await responseJson(response), identity)
    if (expectedId !== undefined && release.id !== expectedId) throw new Error("release_identity_conflict")
    return release
  }
  return {
    async findOrCreateDraft({ repository, tag, title, notes, sourceCommit, channel, releaseId }) {
      const identity = { tag, title, notes, sourceCommit, channel }
      if (releaseId !== undefined) {
        if (!Number.isSafeInteger(releaseId) || releaseId < 1) throw new Error("release_identity_conflict")
        const journaled = await validateOrFind(`/repos/${repository}/releases/${releaseId}`, identity, releaseId)
        if (journaled) return journaled
      }
      const tagged = await validateOrFind(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, identity)
      if (tagged) return tagged
      const discovered = await discoverByTag(repository, identity)
      if (discovered) return discovered
      try {
        const created = await api("POST", `/repos/${repository}/releases`, JSON.stringify({ tag_name: tag, target_commitish: sourceCommit, name: title, body: notes, draft: true, prerelease: channel === "preview" }))
        return validateIdentity(created, identity)
      } catch (error) {
        const raced = await discoverByTag(repository, identity)
        if (raced) return raced
        throw error
      }
    },
    async findAsset(releaseId, name) {
      const response = await api("GET", `/repos/${REPOSITORY}/releases/${releaseId}/assets?per_page=100`)
      return response.find((asset) => asset.name === name)
    },
    async uploadAsset(release, name, filePath, size) {
      const token = await getToken()
      const url = new URL(release.upload_url.replace(/\{.*$/, ""))
      if (url.protocol !== "https:" || url.hostname !== GITHUB_UPLOAD_HOST || url.port || url.username || url.password || !url.pathname.startsWith(`/repos/${REPOSITORY}/releases/`)) throw new Error("github_upload_url_rejected")
      url.searchParams.set("name", name)
      const response = await request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(size) }, body: Readable.toWeb(createReadStream(filePath)), duplex: "half", redirect: "manual", signal: AbortSignal.timeout(20 * 60 * 1000) })
      if (!response.ok) throw new Error(`github_upload_${response.status}`)
      await response.body?.cancel()
    },
    async downloadAsset(releaseId, assetId) {
      const token = await getToken()
      const response = await request(`https://api.github.com/repos/${REPOSITORY}/releases/assets/${assetId}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" }, redirect: "manual", signal: AbortSignal.timeout(20 * 60 * 1000) })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location")
        if (!location) throw new Error("github_asset_redirect_invalid")
        return fetchGithubAssetStream(new URL(location, response.url), request)
      }
      if (!response.ok || !response.body) throw new Error(`github_asset_download_${response.status}`)
      return Readable.fromWeb(response.body)
    },
    async downloadPublic(url) {
      return fetchGithubAssetStream(new URL(url), request)
    },
    async publish(releaseId) { await api("PATCH", `/repos/${REPOSITORY}/releases/${releaseId}`, JSON.stringify({ draft: false })) },
  }
}

async function serviceAdapter(plan) {
  const repositoryRoot = await run("git", ["rev-parse", "--show-toplevel"])
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: repositoryRoot })
  if (!/(?:github\.com[:/]victorccronemberger-blip\/cudia(?:\.git)?)$/i.test(origin)) throw new Error("service_repository_mismatch")
  return {
    async assertTrust({ branch, expectedParent, channel, envelope }) {
      const remote = await run("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: repositoryRoot })
      await run("git", ["fetch", "--no-tags", "origin", `refs/heads/${branch}`], { cwd: repositoryRoot })
      const serviceKeys = JSON.parse(await run("git", ["show", "FETCH_HEAD:deploy/updates/trust.json"], { cwd: repositoryRoot }))
      const currentHash = remote.split(/\s+/)[0]
      const alreadyActive = currentHash === expectedParent ? undefined : await run("git", ["show", `FETCH_HEAD:deploy/updates/releases/${channel}.json`], { cwd: repositoryRoot, raw: true })
      validateServicePublication({ remoteHash: currentHash, expectedParent, activeManifest: alreadyActive, serviceKeys, envelope, channel })
    },
    async activate({ branch, expectedParent, channel, envelope }) {
      const remote = await run("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: repositoryRoot })
      const remoteHash = remote.split(/\s+/)[0]
      if (remoteHash !== expectedParent) {
        await run("git", ["fetch", "--no-tags", "origin", `refs/heads/${branch}`], { cwd: repositoryRoot })
        const alreadyActive = await run("git", ["show", `FETCH_HEAD:deploy/updates/releases/${channel}.json`], { cwd: repositoryRoot, raw: true })
        if (alreadyActive.equals(envelope)) return
        throw new Error("service_parent_changed")
      }
      const blob = await run("git", ["hash-object", "-w", "--stdin"], { cwd: repositoryRoot, input: envelope })
      const index = join(dirname(plan.ledgerFile), `.cudia-release-index-${process.pid}-${randomUUID()}`)
      const baseEnv = { ...process.env, GIT_INDEX_FILE: index }
      try {
        await run("git", ["read-tree", `${expectedParent}^{tree}`], { cwd: repositoryRoot, env: baseEnv })
        await run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},deploy/updates/releases/${channel}.json`], { cwd: repositoryRoot, env: baseEnv })
        const tree = await run("git", ["write-tree"], { cwd: repositoryRoot, env: baseEnv })
        const commit = await run("git", ["-c", "user.name=Cudia Release Publisher", "-c", "user.email=release@cudia.invalid", "commit-tree", tree, "-p", expectedParent, "-m", `release(${channel}): activate sequence ${plan.sequence}`], { cwd: repositoryRoot, input: "" })
        // The push may run the repository's validation hook before contacting the remote.
        await run("git", ["push", "origin", `${commit}:refs/heads/${branch}`], { cwd: repositoryRoot, timeoutMs: 10 * 60 * 1000 })
        if ((await run("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: repositoryRoot })).split(/\s+/)[0] !== commit) throw new Error("service_push_unconfirmed")
      } finally { await unlink(index).catch(() => {}) }
    },
    async readActive(channel) {
      const response = await fetch(`https://cyara.com.br/updates/v1/${channel}.json`, { signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "manual" })
      if (!response.ok) throw new Error(`service_read_${response.status}`)
      return responseBytes(response, 64 * 1024)
    },
  }
}

async function cli() {
  const [command, planOption, planPath] = process.argv.slice(2)
  if (!["preflight", "stage", "publish"].includes(command) || planOption !== "--plan" || !planPath || process.argv.length !== 5) throw new Error("usage: node release.mjs <preflight|stage|publish> --plan <absolute-file>")
  if (command === "preflight") return preflightRelease(planPath)
  let tokenPromise
  const getToken = () => tokenPromise ??= gitCredential()
  if (command === "stage") return stageRelease(planPath, githubAdapter(getToken))
  const plan = await readPlan(planPath)
  return publishRelease(planPath, { github: githubAdapter(getToken), service: await serviceAdapter(plan) })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await cli()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`Release ${error.message.startsWith("usage:") ? error.message : "failed; inspect the plan, receipts, qualification and local service state."}\n`)
    process.exitCode = 1
  }
}
