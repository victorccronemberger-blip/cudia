import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const windowsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(windowsRoot, "launcher")
const builderPath = join(windowsRoot, "build-client.ps1")
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function script(options) {
  return spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      builderPath,
      ...Object.entries(options).flatMap(([name, value]) => [`-${name}`, String(value)]),
    ],
    { cwd: windowsRoot, encoding: "utf8", timeout: 180_000, windowsHide: true },
  )
}

async function copiedSourceFiles(directory) {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      Object.assign(result, await copiedSourceFiles(join(directory, entry.name)))
      continue
    }
    if (!entry.isFile() || (!entry.name.endsWith(".go") && entry.name !== "go.mod" && entry.name !== "trust.json"))
      continue
    const path = join(directory, entry.name)
    const relativePath = relative(sourceRoot, path).split(sep).join("/")
    if (relativePath.toLowerCase().startsWith("dist/")) continue
    const file = await readFile(path)
    result[relativePath] = { size: file.length, sha256: sha256(file) }
  }
  return result
}

test(
  "client build provenance matches frozen source, public trust, toolchain and executables",
  { skip: process.platform !== "win32" || !process.env.CUDIA_GO_PATH, timeout: 240_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-client-provenance-"))
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const sourceTrustPath = join(sourceRoot, "internal", "client", "trust.json")
    const originalTrust = await readFile(sourceTrustPath)
    const key = generateKeyPairSync("ed25519")
    const keyring = JSON.stringify({ "provenance-fixture": key.publicKey.export({ type: "spki", format: "pem" }) })
    const keyringPath = join(dir, "public.json")
    await writeFile(keyringPath, keyring)

    const result = script({
      GoPath: process.env.CUDIA_GO_PATH,
      PublicKeysPath: keyringPath,
      OutputDirectory: join(dir, "compiled"),
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const output = JSON.parse(result.stdout)
    assert.deepEqual(await readFile(sourceTrustPath), originalTrust)

    const provenanceBytes = await readFile(output.buildInfo)
    const provenanceText = provenanceBytes.toString("utf8")
    const provenance = JSON.parse(provenanceText)
    assert.equal(provenance.schema, 1)
    assert.equal(provenance.product, "cudia")
    assert.equal(provenance.kind, "windows-client-build")
    assert.deepEqual(provenance.source.builder, {
      size: (await lstat(builderPath)).size,
      sha256: sha256(await readFile(builderPath)),
    })

    const expectedSources = await copiedSourceFiles(sourceRoot)
    expectedSources["internal/client/trust.json"] = {
      size: Buffer.byteLength(keyring),
      sha256: sha256(Buffer.from(keyring)),
    }
    assert.deepEqual(provenance.source.files, expectedSources)

    const goExecutable = await readFile(process.env.CUDIA_GO_PATH)
    const goVersion = spawnSync(process.env.CUDIA_GO_PATH, ["version"], { encoding: "utf8" })
    assert.equal(goVersion.status, 0, goVersion.stderr)
    assert.equal(provenance.build.goVersion, goVersion.stdout.trim())
    assert.deepEqual(provenance.build.goExecutable, { size: goExecutable.length, sha256: sha256(goExecutable) })
    assert.match(provenance.build.powershellVersion, /^5\./)
    assert.equal(provenance.build.powershellEdition, "Desktop")
    assert.deepEqual(provenance.build.environment, {
      CGO_ENABLED: "0",
      GOTOOLCHAIN: "local",
      GOOS: "windows",
      GOARCH: "amd64",
    })
    assert.deepEqual(Object.keys(provenance.build.arguments), ["bootstrap", "launcher"])
    assert.deepEqual(provenance.build.arguments.bootstrap, [
      "build",
      "-trimpath",
      "-ldflags",
      "-s -w",
      "-o",
      "<temporary-output>",
      "./cmd/bootstrap",
    ])
    assert.deepEqual(provenance.build.arguments.launcher, [
      "build",
      "-trimpath",
      "-ldflags",
      "-s -w",
      "-o",
      "<temporary-output>",
      "./cmd/launcher",
    ])
    assert.deepEqual(provenance.trust, output.trust)
    assert.equal(provenance.trust.trustedKeys, 1)
    for (const name of ["cudia.exe", "launcher.exe"]) {
      const binary = await readFile(join(dirname(output.buildInfo), name))
      assert.deepEqual(provenance.outputs[name], { size: binary.length, sha256: sha256(binary) })
    }
    assert.equal(/(?:[A-Za-z]:\\|\/tmp\/|\/var\/tmp\/)/.test(provenanceText), false)
    assert.equal(provenanceText.includes("PRIVATE KEY"), false)
    assert.equal(provenanceText.includes(key.privateKey.export({ type: "pkcs8", format: "pem" }).toString()), false)
  },
)
