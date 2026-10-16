import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { publishManifest } from "../../../deploy/updates/publish.js"

const windowsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

function ps(script, options) {
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(windowsRoot, script),
      ...Object.entries(options).flatMap(([key, value]) => [`-${key}`, value]),
    ],
    { cwd: windowsRoot, encoding: "utf8", timeout: 120_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function run(executable, args, cwd) {
  return spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000 })
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

test(
  "compiled clients support overlapping signing-key rotation and reject retired keys",
  { skip: process.platform !== "win32" || !process.env.CUDIA_GO_PATH, timeout: 600_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-trust-rotation-"))
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

    const sourceTrustPath = join(windowsRoot, "launcher", "internal", "client", "trust.json")
    const sourceTrust = await readFile(sourceTrustPath)
    const keyA = generateKeyPairSync("ed25519")
    const keyB = generateKeyPairSync("ed25519")
    const publicA = keyA.publicKey.export({ type: "spki", format: "pem" })
    const publicB = keyB.publicKey.export({ type: "spki", format: "pem" })
    const publicKeyrings = {
      A: JSON.stringify({ "rotation-a": publicA }),
      AB: JSON.stringify({ "rotation-a": publicA, "rotation-b": publicB }),
      B: JSON.stringify({ "rotation-b": publicB }),
    }
    const privateA = join(dir, "rotation-a-private.pem")
    const privateB = join(dir, "rotation-b-private.pem")
    await Promise.all([
      writeFile(privateA, keyA.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }),
      writeFile(privateB, keyB.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }),
    ])

    const clients = {}
    for (const [name, keyring] of Object.entries(publicKeyrings)) {
      const keyringPath = join(dir, `public-${name}.json`)
      await writeFile(keyringPath, keyring)
      clients[name] = ps("build-client.ps1", {
        GoPath: process.env.CUDIA_GO_PATH,
        PublicKeysPath: keyringPath,
        OutputDirectory: join(dir, `client-${name}`),
      })
      assert.equal(clients[name].trust.trustedKeys, name === "AB" ? 2 : 1)
    }
    assert.deepEqual(await readFile(sourceTrustPath), sourceTrust, "the checked-in trust store must remain untouched")

    const enginePath =
      process.env.CUDIA_REAL_ENGINE ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
    const packages = {}
    for (const [name, client, sequence, version] of [
      ["initial", clients.A, 1, "1.0.0-preview.1"],
      ["overlap", clients.AB, 2, "1.0.0-preview.2"],
      ["rotated", clients.B, 3, "1.0.0-preview.3"],
      ["retired", clients.B, 4, "1.0.0-preview.4"],
    ]) {
      packages[name] = ps("package.ps1", {
        EnginePath: enginePath,
        LauncherPath: client.launcher,
        ClientBuildInfoPath: client.buildInfo,
        Version: version,
        Sequence: String(sequence),
        Channel: "preview",
        Variant: "normal",
        OutputPath: join(dir, `${name}.zip`),
      })
      assert.equal(digest(await readFile(packages[name].path)), packages[name].sha256)
    }

    async function publish(name, bundle, keyName, privateKeyFile, sequence, version) {
      const payloadPath = join(dir, `${name}-payload.json`)
      const manifestPath = join(dir, `${name}-manifest.json`)
      await writeFile(
        payloadPath,
        JSON.stringify({
          schema: 1,
          product: "cudia",
          channel: "preview",
          sequence,
          version,
          issuedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          artifacts: [
            {
              kind: "archive",
              platform: "windows",
              arch: "x64",
              variant: "normal",
              url: `https://cyara.com.br/test-fixtures/${name}.zip`,
              size: bundle.size,
              sha256: bundle.sha256,
            },
          ],
        }),
      )
      await publishManifest({ input: payloadPath, output: manifestPath, privateKeyFile, keyId: keyName })
      return manifestPath
    }

    const manifests = {
      initial: await publish("initial", packages.initial, "rotation-a", privateA, 1, "1.0.0-preview.1"),
      bBeforeOverlap: await publish("b-before-overlap", packages.overlap, "rotation-b", privateB, 2, "1.0.0-preview.2"),
      overlap: await publish("overlap", packages.overlap, "rotation-a", privateA, 2, "1.0.0-preview.2"),
      rotated: await publish("rotated", packages.rotated, "rotation-b", privateB, 3, "1.0.0-preview.3"),
      aAfterRetirement: await publish(
        "a-after-retirement",
        packages.retired,
        "rotation-a",
        privateA,
        4,
        "1.0.0-preview.4",
      ),
    }

    const installRoot = join(dir, "installed cudia")
    await mkdir(join(installRoot, "bin"), { recursive: true })
    await writeFile(
      join(installRoot, "connection.json"),
      JSON.stringify({
        schema: 1,
        product: "cudia",
        channel: "preview",
        manifestUrl: "https://cyara.com.br/updates/v1/preview.json",
        checkIntervalHours: 24,
        automaticCheck: false,
      }),
    )

    const bootstrap = join(installRoot, "bin", "cudia.exe")
    const initialInstall = run(
      clients.A.launcher,
      ["install-bundled", "--root", installRoot, "--manifest", manifests.initial, "--archive", packages.initial.path],
      dir,
    )
    assert.equal(initialInstall.status, 0, initialInstall.stderr)
    await copyFile(clients.A.bootstrap, bootstrap)
    const bootstrapBytes = await readFile(bootstrap)

    async function info() {
      const result = run(bootstrap, ["installation", "info"], dir)
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }

    async function installThroughBootstrap(manifest, archive) {
      return run(
        bootstrap,
        ["install-bundled", "--root", installRoot, "--manifest", manifest, "--archive", archive],
        dir,
      )
    }

    async function rejectedWithoutMutation(manifest, archive, releaseID) {
      const before = await readFile(join(installRoot, "state", "activation.json"))
      const rejected = await installThroughBootstrap(manifest, archive)
      assert.notEqual(rejected.status, 0, rejected.stdout)
      assert.match(rejected.stderr, /release key is not trusted/)
      assert.deepEqual(await readFile(join(installRoot, "state", "activation.json")), before)
      assert.deepEqual(await readFile(bootstrap), bootstrapBytes)
      const current = await info()
      assert.equal(current.state.highestSequence, JSON.parse(before).highestSequence)
      assert.equal(current.state.installed[releaseID], undefined)
    }

    const infoA = await info()
    assert.equal(infoA.trustedKeys, 1)
    assert.equal(infoA.trustSha256, digest(Buffer.from(publicKeyrings.A)))
    const id1 = `seq-1-${packages.initial.sha256}`
    assert.equal(infoA.state.selectedReleaseId, id1)

    await rejectedWithoutMutation(manifests.bBeforeOverlap, packages.overlap.path, `seq-2-${packages.overlap.sha256}`)

    const overlapInstall = await installThroughBootstrap(manifests.overlap, packages.overlap.path)
    assert.equal(overlapInstall.status, 0, overlapInstall.stderr)
    const infoAB = await info()
    assert.equal(infoAB.trustedKeys, 2)
    assert.equal(infoAB.trustSha256, digest(Buffer.from(publicKeyrings.AB)))
    assert.equal(infoAB.state.highestSequence, 2)
    const id2 = `seq-2-${packages.overlap.sha256}`
    assert.equal(infoAB.state.selectedReleaseId, id2)
    assert.ok(infoAB.state.installed[id1], "the previous verified version remains available")

    const rotatedInstall = await installThroughBootstrap(manifests.rotated, packages.rotated.path)
    assert.equal(rotatedInstall.status, 0, rotatedInstall.stderr)
    const infoB = await info()
    assert.equal(infoB.trustedKeys, 1)
    assert.equal(infoB.trustSha256, digest(Buffer.from(publicKeyrings.B)))
    assert.equal(infoB.state.highestSequence, 3)
    const id3 = `seq-3-${packages.rotated.sha256}`
    assert.equal(infoB.state.selectedReleaseId, id3)
    assert.ok(infoB.state.installed[id1])
    assert.ok(infoB.state.installed[id2])

    await rejectedWithoutMutation(manifests.aAfterRetirement, packages.retired.path, `seq-4-${packages.retired.sha256}`)
    assert.deepEqual(await readFile(bootstrap), bootstrapBytes)
    assert.equal((await info()).state.selectedReleaseId, id3)
  },
)
