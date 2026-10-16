import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { generateKeyPairSync, createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createServer } from "node:net"
import { once } from "node:events"
import { publishManifest } from "../../../deploy/updates/publish.js"

const windowsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repo = resolve(windowsRoot, "..", "..")
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
      ...Object.entries(options).flatMap(([key, value]) => (value === true ? [`-${key}`] : [`-${key}`, String(value)])),
    ],
    {
      cwd: windowsRoot,
      encoding: "utf8",
      timeout: 120_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test(
  "Node publisher and Windows Go client agree on a real signed PowerShell-built package",
  {
    skip: process.platform !== "win32" || !process.env.CUDIA_GO_PATH,
    timeout: 120_000,
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-signed-interop-"))
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const key = generateKeyPairSync("ed25519")
    const keyring = join(dir, "public.json")
    const privateKeyFile = join(dir, "test-private.pem")
    await writeFile(keyring, JSON.stringify({ "interop-test": key.publicKey.export({ type: "spki", format: "pem" }) }))
    await writeFile(privateKeyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    const sourceTrustPath = join(windowsRoot, "launcher", "internal", "client", "trust.json")
    const sourceTrust = await readFile(sourceTrustPath)
    const client = ps("build-client.ps1", {
      GoPath: process.env.CUDIA_GO_PATH,
      PublicKeysPath: keyring,
      OutputDirectory: join(dir, "compiled"),
    })
    assert.equal(client.trust.trustedKeys, 1)
    assert.deepEqual(await readFile(sourceTrustPath), sourceTrust)

    // The default PE is format input only; CUDIA_REAL_ENGINE enables the actual harness gate.
    const artifact = ps("package.ps1", {
      EnginePath:
        process.env.CUDIA_REAL_ENGINE ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
      LauncherPath: client.launcher,
      ClientBuildInfoPath: client.buildInfo,
      ...(process.env.CUDIA_ENGINE_BUILD_INFO
        ? { EngineBuildInfoPath: process.env.CUDIA_ENGINE_BUILD_INFO, RequireEngineProvenance: true }
        : {}),
      Version: "1.0.0-preview.1",
      Sequence: "1",
      Channel: "preview",
      Variant: "normal",
      OutputPath: join(dir, "package.zip"),
    })
    assert.equal(
      createHash("sha256")
        .update(await readFile(artifact.path))
        .digest("hex"),
      artifact.sha256,
    )
    const payload = {
      schema: 1,
      product: "cudia",
      channel: "preview",
      sequence: 1,
      version: "1.0.0-preview.1",
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
    const manifest = join(dir, "preview.json")
    await writeFile(input, JSON.stringify(payload))
    await publishManifest({ input, output: manifest, privateKeyFile, keyId: "interop-test" })
    if (process.env.CUDIA_ENGINE_BUILD_INFO) {
      assert.ok(process.env.CUDIA_REAL_ENGINE, "Engine receipt gate requires the actual matching engine")
      const prepared = ps("build-installer.ps1", {
        BootstrapPath: client.bootstrap,
        LauncherPath: client.launcher,
        ManifestPath: manifest,
        ArchivePath: artifact.path,
        Channel: "preview",
        Variant: "normal",
        PrepareOnly: true,
        OutputDirectory: join(dir, "engine-provenance-prepared"),
      })
      assert.equal(prepared.completed, true)
      assert.equal(prepared.provenance.engineSource, "observed-build")
      assert.equal(prepared.validatedForPublication, false)
    }
    const installRoot = join(dir, "instalacao com espacos e ü")
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
    const install = spawnSync(
      client.launcher,
      ["install-bundled", "--root", installRoot, "--manifest", manifest, "--archive", artifact.path],
      { encoding: "utf8", timeout: 30_000 },
    )
    assert.equal(install.status, 0, install.stderr)
    await copyFile(client.bootstrap, join(installRoot, "bin", "cudia.exe"))
    const info = spawnSync(join(installRoot, "bin", "cudia.exe"), ["installation", "info"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
    })
    assert.equal(info.status, 0, info.stderr)
    const state = JSON.parse(info.stdout)
    if (process.env.CUDIA_ENGINE_BUILD_INFO) {
      const selected = join(installRoot, "versions", state.state.selectedReleaseId, "defaults")
      assert.deepEqual(
        await readFile(join(selected, "cudia-engine-build.json")),
        await readFile(process.env.CUDIA_ENGINE_BUILD_INFO),
      )
      const receipt = JSON.parse(await readFile(join(selected, "cudia-engine-build.json"), "utf8"))
      const inventory = await readFile(join(selected, receipt.inventory.path))
      assert.equal(inventory.length, receipt.inventory.size)
      assert.equal(createHash("sha256").update(inventory).digest("hex"), receipt.inventory.sha256)
      assert.equal(
        receipt.output.sha256,
        createHash("sha256")
          .update(await readFile(process.env.CUDIA_REAL_ENGINE))
          .digest("hex"),
      )
      assert.ok(
        receipt.output.size > 1_000_000,
        "Receipt must describe the on-disk executable, not intermediate JS size",
      )
    }
    assert.equal(state.trustedKeys, 1)
    assert.equal(state.state.highestSequence, 1)
    assert.equal(state.state.installed[state.state.selectedReleaseId].archiveSha256, artifact.sha256)
    assert.equal(
      state.state.installed[state.state.selectedReleaseId].descriptor.files["defaults/agent/arena-contestant.md"].size >
        0,
      true,
    )
    const before = await readFile(join(installRoot, "state", "activation.json"))
    const altered = JSON.parse(await readFile(manifest, "utf8"))
    altered.signature = Buffer.alloc(64).toString("base64")
    const badManifest = join(dir, "altered.json")
    await writeFile(badManifest, JSON.stringify(altered))
    const rejected = spawnSync(
      client.launcher,
      ["install-bundled", "--root", installRoot, "--manifest", badManifest, "--archive", artifact.path],
      { encoding: "utf8", timeout: 10_000 },
    )
    assert.notEqual(rejected.status, 0)
    assert.deepEqual(await readFile(join(installRoot, "state", "activation.json")), before)
    await verifyPreparedInstaller(dir, { client, manifest, artifact })
    if (process.env.CUDIA_REAL_ENGINE) await verifyRealHarness(installRoot, dir, { client, payload, privateKeyFile })
  },
)

async function verifyPreparedInstaller(dir, bundle) {
  const root = join(dir, "wizard preparado ü")
  const ticketPath = join(dir, "wizard-ticket.txt")
  await mkdir(root)
  const helper = (operation, ...args) =>
    spawnSync(bundle.client.launcher, ["installer", operation, "--root", root, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
    })
  const prepared = helper(
    "prepare",
    "--manifest",
    bundle.manifest,
    "--archive",
    bundle.artifact.path,
    "--bootstrap",
    bundle.client.bootstrap,
    "--channel",
    "preview",
    "--ticket-output",
    ticketPath,
  )
  assert.equal(prepared.status, 0, prepared.stderr)
  const ticket = (await readFile(ticketPath, "utf8")).trim()
  assert.equal(JSON.parse(prepared.stdout).ticket, ticket)
  await assert.rejects(readFile(join(root, "state", "activation.json")), { code: "ENOENT" })
  await assert.rejects(readFile(join(root, "connection.json")), { code: "ENOENT" })
  const incomplete = helper("commit", "--ticket", ticket)
  assert.notEqual(incomplete.status, 0, "A missing installed bootstrap must prevent activation")
  await mkdir(join(root, "bin"))
  await copyFile(bundle.client.bootstrap, join(root, "bin", "cudia.exe"))
  const committed = helper("commit", "--ticket", ticket)
  assert.equal(committed.status, 0, committed.stderr)
  const stateBytes = await readFile(join(root, "state", "activation.json"))
  const state = JSON.parse(stateBytes)
  assert.equal(state.highestSequence, 1)
  assert.equal(JSON.parse(await readFile(join(root, "connection.json"), "utf8")).channel, "preview")
  assert.equal(helper("commit", "--ticket", ticket).status, 0, "Commit retry must be idempotent")
  assert.deepEqual(await readFile(join(root, "state", "activation.json")), stateBytes)
  assert.equal(helper("abort", "--ticket", ticket).status, 0, "Committed journal cleanup must preserve activation")
  assert.deepEqual(await readFile(join(root, "state", "activation.json")), stateBytes)
  const info = spawnSync(join(root, "bin", "cudia.exe"), ["installation", "info"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10_000,
  })
  assert.equal(info.status, 0, info.stderr)
  assert.equal(JSON.parse(info.stdout).state.selectedReleaseId, state.selectedReleaseId)
  const unknown = join(root, "versions", state.selectedReleaseId, "defaults", "personal-note.txt")
  await writeFile(unknown, "Preserve unknown user data")
  const userData = join(root, "personal-session.json")
  await writeFile(userData, '{"keep":true}')
  const preflight = helper("preflight-uninstall")
  assert.equal(preflight.status, 0, preflight.stderr)
  const removed = helper("remove-payload")
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(await readFile(unknown, "utf8"), "Preserve unknown user data")
  assert.equal(await readFile(userData, "utf8"), '{"keep":true}')
  assert.ok(JSON.parse(removed.stdout).remnants.length > 0)
  await assert.rejects(readFile(join(root, "state", "activation.json")), { code: "ENOENT" })
  await assert.rejects(readFile(join(root, "versions", state.selectedReleaseId, "runtime", "engine.exe")), {
    code: "ENOENT",
  })
  assert.equal(helper("remove-payload").status, 0, "Payload removal retry must be idempotent")
}

async function verifyRealHarness(installRoot, dir, bundle) {
  const project = join(dir, "real harness project")
  const user = join(dir, "user config")
  const data = join(dir, "isolated data")
  await Promise.all([project, user, data].map((path) => mkdir(path)))
  const userConfig = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { "*": "deny" },
    model: "smoke/smoke",
    provider: {
      smoke: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "test-only" },
        models: { smoke: { name: "Fixture", limit: { context: 20000, output: 1000 } } },
      },
    },
  })
  await writeFile(join(user, "opencode.json"), userConfig)
  await writeFile(join(project, "opencode.json"), JSON.stringify({ username: "INSTALLED_PROJECT_MARKER" }))
  const env = {
    PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    TEMP: dir,
    TMP: dir,
    APPDATA: user,
    LOCALAPPDATA: data,
    OPENCODE_TEST_HOME: dir,
    OPENCODE_CONFIG_DIR: user,
    XDG_CONFIG_HOME: user,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_STATE_HOME: join(dir, "state"),
    OPENCODE_DB: join(data, "engine.sqlite"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    npm_config_registry: "http://127.0.0.1:1",
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "1000",
  }
  const command = (...args) =>
    spawnSync(join(installRoot, "bin", "cudia.exe"), args, {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  const config = command("debug", "config")
  assert.equal(config.status, 0, config.stderr)
  const resolved = JSON.parse(config.stdout)
  assert.equal(resolved.username, "INSTALLED_PROJECT_MARKER")
  assert.equal(resolved.model, "smoke/smoke")
  assert.equal(resolved.default_agent, "harness")
  const arena = command("debug", "agent", "arena-contestant")
  assert.equal(arena.status, 0, arena.stderr)
  const candidate = JSON.parse(arena.stdout)
  for (const available of ["read", "edit", "bash", "task"]) assert.equal(candidate.tools[available], true)
  const version = command("--version")
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /cudia\./)
  assert.equal(await readFile(join(user, "opencode.json"), "utf8"), userConfig)
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const server = spawn(
    join(installRoot, "bin", "cudia.exe"),
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: project, env, windowsHide: true, stdio: "ignore" },
  )
  const exited = once(server, "exit")
  const base = `http://127.0.0.1:${port}`
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(server.exitCode, null, "Own server exited before readiness")
      const health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) }).catch(() => undefined)
      if (health?.ok) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(ready, true)
    const refuseRemoval = spawnSync(
      bundle.client.launcher,
      ["installer", "preflight-uninstall", "--root", installRoot],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    )
    assert.notEqual(refuseRemoval.status, 0, "A real running server must prevent payload removal")
    const created = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: project } }),
    })
    assert.equal(created.status, 200)
    const sessionID = (await created.json()).data.id
    const previousState = JSON.parse(await readFile(join(installRoot, "state", "activation.json"), "utf8"))
    const next = ps("package.ps1", {
      EnginePath: process.env.CUDIA_REAL_ENGINE,
      LauncherPath: bundle.client.launcher,
      ClientBuildInfoPath: bundle.client.buildInfo,
      ...(process.env.CUDIA_ENGINE_BUILD_INFO
        ? { EngineBuildInfoPath: process.env.CUDIA_ENGINE_BUILD_INFO, RequireEngineProvenance: true }
        : {}),
      Version: "1.0.0-preview.2",
      Sequence: "2",
      Channel: "preview",
      Variant: "normal",
      OutputPath: join(dir, "next.zip"),
    })
    const input = join(dir, "next-payload.json")
    const manifest = join(dir, "next-preview.json")
    await writeFile(
      input,
      JSON.stringify({
        ...bundle.payload,
        sequence: 2,
        version: "1.0.0-preview.2",
        artifacts: [{ ...bundle.payload.artifacts[0], size: next.size, sha256: next.sha256 }],
      }),
    )
    await publishManifest({ input, output: manifest, privateKeyFile: bundle.privateKeyFile, keyId: "interop-test" })
    const update = spawnSync(
      bundle.client.launcher,
      ["install-bundled", "--root", installRoot, "--manifest", manifest, "--archive", next.path],
      { encoding: "utf8", timeout: 30_000 },
    )
    assert.equal(update.status, 0, update.stderr)
    const after = JSON.parse(await readFile(join(installRoot, "state", "activation.json"), "utf8"))
    assert.equal(after.highestSequence, 2)
    assert.notEqual(after.selectedReleaseId, previousState.selectedReleaseId)
    assert.ok(after.installed[previousState.selectedReleaseId])
    assert.equal(server.exitCode, null)
    const retained = await fetch(`${base}/api/session/${sessionID}`, { signal: AbortSignal.timeout(3000) })
    assert.equal(retained.status, 200)
    assert.equal((await retained.json()).data.id, sessionID)
    const nextLaunch = command("installation", "info")
    assert.equal(nextLaunch.status, 0, nextLaunch.stderr)
    assert.equal(JSON.parse(nextLaunch.stdout).state.selectedReleaseId, after.selectedReleaseId)
    assert.equal(await readFile(join(user, "opencode.json"), "utf8"), userConfig)
  } finally {
    // The PID belongs to this newly spawned bootstrap; /T targets only its owned process chain.
    if (server.exitCode === null) {
      const stop = spawnSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(server.pid), "/T", "/F"],
        { encoding: "utf8", windowsHide: true },
      )
      assert.equal(stop.status, 0, stop.stderr)
    }
    await exited
  }
}
