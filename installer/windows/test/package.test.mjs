import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const windows = process.platform === "win32"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)
const fixturePE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")

function build(output, overrides = {}) {
  const options = {
    EnginePath: fixturePE,
    LauncherPath: fixturePE,
    Version: "1.0.0-preview.1",
    Sequence: "1",
    Channel: "preview",
    Variant: "normal",
    OutputPath: output,
    ...overrides,
  }
  return spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "package.ps1"),
      ...Object.entries(options).flatMap(([key, value]) => (value === true ? [`-${key}`] : [`-${key}`, String(value)])),
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  )
}

test(
  "Windows packager emits exactly described files and excludes development assets",
  { skip: !windows },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-package-test-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const output = join(dir, "space directory")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(output)
    const archive = join(output, "cudia.zip")
    const sourceConfig = join(root, "..", "..", ".opencode", "opencode.json")
    const sourceConfigBytes = await readFile(sourceConfig)
    const sourceConfigHash = createHash("sha256").update(sourceConfigBytes).digest("hex")
    const sourceConfigValues = JSON.parse(sourceConfigBytes.toString("utf8"))
    assert.equal(sourceConfigValues.model, "deepseek/deepseek-v4-flash")
    assert.equal(sourceConfigValues.small_model, "glm/glm-4.7-flash")
    const sourceCommands = ["ai-deps.md", "changelog.md", "commit.md", "issues.md", "rmslop.md", "translate.md"]
    const sourceHashes = new Map(
      await Promise.all(
        sourceCommands.map(async (name) => [
          name,
          createHash("sha256")
            .update(await readFile(join(root, "..", "..", ".opencode", "command", name)))
            .digest("hex"),
        ]),
      ),
    )
    const result = build(archive)
    assert.equal(result.status, 0, result.stderr)
    for (const name of sourceCommands) {
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(root, "..", "..", ".opencode", "command", name)))
          .digest("hex"),
        sourceHashes.get(name),
      )
    }
    assert.equal(createHash("sha256").update(await readFile(sourceConfig)).digest("hex"), sourceConfigHash)
    const metadata = JSON.parse(result.stdout)
    assert.equal(metadata.sequence, 1)
    assert.ok(metadata.files > 30)
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/)
    const inspectScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:CUDIA_TEST_ARCHIVE)
try {
  $data = @{}
  foreach ($name in @('package.json', 'defaults/opencode.json', 'defaults/tui.json', 'defaults/cudia-package-build.json')) {
    $reader = New-Object IO.StreamReader($zip.GetEntry($name).Open(), [Text.Encoding]::UTF8)
    try { $data[$name] = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  }
  foreach ($name in @('defaults/command/ai-deps.md', 'defaults/command/changelog.md', 'defaults/command/commit.md', 'defaults/command/issues.md', 'defaults/command/rmslop.md', 'defaults/command/translate.md', 'defaults/command/browser.md')) {
    $reader = New-Object IO.StreamReader($zip.GetEntry($name).Open(), [Text.Encoding]::UTF8)
    try { $data[$name] = $reader.ReadToEnd() } finally { $reader.Dispose() }
  }
  $descriptor = $data['package.json']
  foreach ($file in $descriptor.files.PSObject.Properties) {
    $entry = $zip.GetEntry($file.Name)
    if ($null -eq $entry -or $entry.Length -ne $file.Value.size) { throw 'Entry length mismatch' }
    $stream = $entry.Open()
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
      $actual = ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
      if ($actual -ne $file.Value.sha256) { throw 'Entry digest mismatch' }
    } finally { $stream.Dispose(); $hash.Dispose() }
  }
  @{ names = @($zip.Entries | ForEach-Object { $_.FullName }); data = $data } | ConvertTo-Json -Depth 64 -Compress
} finally { $zip.Dispose() }
`
    const inspected = spawnSync(
      powershell,
      ["-NoProfile", "-EncodedCommand", Buffer.from(inspectScript, "utf16le").toString("base64")],
      {
        encoding: "utf8",
        env: { ...process.env, CUDIA_TEST_ARCHIVE: archive },
        timeout: 30_000,
      },
    )
    assert.equal(inspected.status, 0, inspected.stderr)
    const found = JSON.parse(inspected.stdout)
    assert.equal(found.names.length, metadata.files + 1)
    assert.equal(new Set(found.names.map((name) => name.toLowerCase())).size, found.names.length)
    assert.ok(found.names.includes("defaults/agent/arena-contestant.md"))
    assert.ok(found.names.includes("defaults/skills/arena/SKILL.md"))
    assert.ok(found.names.includes("defaults/themes/mytheme.json"))
    for (const name of ["ai-deps.md", "changelog.md", "commit.md", "issues.md", "rmslop.md", "translate.md"]) {
      assert.ok(found.names.includes(`defaults/command/${name}`))
      assert.equal(
        found.data[`defaults/command/${name}`],
        await readFile(join(root, "defaults", "command", name), "utf8"),
      )
      assert.doesNotMatch(found.data[`defaults/command/${name}`], /^model:/m)
    }
    assert.match(found.data["defaults/command/ai-deps.md"], /workspace configuration/)
    assert.doesNotMatch(found.data["defaults/command/ai-deps.md"], /packages\/opencode\/package\.json/)
    assert.match(found.data["defaults/command/changelog.md"], /Git revision references/)
    assert.doesNotMatch(found.data["defaults/command/changelog.md"], /bun script\/raw-changelog\.ts/)
    assert.match(found.data["defaults/command/issues.md"], /explicit `owner\/repo`/)
    assert.doesNotMatch(found.data["defaults/command/issues.md"], /anomalyco\/opencode/)
    assert.match(found.data["defaults/command/commit.md"], /preserving unrelated staged and/)
    assert.doesNotMatch(found.data["defaults/command/commit.md"], /packages\/web/)
    assert.match(found.data["defaults/command/rmslop.md"], /upstream from Git metadata/)
    assert.doesNotMatch(found.data["defaults/command/rmslop.md"], /dev branch/)
    assert.match(found.data["defaults/command/translate.md"], /locale configuration and translated files/)
    assert.doesNotMatch(found.data["defaults/command/translate.md"], /translate all languages in parallel/)
    assert.equal(
      found.data["defaults/command/browser.md"],
      await readFile(join(root, "..", "..", ".opencode", "command", "browser.md"), "utf8"),
    )
    assert.ok(found.names.every((name) => !/node_modules|smoke|\.env|test\.mjs|env\.d\.ts/.test(name)))
    assert.equal(found.data["package.json"].bootstrapABI, 1)
    const provenance = found.data["defaults/cudia-package-build.json"]
    assert.equal(provenance.kind, "windows-package-build")
    assert.deepEqual(provenance.identity, {
      version: metadata.version,
      sequence: metadata.sequence,
      channel: "preview",
      variant: "normal",
      bootstrapABI: 1,
    })
    assert.deepEqual(provenance.inputs.engine, found.data["package.json"].files["runtime/engine.exe"])
    assert.deepEqual(provenance.inputs.launcher, found.data["package.json"].files["launcher.exe"])
    assert.equal(provenance.inputs.engineSource, "not-recorded")
    assert.equal(provenance.inputs.clientBuild, null)
    const defaults = Object.fromEntries(
      Object.entries(found.data["package.json"].files).filter(
        ([name]) => name.startsWith("defaults/") && name !== "defaults/cudia-package-build.json",
      ),
    )
    assert.deepEqual(provenance.defaults, defaults)
    assert.equal(
      provenance.build.builder.sha256,
      createHash("sha256")
        .update(await readFile(join(root, "package.ps1")))
        .digest("hex"),
    )
    assert.deepEqual(metadata.provenance, found.data["package.json"].files["defaults/cudia-package-build.json"])
    assert.equal(JSON.stringify(provenance).includes(dir), false)
    assert.equal(found.data["defaults/opencode.json"].mcp["cudia-browser"].enabled, false)
    assert.equal(found.data["defaults/opencode.json"].mcp["claude-bridge"].enabled, false)
    assert.equal("model" in found.data["defaults/opencode.json"], false)
    assert.equal("small_model" in found.data["defaults/opencode.json"], false)
    assert.match(found.data["defaults/opencode.json"].mcp["claude-bridge"].command.at(-1), /CUDIA_DISTRIBUTION_DIR/)
    assert.equal("plugin" in found.data["defaults/tui.json"], false)
    assert.equal("plugins" in found.data["defaults/tui.json"], false)
  },
)

test("Windows packager rejects client provenance that names a different launcher", { skip: !windows }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cudia-package-provenance-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const record = join(dir, "client-build.json")
  await writeFile(
    record,
    JSON.stringify({
      schema: 1,
      product: "cudia",
      kind: "windows-client-build",
      outputs: { "launcher.exe": { size: 1, sha256: "0".repeat(64) } },
    }),
  )
  const output = join(dir, "rejected.zip")
  const result = build(output, { ClientBuildInfoPath: record })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /provenance does not match/)
  await assert.rejects(readFile(output), { code: "ENOENT" })
})

test(
  "engine receipts require matching bytes, target and a present bounded inventory",
  { skip: !windows },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-engine-package-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const bytes = await readFile(fixturePE)
    const inventoryPath = join(dir, "engine-inputs.json")
    const inventory = JSON.stringify({
      schema: 1,
      repository: { head: "a".repeat(40), files: [] },
      bundler: { inputs: [] },
    })
    const receipt = {
      schema: 1,
      product: "cudia",
      kind: "engine-build",
      identity: { version: "1.18.35+fixture", platform: "windows", arch: "x64", variant: "normal" },
      output: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      build: {
        discoveryPass: true,
        repositoryHead: "a".repeat(40),
        recipe: { compile: { target: "bun-windows-x64" } },
      },
      inventory: {
        path: "engine-inputs.json",
        size: Buffer.byteLength(inventory),
        sha256: createHash("sha256").update(inventory).digest("hex"),
      },
    }
    const recordPath = join(dir, "engine-build.json")
    const reject = async (overrides, pattern) => {
      const output = join(dir, `reject-${randomUUID()}.zip`)
      const result = build(output, { EngineBuildInfoPath: recordPath, ...overrides })
      assert.notEqual(result.status, 0)
      if (pattern) assert.match(result.stderr, pattern)
      await assert.rejects(readFile(output), { code: "ENOENT" })
    }
    await writeFile(recordPath, JSON.stringify(receipt))
    await reject({}, /engine-inputs.json/)
    await writeFile(inventoryPath, inventory)
    const accepted = build(join(dir, "accepted.zip"), {
      EngineBuildInfoPath: recordPath,
      RequireEngineProvenance: true,
    })
    assert.equal(accepted.status, 0, accepted.stderr)
    await reject({ Variant: "baseline" }, /does not match/)
    await writeFile(recordPath, JSON.stringify({ ...receipt, output: { ...receipt.output, size: 1 } }))
    await reject({}, /does not match/)
    await writeFile(recordPath, JSON.stringify(receipt))
    await writeFile(inventoryPath, inventory + " ")
    await reject({}, /inventory digest differs/)
    await writeFile(inventoryPath, Buffer.alloc(4 * 1024 * 1024 + 1, 32))
    await reject({}, /inventory exceeds 4 MiB/)
    await writeFile(inventoryPath, inventory)
    await writeFile(recordPath, Buffer.alloc(1024 * 1024 + 1, 32))
    await reject({}, /receipt exceeds 1 MiB/)
    await reject({ EngineBuildInfoPath: "", RequireEngineProvenance: true }, /requires engine build provenance/)
  },
)

test(
  "Windows packager rejects invalid release identities and preserves an existing artifact",
  { skip: !windows },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-package-reject-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const output = join(dir, "existing.zip")
    await writeFile(output, "previous artifact")
    for (const override of [{}, { Sequence: "0" }, { Sequence: "9007199254740992" }, { Version: "1.0.0-.." }]) {
      const result = build(output, override)
      assert.notEqual(result.status, 0)
      assert.equal(await readFile(output, "utf8"), "previous artifact")
    }
  },
)
