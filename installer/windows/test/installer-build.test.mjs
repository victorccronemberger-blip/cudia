import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto"
import { copyFile, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

function script(name, options) {
  return spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(windowsRoot, name),
      ...Object.entries(options).flatMap(([name, value]) =>
        value === true ? [`-${name}`] : [`-${name}`, String(value)],
      ),
    ],
    { cwd: windowsRoot, encoding: "utf8", timeout: 120_000, windowsHide: true },
  )
}

function success(name, options) {
  const result = script(name, options)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return JSON.parse(result.stdout)
}

async function alterPackageProvenance(source, destination, mode) {
  assert.ok(["omit", "extra", "legacy", "engine-output", "engine-inventory"].includes(mode))
  await copyFile(source, destination)
  const operation = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($env:CUDIA_PROVENANCE_ARCHIVE, [IO.Compression.ZipArchiveMode]::Update)
function Read-Entry([string]$name) {
  $reader = New-Object IO.StreamReader($zip.GetEntry($name).Open(), [Text.Encoding]::UTF8)
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}
function Write-Entry([string]$name, $value) {
  $existing = $zip.GetEntry($name)
  if ($null -ne $existing) { $existing.Delete() }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 64))
  $stream = $zip.CreateEntry($name).Open()
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return @{ size = $bytes.Length; sha256 = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } } finally { $sha.Dispose() }
}
try {
  $descriptor = Read-Entry 'package.json'
  $name = 'defaults/cudia-package-build.json'
  if ($env:CUDIA_PROVENANCE_MODE -eq 'legacy') {
    foreach ($remove in @($name, 'defaults/cudia-client-build.json')) {
      $zip.GetEntry($remove).Delete()
      $descriptor.files.PSObject.Properties.Remove($remove)
    }
  } else {
    $provenance = Read-Entry $name
    if ($env:CUDIA_PROVENANCE_MODE.StartsWith('engine-')) {
      $head = 'a' * 40
      $inputs = Write-Entry 'defaults/engine-inputs.json' @{ schema = 1; repository = @{ head = $head; files = @() }; bundler = @{ inputs = @() } }
      $receipt = @{
        schema = 1; product = 'cudia'; kind = 'engine-build'
        identity = @{ version = '1.18.35+fixture'; platform = 'windows'; arch = 'x64'; variant = 'normal' }
        output = @{ size = $descriptor.files.'runtime/engine.exe'.size; sha256 = $descriptor.files.'runtime/engine.exe'.sha256 }
        build = @{ discoveryPass = $true; repositoryHead = $head; recipe = @{ compile = @{ target = 'bun-windows-x64' } } }
        inventory = @{ path = 'engine-inputs.json'; size = $inputs.size; sha256 = $inputs.sha256 }
      }
      if ($env:CUDIA_PROVENANCE_MODE -eq 'engine-output') { $receipt.output.sha256 = '0' * 64 }
      else { $receipt.inventory.sha256 = '0' * 64 }
      $engine = Write-Entry 'defaults/cudia-engine-build.json' $receipt
      foreach ($record in @(@{ name = 'defaults/engine-inputs.json'; value = $inputs }, @{ name = 'defaults/cudia-engine-build.json'; value = $engine })) {
        $descriptor.files | Add-Member -NotePropertyName $record.name -NotePropertyValue $record.value
        $provenance.defaults | Add-Member -NotePropertyName $record.name -NotePropertyValue $record.value
      }
      $provenance.inputs.engineSource = 'observed-build'
      $provenance.inputs.engineBuild = @{ path = 'defaults/cudia-engine-build.json'; size = $engine.size; sha256 = $engine.sha256 }
    } elseif ($env:CUDIA_PROVENANCE_MODE -eq 'omit') {
      $first = @($provenance.defaults.PSObject.Properties.Name)[0]
      $provenance.defaults.PSObject.Properties.Remove($first)
    } else {
      $provenance.defaults | Add-Member -NotePropertyName 'defaults/extra-claimed.json' -NotePropertyValue @{ size = 1; sha256 = ('0' * 64) }
    }
    $entry = Write-Entry $name $provenance
    $descriptor.files.$name.size = $entry.size
    $descriptor.files.$name.sha256 = $entry.sha256
  }
  Write-Entry 'package.json' $descriptor | Out-Null
} finally { $zip.Dispose() }
`
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(operation, "utf16le").toString("base64")],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, CUDIA_PROVENANCE_ARCHIVE: destination, CUDIA_PROVENANCE_MODE: mode },
    },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
}

test(
  "installer build refuses missing compiler before touching inputs or creating output",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-build-early-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const result = script("build-installer.ps1", {
      BootstrapPath: join(dir, "missing-bootstrap"),
      LauncherPath: join(dir, "missing-helper"),
      ManifestPath: join(dir, "missing-manifest"),
      ArchivePath: join(dir, "missing-archive"),
      CompilerPath: join(dir, "missing-ISCC.exe"),
      OutputDirectory: join(dir, "output"),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /existing local Inno Setup ISCC.exe/)
    assert.deepEqual(await readdir(dir), [])
  },
)

test(
  "Windows PowerShell prepares only authenticated native installer inputs",
  {
    skip: process.platform !== "win32" || !process.env.CUDIA_GO_PATH,
    timeout: 240_000,
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-installer-build-test-"))
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const sourceTrustPath = join(windowsRoot, "launcher", "internal", "client", "trust.json")
    const sourceTrust = await readFile(sourceTrustPath)
    const sourceWizard = await readFile(join(windowsRoot, "wizard.iss"))
    const key = generateKeyPairSync("ed25519")
    const keyring = join(dir, "public.json")
    const privateKeyFile = join(dir, "fixture-private.pem")
    await writeFile(keyring, JSON.stringify({ "build-test": key.publicKey.export({ type: "spki", format: "pem" }) }))
    await writeFile(privateKeyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    const client = success("build-client.ps1", {
      GoPath: process.env.CUDIA_GO_PATH,
      PublicKeysPath: keyring,
      OutputDirectory: join(dir, "client"),
    })
    const artifact = success("package.ps1", {
      EnginePath: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
      LauncherPath: client.launcher,
      ClientBuildInfoPath: client.buildInfo,
      Version: "1.2.3-preview.4+fixture",
      Sequence: 7,
      OutputPath: join(dir, "bundle.zip"),
    })
    const payload = {
      schema: 1,
      product: "cudia",
      channel: "preview",
      sequence: 7,
      version: artifact.version,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      artifacts: [
        {
          kind: "archive",
          platform: "windows",
          arch: "x64",
          variant: "normal",
          url: "https://cyara.com.br/test-fixtures/never-published.zip",
          size: artifact.size,
          sha256: artifact.sha256,
        },
      ],
    }
    const input = join(dir, "payload.json")
    const manifest = join(dir, "release.json")
    await writeFile(input, JSON.stringify(payload))
    await publishManifest({ input, output: manifest, privateKeyFile, keyId: "build-test" })
    const options = {
      BootstrapPath: client.bootstrap,
      LauncherPath: client.launcher,
      ManifestPath: manifest,
      ArchivePath: artifact.path,
      OutputDirectory: join(dir, "prepared ü with spaces"),
      PrepareOnly: true,
    }
    const prepared = success("build-installer.ps1", options)
    assert.equal(prepared.compiled, false)
    assert.equal(prepared.completed, true)
    assert.equal(prepared.developerArtifact, true)
    assert.equal(prepared.installer, null)
    assert.equal(prepared.version, artifact.version)
    assert.equal(prepared.sequence, 7)
    assert.equal(prepared.releaseId, `seq-7-${artifact.sha256}`)
    assert.equal(prepared.trust.trustedKeys, 1)
    assert.equal(prepared.provenance.package.sha256, artifact.provenance.sha256)
    assert.equal(prepared.provenance.engineSource, "not-recorded")
    assert.equal(
      prepared.provenance.engine.sha256,
      hash(await readFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"))),
    )
    assert.equal(prepared.provenance.builder.sha256, hash(await readFile(join(windowsRoot, "build-installer.ps1"))))
    assert.deepEqual(prepared.provenance.release, {
      keyId: "build-test",
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    })
    const files = await readdir(options.OutputDirectory)
    assert.deepEqual(files.sort(), [
      "build-info.json",
      "bundle.iss",
      "bundle.zip",
      "cudia.exe",
      "launcher.exe",
      "release.json",
      "wizard.iss",
    ])
    for (const [name, expected] of Object.entries(prepared.sources)) {
      assert.equal(hash(await readFile(join(options.OutputDirectory, name))), expected)
    }
    assert.deepEqual(await readFile(join(options.OutputDirectory, "wizard.iss")), sourceWizard)
    assert.deepEqual(await readFile(sourceTrustPath), sourceTrust)
    assert.deepEqual(JSON.parse(await readFile(join(options.OutputDirectory, "build-info.json"), "utf8")), prepared)
    const include = await readFile(join(options.OutputDirectory, "bundle.iss"), "utf8")
    assert.match(include, /#define CudiaSequence 7/)
    assert.match(include, /#define CudiaOutputName "cudia-1.2.3-preview.4\+fixture-windows-x64-normal-setup"/)
    assert.equal(include.includes(dir), false)
    assert.equal(include.includes("PRIVATE KEY"), false)

    async function reject(overrides, pattern) {
      const output = join(dir, `rejected-${randomUUID()}`)
      const result = script("build-installer.ps1", { ...options, OutputDirectory: output, ...overrides })
      assert.notEqual(result.status, 0, "Invalid bundle must be rejected")
      if (pattern) assert.match(result.stderr, pattern)
      await assert.rejects(lstat(output), { code: "ENOENT" })
      assert.deepEqual(await readFile(sourceTrustPath), sourceTrust)
    }
    const overwritten = script("build-installer.ps1", options)
    assert.notEqual(overwritten.status, 0)
    assert.match(overwritten.stderr, /Output already exists/)
    await reject({ Variant: "baseline" })
    await reject({ Channel: "stable" })
    const invalidManifest = join(dir, "bad-signature.json")
    const envelope = JSON.parse(await readFile(manifest, "utf8"))
    await writeFile(invalidManifest, JSON.stringify({ ...envelope, signature: Buffer.alloc(64).toString("base64") }))
    await reject({ ManifestPath: invalidManifest })
    const otherKey = generateKeyPairSync("ed25519")
    const otherPrivate = join(dir, "wrong-private.pem")
    await writeFile(otherPrivate, otherKey.privateKey.export({ type: "pkcs8", format: "pem" }))
    const wrongKeyManifest = join(dir, "wrong-key.json")
    await publishManifest({ input, output: wrongKeyManifest, privateKeyFile: otherPrivate, keyId: "wrong-key" })
    await reject({ ManifestPath: wrongKeyManifest })
    const modifiedArchive = join(dir, "modified.zip")
    await writeFile(modifiedArchive, Buffer.concat([await readFile(artifact.path), Buffer.from("tampered")]))
    await reject({ ArchivePath: modifiedArchive })
    const missing = join(dir, "missing.exe")
    await reject({ BootstrapPath: missing })
    await reject({ ManifestPath: dir })
    const oversizedManifest = join(dir, "oversized.json")
    await writeFile(oversizedManifest, Buffer.alloc(65537))
    await reject({ ManifestPath: oversizedManifest }, /size limit/)
    // A valid PE is insufficient: the private bootstrap handshake must succeed.
    await reject({ BootstrapPath: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe") })
    // Junctions do not require Windows developer mode or symlink privileges.
    const alias = join(dir, "alias")
    await symlink(dirname(client.bootstrap), alias, "junction")
    await reject({ BootstrapPath: join(alias, "cudia.exe") }, /aliases|reparse/)
    // Different compiled trust cannot substitute for the launcher inside the signed bundle.
    const otherPublic = join(dir, "other-public.json")
    await writeFile(
      otherPublic,
      JSON.stringify({
        "other-test": otherKey.publicKey.export({ type: "spki", format: "pem" }),
        "build-test": key.publicKey.export({ type: "spki", format: "pem" }),
      }),
    )
    const differentClient = success("build-client.ps1", {
      GoPath: process.env.CUDIA_GO_PATH,
      PublicKeysPath: otherPublic,
      OutputDirectory: join(dir, "different-client"),
    })
    await reject({ LauncherPath: differentClient.launcher }, /must exactly match|client provenance does not match/)
    // Empty compiled trust has no unsigned release escape hatch.
    const untrustedClient = success("build-client.ps1", {
      GoPath: process.env.CUDIA_GO_PATH,
      OutputDirectory: join(dir, "empty-trust-client"),
    })
    await reject({ LauncherPath: untrustedClient.launcher }, /compiled public release key/)
    const incorrectClientBuild = JSON.parse(await readFile(client.buildInfo, "utf8"))
    incorrectClientBuild.outputs["cudia.exe"].sha256 = "0".repeat(64)
    const incorrectClientPath = join(dir, "incorrect-client-build.json")
    await writeFile(incorrectClientPath, JSON.stringify(incorrectClientBuild))
    const incorrectPackage = success("package.ps1", {
      EnginePath: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
      LauncherPath: client.launcher,
      ClientBuildInfoPath: incorrectClientPath,
      Version: artifact.version,
      Sequence: 7,
      OutputPath: join(dir, "incorrect-provenance.zip"),
    })
    const incorrectPayload = join(dir, "incorrect-provenance-payload.json")
    const incorrectManifest = join(dir, "incorrect-provenance-manifest.json")
    await writeFile(
      incorrectPayload,
      JSON.stringify({
        ...payload,
        artifacts: [
          {
            ...payload.artifacts[0],
            size: incorrectPackage.size,
            sha256: incorrectPackage.sha256,
          },
        ],
      }),
    )
    await publishManifest({ input: incorrectPayload, output: incorrectManifest, privateKeyFile, keyId: "build-test" })
    await reject(
      { ManifestPath: incorrectManifest, ArchivePath: incorrectPackage.path },
      /client provenance does not match/,
    )
    for (const mode of ["omit", "extra", "legacy", "engine-output", "engine-inventory"]) {
      const archive = join(dir, `provenance-${mode}.zip`)
      await alterPackageProvenance(artifact.path, archive, mode)
      const bytes = await readFile(archive)
      const modifiedPayload = join(dir, `provenance-${mode}-payload.json`)
      const modifiedManifest = join(dir, `provenance-${mode}-manifest.json`)
      await writeFile(
        modifiedPayload,
        JSON.stringify({
          ...payload,
          artifacts: [
            {
              ...payload.artifacts[0],
              size: bytes.length,
              sha256: hash(bytes),
            },
          ],
        }),
      )
      await publishManifest({ input: modifiedPayload, output: modifiedManifest, privateKeyFile, keyId: "build-test" })
      if (mode !== "legacy") {
        await reject(
          { ManifestPath: modifiedManifest, ArchivePath: archive },
          mode === "engine-output"
            ? /Authenticated engine provenance does not match/
            : mode === "engine-inventory"
              ? /Authenticated engine input inventory differs/
              : /default inventory differs/,
        )
        continue
      }
      const legacy = success("build-installer.ps1", {
        ...options,
        ManifestPath: modifiedManifest,
        ArchivePath: archive,
        OutputDirectory: join(dir, "legacy-prepared"),
      })
      assert.equal(legacy.provenance.package, null)
      assert.equal(legacy.provenance.engineSource, "not-recorded")
      assert.equal(legacy.completed, true)
      assert.equal(legacy.validatedForPublication, false)
    }
    assert.deepEqual(await readFile(sourceTrustPath), sourceTrust)
    assert.deepEqual(await readFile(join(windowsRoot, "wizard.iss")), sourceWizard)
  },
)
