import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto"
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { dirname, isAbsolute, join, resolve, toNamespacedPath } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
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

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    cwd: windowsRoot,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

function pass(program, args, options) {
  const result = run(program, args, options)
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout)
  return result.stdout
}

function ps(script, options, cwd) {
  return pass(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...Object.entries(options).flatMap(([name, value]) =>
        value === true ? [`-${name}`] : [`-${name}`, String(value)],
      ),
    ],
    { cwd },
  )
}

function registry(subkey, mode = "Read") {
  const output = ps(join(windowsRoot, "test", "registry-fixture.ps1"), { Subkey: subkey, Mode: mode })
  return mode === "Read" ? JSON.parse(output) : undefined
}

function stringValue(values, name) {
  return values?.[name] ? Buffer.from(values[name].data, "base64").toString("utf16le").replace(/\0$/, "") : undefined
}

function registeredCommand(values, name) {
  const command = stringValue(values, name)
  assert.equal(typeof command, "string", `Missing registered ${name}`)
  const executable = /^"([^"\r\n]+)" /.exec(command)?.[1]
  assert.ok(executable, "Registered command must select a quoted absolute executable")
  // libuv passes argv0 verbatim as the complete Windows command line. The image
  // is selected separately; no shell parses or reconstructs the registered text.
  return run(executable, [], { argv0: command, windowsVerbatimArguments: true })
}

function cleanupJournal(values) {
  assert.ok(values?.CudiaCleanup, "Missing typed cleanup journal")
  return JSON.parse(Buffer.from(values.CudiaCleanup.data, "base64").toString("utf8"))
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" })
}

async function waitForOwnedCleanup(temp, recovery) {
  const deadline = Date.now() + 90_000
  let remnants = []
  while (Date.now() < deadline) {
    const temporary = (await readdir(temp)).filter((name) => name.startsWith("cudia-uninstall-"))
    const durable = await readdir(recovery, { recursive: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error
      return []
    })
    remnants = [...temporary, ...durable.filter((name) => /\.(exe|json)$/i.test(name))]
    if (!remnants.length) return
    await setTimeout(100)
  }
  assert.deepEqual(remnants, [], "This fixture's owned uninstall helpers and cleanup receipts must be removed")
}

async function copyModule(source, target, records = {}) {
  await mkdir(target, { recursive: true })
  for (const file of await readdir(source, { withFileTypes: true })) {
    if (file.name === "dist") continue
    const from = join(source, file.name)
    const to = join(target, file.name)
    assert.equal(file.isSymbolicLink(), false, "Source aliases are not accepted")
    if (file.isDirectory()) await copyModule(from, to, records)
    if (!file.isFile() || (!file.name.endsWith(".go") && file.name !== "go.mod")) continue
    await copyFile(from, to)
    records[from] = hash(await readFile(from))
  }
  return records
}

test(
  "compiled Inno wizard installs, repairs and uninstalls using an isolated native coordinator",
  {
    skip: process.platform !== "win32" || !process.env.CUDIA_GO_PATH || !process.env.CUDIA_INNO_COMPILER,
    timeout: 600_000,
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cudia-wizard-e2e-"))
    let complete = false
    const id = randomUUID().replaceAll("-", "")
    const namespace = `Software\\Cudia\\InstallerTests\\${id}`
    const apps = `${namespace}\\Apps`
    const environment = `${namespace}\\Environment`
    const sourceTrustPath = join(windowsRoot, "launcher", "internal", "client", "trust.json")
    const sourceTrust = await readFile(sourceTrustPath)
    const sourceWizard = await readFile(join(windowsRoot, "wizard.iss"), "utf8")
    const protectedKeys = [
      "Environment",
      "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Cudia",
      "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CudiaPreview",
    ]
    const before = protectedKeys.map((key) => hash(JSON.stringify(registry(key))))
    const checkProtected = () =>
      protectedKeys.forEach((key, index) =>
        assert.equal(hash(JSON.stringify(registry(key))), before[index], `Real HKCU ${key} changed`),
      )
    // No test code restores protected registry values. It only ever reads them.
    t.after(async () => {
      checkProtected()
      assert.deepEqual(await readFile(sourceTrustPath), sourceTrust)
      assert.equal(await readFile(join(windowsRoot, "wizard.iss"), "utf8"), sourceWizard)
      // A failed run retains native recovery authority with its payload.
      // Removing only the registry would make the retained installation harder to recover.
      if (complete) registry(namespace, "DeleteOwned")
      await rm(join(dir, "test-private.pem"), { force: true })
      if (complete) await rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
      if (!complete) t.diagnostic(`Failed fixture retained for diagnosis: ${dir}`)
    })
    const module = join(dir, "private source")
    const sourceHashes = await copyModule(join(windowsRoot, "launcher"), module)
    const factoryPath = join(module, "internal", "client", "wizard_windows.go")
    const source = await readFile(factoryPath, "utf8")
    const original =
      "func newWizardCoordinator(u *updater) wizardCoordinator {\n\thelper, _ := os.Executable()\n\treturn wizardCoordinator{u: u, helperSource: helper, path: pathManager{registrySubkey: `Environment`, notify: notifyUserPath}}\n}"
    const normalized = source.replaceAll("\r\n", "\n")
    assert.equal(
      normalized.split(original).length,
      2,
      "Private fixture must patch exactly the audited coordinator constructor",
    )
    const fault = join(dir, "private native fault")
    const observedFault = `${fault}.observed`
    const recovery = join(dir, "durable recovery")
    const replacement = `func newWizardCoordinator(u *updater) wizardCoordinator {
\thelper, _ := os.Executable()
\treturn wizardCoordinator{u: u, helperSource: helper, registrySubkey: ${JSON.stringify(apps)}, recoveryRoot: ${JSON.stringify(recovery)}, path: pathManager{registrySubkey: ${JSON.stringify(environment)}}, fail: func(name string) error {
\t\tif data, err := os.ReadFile(${JSON.stringify(fault)}); err == nil {
\t\t\tmode := string(data)
\t\t\tif mode == "fail-finalize" && name == "before-activation" { return errors.New("compiled test fixture finalize failure") }
\t\t\tif strings.HasPrefix(mode, "restore:") && name == "cleanup-before-executor-start" { return errors.New("private fixture executor unavailable") }
\t\t\tif (strings.HasPrefix(mode, "crash:") && name == strings.TrimPrefix(mode, "crash:")) || (strings.HasPrefix(mode, "restore:") && name == strings.TrimPrefix(mode, "restore:")) {
\t\t\t\tif err := os.WriteFile(${JSON.stringify(observedFault)}, []byte(name), 0600); err != nil { return err }
\t\t\t\tos.Exit(75)
\t\t\t}
\t\t}
\t\treturn nil
\t}}
}`
    await writeFile(factoryPath, normalized.replace(original, replacement))
    // Normal registered commands need the same headless coverage as quiet ones.
    // Only presentation is stubbed in this private build; production files and
    // transaction logic remain untouched. Real interactive QA stays a release gate.
    const nativeUIPath = join(module, "internal", "client", "uninstall_ui_windows.go")
    const nativeUI = (await readFile(nativeUIPath, "utf8")).replaceAll("\r\n", "\n")
    const nativeDialog =
      'result, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), flags)'
    assert.equal(nativeUI.split(nativeDialog).length, 2)
    const compiledNativeUI = nativeUI.replace(nativeDialog, "_ = text; _ = caption; _ = flags; result := uintptr(6)")
    await writeFile(nativeUIPath, compiledNativeUI)
    const registryUIPath = join(module, "internal", "client", "registry_cleanup_program_windows.go")
    const registryUI = await readFile(registryUIPath, "utf8")
    const registryDialog =
      '[DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int MessageBoxW(IntPtr h,string t,string c,uint f);'
    assert.equal(registryUI.split(registryDialog).length, 2)
    const compiledRegistryUI = registryUI.replace(
      registryDialog,
      "static int MessageBoxW(IntPtr h,string t,string c,uint f){Console.Error.WriteLine(t);return 6;}",
    )
    await writeFile(registryUIPath, compiledRegistryUI)
    const key = generateKeyPairSync("ed25519")
    await writeFile(
      join(module, "internal", "client", "trust.json"),
      JSON.stringify({ "wizard-test": key.publicKey.export({ type: "spki", format: "pem" }) }),
    )
    const privateKeyFile = join(dir, "test-private.pem")
    await writeFile(privateKeyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    const client = { bootstrap: join(dir, "cudia.exe"), launcher: join(dir, "launcher.exe") }
    const goOptions = {
      cwd: module,
      env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local", GOOS: "windows", GOARCH: "amd64" },
    }
    pass(
      process.env.CUDIA_GO_PATH,
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", client.bootstrap, "./cmd/bootstrap"],
      goOptions,
    )
    pass(
      process.env.CUDIA_GO_PATH,
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", client.launcher, "./cmd/launcher"],
      goOptions,
    )
    const artifact = JSON.parse(
      ps(join(windowsRoot, "package.ps1"), {
        EnginePath:
          process.env.CUDIA_REAL_ENGINE ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
        LauncherPath: client.launcher,
        ...(process.env.CUDIA_ENGINE_BUILD_INFO
          ? { EngineBuildInfoPath: process.env.CUDIA_ENGINE_BUILD_INFO, RequireEngineProvenance: true }
          : {}),
        Version: "1.0.0-test.1",
        Sequence: 1,
        Channel: "preview",
        OutputPath: join(dir, "bundle.zip"),
      }),
    )
    const input = join(dir, "payload.json")
    const manifest = join(dir, "release.json")
    await writeFile(
      input,
      JSON.stringify({
        schema: 1,
        product: "cudia",
        channel: "preview",
        sequence: 1,
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
      }),
    )
    await publishManifest({ input, output: manifest, privateKeyFile, keyId: "wizard-test" })
    const scripts = join(dir, "private build")
    await mkdir(scripts)
    await copyFile(join(windowsRoot, "build-installer.ps1"), join(scripts, "build-installer.ps1"))
    const testWizard = sourceWizard
      .replaceAll('#define CudiaDisplayName "CUDIA', '#define CudiaDisplayName "CUDIA TEST')
      .replace("AppId=Cudia.{#CudiaChannel}", `AppId=Cudia.Test.${id}.{#CudiaChannel}`)
      .replace("SetupMutex=Cudia.Setup.{#CudiaChannel}", `SetupMutex=Cudia.Test.${id}.{#CudiaChannel}`)
      .replace("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{#CudiaRegistryName}", apps)
    await writeFile(join(scripts, "wizard.iss"), testWizard)
    const output = join(dir, "compiled setup ü")
    const built = JSON.parse(
      ps(
        join(scripts, "build-installer.ps1"),
        {
          BootstrapPath: client.bootstrap,
          LauncherPath: client.launcher,
          ManifestPath: manifest,
          ArchivePath: artifact.path,
          OutputDirectory: output,
          CompilerPath: process.env.CUDIA_INNO_COMPILER,
        },
        scripts,
      ),
    )
    assert.equal(built.compiled, true)
    assert.equal(built.validatedForPublication, false)
    assert.equal(built.installer.sha256, hash(await readFile(built.installer.path)))
    assert.equal(built.compiler.sha256, hash(await readFile(process.env.CUDIA_INNO_COMPILER)))
    assert.equal(built.packaging, "inno-setup")
    if (process.env.CUDIA_ENGINE_BUILD_INFO) {
      assert.ok(process.env.CUDIA_REAL_ENGINE, "Engine receipt gate requires the matching real engine")
      assert.equal(built.provenance.engineSource, "observed-build")
      assert.equal(built.provenance.engineBuild.sha256, hash(await readFile(process.env.CUDIA_ENGINE_BUILD_INFO)))
    }
    const profile = {
      branding: "CUDIA TEST",
      namespace,
      registry: apps,
      environment,
      recovery,
      sourceHashes,
      originalConstructorSha256: hash(original),
      compiledConstructorSha256: hash(replacement),
      privatePresentationStubs: {
        nativeSourceSha256: hash(nativeUI),
        nativeCompiledSha256: hash(compiledNativeUI),
        registrySourceSha256: hash(registryUI),
        registryCompiledSha256: hash(compiledRegistryUI),
      },
      installer: built.installer,
      realEngine: process.env.CUDIA_REAL_ENGINE ? hash(await readFile(process.env.CUDIA_REAL_ENGINE)) : null,
      engineBuildReceipt: process.env.CUDIA_ENGINE_BUILD_INFO
        ? hash(await readFile(process.env.CUDIA_ENGINE_BUILD_INFO))
        : null,
    }
    await writeFile(join(dir, "test-profile.json"), JSON.stringify(profile, null, 2))
    // Explicit developer output for visual QA. Export only the test installer,
    // its helper and local evidence, before later corruption tests overwrite it.
    if (process.env.CUDIA_WIZARD_QA_OUTPUT) {
      const qaOutput = process.env.CUDIA_WIZARD_QA_OUTPUT
      assert.equal(isAbsolute(qaOutput), true, "QA output must be an absolute new directory")
      await mkdir(qaOutput)
      await copyFile(built.installer.path, join(qaOutput, "cudia-test-setup.exe"))
      await copyFile(client.launcher, join(qaOutput, "qa-helper.exe"))
      await writeFile(
        join(qaOutput, "qa-profile.json"),
        JSON.stringify(
          {
            schema: 1,
            qaOnly: true,
            fixtureRoot: dir,
            ...profile,
            expiresAt: JSON.parse(await readFile(input, "utf8")).expiresAt,
            exportedInstaller: "cudia-test-setup.exe",
            exportedHelper: "qa-helper.exe",
            helperSha256: hash(await readFile(client.launcher)),
          },
          null,
          2,
        ),
      )
      assert.equal(hash(await readFile(join(qaOutput, "cudia-test-setup.exe"))), built.installer.sha256)
      t.diagnostic(`Local QA fixture exported to ${qaOutput}; this is not a production installer.`)
    }
    t.diagnostic(
      `Compiled CUDIA TEST installer ${built.installer.sha256}; private source profile ${hash(JSON.stringify(profile))}; wizard source ${hash(sourceWizard)}`,
    )
    const root = join(dir, "instalação ü with spaces")
    const setup = (target = root, executable = built.installer.path, log = join(dir, `setup-${randomUUID()}.log`)) =>
      run(executable, [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/CURRENTUSER",
        `/DIR=${target}`,
        `/LOG=${log}`,
      ])
    const installed = setup()
    assert.equal(installed.status, 0, installed.error?.message ?? installed.stderr + installed.stdout)
    const owner = JSON.parse(await readFile(join(root, "state", "wizard-owner.json"), "utf8"))
    assert.equal(owner.root, root)
    assert.equal(owner.channel, "preview")
    assert.equal(owner.bootstrap.sha256, hash(await readFile(client.bootstrap)))
    assert.equal(owner.helper.sha256, hash(await readFile(client.launcher)))
    assert.equal(stringValue(registry(apps), "InstallLocation"), root)
    assert.equal(stringValue(registry(apps), "DisplayVersion"), artifact.version)
    assert.match(stringValue(registry(apps), "QuietUninstallString"), /installer uninstall --root .* --quiet$/)
    assert.equal(stringValue(registry(environment), "Path"), join(root, "bin"))
    checkProtected()
    const info = JSON.parse(pass(join(root, "bin", "cudia.exe"), ["installation", "info"], { cwd: dir }))
    assert.equal(info.state.selectedReleaseId, built.releaseId)
    assert.equal(info.trustSha256, built.trust.trustSha256)
    await absent(join(root, "state", "wizard-pending.json"))
    await absent(join(root, "state", "install-pending.json"))
    const user = join(dir, "private user")
    await mkdir(user)
    const database = new Map()
    const session = "test-only session and credentials; preserve bytes"
    await writeFile(join(user, "sessions.db"), session)
    await writeFile(join(root, "personal-note.txt"), session)
    const unknown = join(root, "versions", built.releaseId, "defaults", "personal-note.txt")
    if (process.env.CUDIA_REAL_ENGINE) {
      await writeFile(
        join(user, "opencode.json"),
        JSON.stringify({
          model: "smoke/smoke",
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "test-only" },
              models: { smoke: { name: "Fixture", limit: { context: 20000, output: 1000 } } },
            },
          },
        }),
      )
      const env = {
        PATH: join(process.env.SystemRoot, "System32"),
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: dir,
        TMP: dir,
        USERPROFILE: user,
        HOME: user,
        APPDATA: user,
        LOCALAPPDATA: user,
        OPENCODE_TEST_HOME: user,
        OPENCODE_CONFIG_DIR: user,
        XDG_CONFIG_HOME: user,
        XDG_DATA_HOME: user,
        XDG_CACHE_HOME: join(user, "cache"),
        XDG_STATE_HOME: join(user, "state"),
        OPENCODE_DB: join(user, "engine.sqlite"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      }
      assert.match(pass(join(root, "bin", "cudia.exe"), ["--version"], { cwd: user, env, timeout: 30_000 }), /cudia\./)
      t.diagnostic("Real engine --version passed from unrelated cwd with minimal PATH and isolated profile")
      const probe = createServer()
      await new Promise((done) => probe.listen(0, "127.0.0.1", done))
      const port = probe.address().port
      await new Promise((done) => probe.close(done))
      // Spawn the installed engine directly so teardown owns one precise image/PID.
      const engine = join(root, "versions", built.releaseId, "runtime", "engine.exe")
      // libuv needs the extended Windows spelling when this owned fixture exceeds MAX_PATH.
      // The installed Go bootstrap already launches the same long path successfully.
      const engineImage = toNamespacedPath(engine)
      const server = spawn(engineImage, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: user,
        env,
        windowsHide: true,
        stdio: "ignore",
      })
      let exitError
      const exited = once(server, "exit").catch((error) => {
        exitError = error
      })
      await once(server, "spawn")
      try {
        let ready = false
        for (let attempt = 0; attempt < 100; attempt++) {
          assert.equal(server.exitCode, null, "Owned engine exited before readiness")
          const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }).catch(
            () => undefined,
          )
          if (health?.ok) {
            ready = true
            break
          }
          await setTimeout(100)
        }
        assert.equal(ready, true, "Owned real engine did not become ready")
        const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: user } }),
        })
        assert.equal(created.status, 200, await created.clone().text())
        assert.equal(
          typeof (await created.json()).data.id,
          "string",
          "Real idle V2 session must be persisted without a prompt",
        )
        const refused = run(join(root, "maintenance", "launcher.exe"), [
          "installer",
          "preflight-uninstall",
          "--root",
          root,
        ])
        assert.notEqual(refused.status, 0, "Native uninstall preflight must refuse a live installed engine")
        assert.equal(server.exitCode, null, "Native refusal must leave the owned running engine alive")
        assert.equal(stringValue(registry(apps), "InstallLocation"), root)
        assert.equal(hash(await readFile(engine)), profile.realEngine)
      } finally {
        assert.equal(server.spawnfile, engineImage)
        assert.notEqual(server.pid, 9764, "Never signal the pre-existing user process")
        if (server.pid && server.exitCode === null) server.kill()
        await exited
        if (exitError) throw exitError
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = join(user, `engine.sqlite${suffix}`)
        const bytes = await readFile(file).catch((error) => {
          if (error.code !== "ENOENT") throw error
        })
        if (bytes) database.set(file, hash(bytes))
      }
      assert.equal(database.has(join(user, "engine.sqlite")), true, "Real Core SQLite database must exist")
      t.diagnostic("Real engine live-process refusal passed; only the exact test-owned engine PID was stopped")
    } else t.diagnostic("Real engine check not requested; package uses where.exe as a PE fixture")
    const repaired = setup()
    assert.equal(repaired.status, 0, repaired.stderr + repaired.stdout)
    assert.equal(stringValue(registry(environment), "Path"), join(root, "bin"), "Repair must not duplicate PATH")
    assert.equal(await readFile(join(root, "personal-note.txt"), "utf8"), session)
    await writeFile(unknown, session)
    const stateNote = join(root, "state", "personal-maintenance-note.txt")
    await writeFile(stateNote, session)
    const automaticCache = join(root, "state", "update-check.json")
    // A recognized cache is owned metadata even when its last check failed.
    // This fixture validates compiled cleanup, not an actual failed HTTP request.
    await writeFile(
      automaticCache,
      JSON.stringify({
        schema: 1,
        root: root.toLowerCase(),
        binding: hash(root),
        checkedAt: "2026-10-15T00:00:00Z",
        result: "failed",
        envelope: "",
      }),
    )
    checkProtected()
    pass(join(root, "maintenance", "launcher.exe"), ["installer", "uninstall", "--root", root, "--quiet"], {
      env: { ...process.env, TEMP: dir, TMP: dir },
    })
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (registry(apps) === null && !(await lstat(join(root, "bin", "cudia.exe")).catch(() => null))) break
      await setTimeout(200)
    }
    assert.equal(registry(apps), null)
    await absent(join(root, "bin", "cudia.exe"))
    await absent(join(root, "maintenance", "launcher.exe"))
    await absent(join(root, "versions", built.releaseId, "runtime", "engine.exe"))
    assert.equal(stringValue(registry(environment), "Path"), undefined)
    await waitForOwnedCleanup(dir, recovery)
    for (const name of [
      "wizard-owner.json",
      "wizard-uninstalled.json",
      "wizard-uninstall.json",
      "path-ownership.json",
      "path-ownership.lock",
      "lifetime.lock",
      "update.lock",
      "update-check.json",
    ])
      await absent(join(root, "state", name))
    for (const file of [join(user, "sessions.db"), join(root, "personal-note.txt"), stateNote, unknown])
      assert.equal(await readFile(file, "utf8"), session)
    for (const [file, expected] of database)
      assert.equal(hash(await readFile(file)), expected, "Real idle V2 session database bytes changed during uninstall")
    if (database.size)
      t.diagnostic(
        "Real idle V2 session SQLite database and existing WAL/SHM bytes survived native uninstall unchanged; no prompt was submitted",
      )
    checkProtected()

    // With no unknown files, all of this installation's directories can disappear.
    const cleanRoot = join(dir, "clean uninstall ü")
    const cleanInstalled = setup(cleanRoot)
    assert.equal(cleanInstalled.status, 0, cleanInstalled.stderr + cleanInstalled.stdout)
    pass(join(cleanRoot, "maintenance", "launcher.exe"), ["installer", "uninstall", "--root", cleanRoot, "--quiet"], {
      env: { ...process.env, TEMP: dir, TMP: dir },
    })
    await waitForOwnedCleanup(dir, recovery)
    await absent(cleanRoot)
    checkProtected()
    t.diagnostic("Owned uninstall helpers, receipts and locks were removed; unknown state files survived")

    // Real os.Exit skips Go defers. Each command and boundary gets a separate
    // installed fixture, including native entry from a mixed restoration state.
    const boundaries = [
      ...[
        "cleanup-handoff-intent",
        "cleanup-handoff-command:UninstallString",
        "cleanup-handoff-command:QuietUninstallString",
        "cleanup-handoff-complete",
      ].map((point) => ({ mode: "crash", point })),
      ...[
        "cleanup-native-restore-intent",
        "cleanup-native-restored:UninstallString",
        "cleanup-native-restored:QuietUninstallString",
        "cleanup-native-restore-complete",
      ].map((point) => ({ mode: "restore", point })),
    ]
    for (const [index, boundary] of boundaries.entries()) {
      for (const commandName of ["UninstallString", "QuietUninstallString"]) {
        const crashRoot = join(dir, `crash ${index} ${commandName} ü`)
        assert.equal(setup(crashRoot).status, 0)
        await rm(observedFault, { force: true })
        await writeFile(fault, `${boundary.mode}:${boundary.point}`)
        pass(
          join(crashRoot, "maintenance", "launcher.exe"),
          ["installer", "uninstall", "--root", crashRoot, "--quiet"],
          { env: { ...process.env, TEMP: dir, TMP: dir } },
        )
        const crashDeadline = Date.now() + 30_000
        while (Date.now() < crashDeadline && !(await readFile(observedFault, "utf8").catch(() => undefined)))
          await setTimeout(100)
        assert.equal(
          await readFile(observedFault, "utf8"),
          boundary.point,
          "Actual child did not reach its abrupt-exit boundary",
        )
        await rm(fault)
        const beforeRetry = registry(apps)
        const journal = cleanupJournal(beforeRetry)
        const firstCommand = stringValue(beforeRetry, commandName)
        const needsRestore =
          journal.mode === "external-remove" &&
          !journal.handoff &&
          firstCommand.toLowerCase().startsWith(`"${powershell}"`.toLowerCase())
        const owned = new Map()
        if (needsRestore)
          for (const file of journal.files) {
            assert.equal(file.state, "confirmed")
            owned.set(file.path, hash(await readFile(file.path)))
          }
        const firstRetry = registeredCommand(beforeRetry, commandName)
        if (needsRestore) {
          assert.notEqual(firstRetry.status, 0, "Incomplete handoff must request a second invocation")
          assert.match(firstRetry.stderr + firstRetry.stdout, /retry|repeat|repita|novamente/i)
          for (const [file, expected] of owned)
            assert.equal(hash(await readFile(file)), expected, "Registry handoff repair must not delete or alter files")
          const restored = registry(apps)
          const restoredJournal = cleanupJournal(restored)
          assert.equal(restoredJournal.mode, "native")
          assert.equal(restoredJournal.handoff, false)
          assert.equal(
            registeredCommand(restored, commandName).status,
            0,
            "Restored literal native command must actually resume",
          )
        } else assert.equal(firstRetry.status, 0, firstRetry.error?.message ?? firstRetry.stderr + firstRetry.stdout)
        await waitForOwnedCleanup(dir, recovery)
        await absent(crashRoot)
        assert.equal(registry(apps), null)
        checkProtected()
        t.diagnostic(`Abrupt ${boundary.mode}:${boundary.point}; literal ${commandName} recovered`)
      }
    }
    await rm(observedFault, { force: true })

    // The same compiled wizard must surface a native finalization failure and roll back.
    await writeFile(fault, "fail-finalize")
    const failedRoot = join(dir, "finalize failure ü")
    const failed = setup(failedRoot)
    assert.equal(failed.status, 73, failed.stderr + failed.stdout)
    assert.equal(registry(apps), null)
    assert.equal(stringValue(registry(environment), "Path"), undefined)
    await absent(join(failedRoot, "state", "activation.json"))
    await absent(join(failedRoot, "bin", "cudia.exe"))
    await absent(join(failedRoot, "maintenance", "launcher.exe"))
    await rm(fault)
    checkProtected()

    // Preserve wizard control flow: modify only its copied bundled input and its
    // generated hash, then compile the already-verified fixture to test runtime trust.
    const bad = JSON.parse(await readFile(join(output, "release.json"), "utf8"))
    bad.signature = Buffer.alloc(64).toString("base64")
    const badBytes = JSON.stringify(bad)
    await writeFile(join(output, "release.json"), badBytes)
    const include = await readFile(join(output, "bundle.iss"), "utf8")
    await writeFile(
      join(output, "bundle.iss"),
      include.replace(/(#define CudiaManifestSHA256 ")[a-f0-9]{64}(")/, `$1${hash(badBytes)}$2`),
    )
    pass(process.env.CUDIA_INNO_COMPILER, ["/Qp", "wizard.iss"], { cwd: output })
    const badRoot = join(dir, "invalid signature ü")
    const badLog = join(dir, "invalid-signature.log")
    const rejected = setup(badRoot, built.installer.path, badLog)
    assert.notEqual(rejected.status, 0, "Compiled wizard must reject invalid release signature")
    assert.match(await readFile(badLog, "utf8"), /cudia: (?:invalid release signature|release signature invalid)/)
    assert.equal(registry(apps), null)
    assert.equal(stringValue(registry(environment), "Path"), undefined)
    await absent(join(badRoot, "state", "activation.json"))
    await absent(join(badRoot, "bin", "cudia.exe"))
    checkProtected()
    t.diagnostic(
      "Silent compiled flow passed. Interactive Portuguese pages and user cancellation require manual visual QA.",
    )
    complete = true
  },
)
