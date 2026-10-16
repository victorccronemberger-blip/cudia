#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { prepareOutputDirectory } from "./output-directory"
import { assertStableInputs, snapshotBundler, snapshotRepository } from "./engine-inputs"
import { engineFileRecord, engineTextRecord, writeEngineReceipt } from "./engine-receipt"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const provenanceFlag = Script.release || process.argv.includes("--provenance")
if (provenanceFlag && !skipInstall)
  throw new Error("Provenance builds require --skip-install; install frozen dependencies before starting the build")
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const outputArgument = process.argv.indexOf("--output-dir")
if (outputArgument >= 0 && (!process.argv[outputArgument + 1] || process.argv[outputArgument + 1].startsWith("--")))
  throw new Error("--output-dir requires a directory name")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

const outputRoot = await prepareOutputDirectory(dir, outputArgument < 0 ? undefined : process.argv[outputArgument + 1])

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
const repository = path.resolve(dir, "../..")
const source = provenanceFlag ? await snapshotRepository(repository) : undefined
const compiler = provenanceFlag ? await engineFileRecord(process.execPath) : undefined
const buildFiles = provenanceFlag
  ? [
      fileURLToPath(import.meta.resolve("@opentui/solid/bun-plugin")),
      fileURLToPath(import.meta.resolve("@babel/core")),
      fileURLToPath(import.meta.resolve("@opentui/core/parser.worker")),
    ]
  : []
const buildInputs = provenanceFlag ? snapshotBundler(repository, dir, [], {}, buildFiles) : undefined
const receipts: Parameters<typeof writeEngineReceipt>[] = []
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  const targetRoot = path.join(outputRoot, name)
  await mkdir(path.join(targetRoot, "bin"), { recursive: true })

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  const virtual = {
    [treeSitterWorkerPath]: treeSitterWorker,
    ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
  }
  const compile = async (outfile: string) => {
    const options = {
      conditions: ["bun", "node"],
      tsconfig: "./tsconfig.json",
      plugins: [createSolidTransformPlugin()],
      external: ["node-gyp"],
      format: "esm",
      minify: true,
      sourcemap: sourcemapsFlag ? "linked" : "none",
      splitting: true,
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
        target: name.replace(pkg.name, "bun") as any,
        outfile,
        execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
        windows: {},
      },
      files: { ...virtual },
      entrypoints: [
        "./src/index.ts",
        workerPath,
        treeSitterWorkerPath,
        ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
      ],
      define: {
        FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
        OPENCODE_VERSION: `'${Script.version}'`,
        OPENCODE_MODELS_DEV: generated.modelsData,
        OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
        OPENCODE_WORKER_PATH: workerPath,
        OPENCODE_CHANNEL: `'${Script.channel}'`,
        OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
        ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
      },
    } satisfies Bun.BuildConfig
    const recipe = {
      ...options,
      plugins: ["@opentui/solid/bun-plugin: fresh instance per pass"],
      compile: { ...options.compile, outfile: "<target-executable>" },
      files: Object.fromEntries(Object.entries(options.files).map(([name, text]) => [name, engineTextRecord(text)])),
      define: { ...options.define, OPENCODE_MODELS_DEV: engineTextRecord(options.define.OPENCODE_MODELS_DEV) },
    }
    const result = await Bun.build({ ...options, ...(provenanceFlag ? { metafile: true } : {}) })
    if (!result.success) throw new Error(`Compilation failed for ${name}`)
    return { result, recipe }
  }
  const inputNames = (result: object) => {
    if (
      !("metafile" in result) ||
      !result.metafile ||
      typeof result.metafile !== "object" ||
      !("inputs" in result.metafile) ||
      !result.metafile.inputs ||
      typeof result.metafile.inputs !== "object" ||
      Array.isArray(result.metafile.inputs)
    )
      throw new Error("Bun did not return the requested build input inventory")
    return Object.keys(result.metafile.inputs)
  }
  const discovery = provenanceFlag ? await mkdtemp(path.join(outputRoot, ".cudia-provenance-")) : undefined
  const checked = discovery
    ? await (async () => {
        try {
          const first = await compile(path.join(discovery, "opencode"))
          assertStableInputs(buildInputs, snapshotBundler(repository, dir, [], {}, buildFiles), "Build plugin entries")
          const before = await snapshotBundler(repository, dir, inputNames(first.result), virtual, buildFiles)
          const final = await compile(path.join(targetRoot, "bin/opencode"))
          assertStableInputs(first.recipe, final.recipe, "Effective build settings")
          assertStableInputs(
            before,
            await snapshotBundler(repository, dir, inputNames(final.result), virtual, buildFiles),
            "Bundler inputs",
          )
          assertStableInputs(source, await snapshotRepository(repository), "Repository inputs")
          assertStableInputs(compiler, await engineFileRecord(process.execPath), "Bun executable")
          assertStableInputs(buildInputs, snapshotBundler(repository, dir, [], {}, buildFiles), "Build plugin entries")
          return { inputs: before, recipe: final.recipe }
        } finally {
          await rm(discovery, { recursive: true, force: true })
        }
      })()
    : undefined
  if (!discovery) await compile(path.join(targetRoot, "bin/opencode"))

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign ad-hoc; release CI re-signs with Developer ID.
  if (item.os === "darwin" && process.platform === "darwin") {
    await $`codesign --force --sign - ${path.join(targetRoot, "bin/opencode")}`
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = path.join(targetRoot, "bin/opencode")
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      if (versionOutput.trim() !== Script.version)
        throw new Error("Compiled engine version differs from build identity")
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await rm(path.join(targetRoot, "bin/tui"), { recursive: true, force: true })
  await Bun.file(path.join(targetRoot, "package.json")).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
  if (checked)
    receipts.push([
      targetRoot,
      {
        version: Script.version,
        platform: item.os === "win32" ? "windows" : item.os,
        arch: item.arch,
        variant: item.avx2 === false ? "baseline" : "normal",
        executable: path.join(targetRoot, item.os === "win32" ? "bin/opencode.exe" : "bin/opencode"),
        output: await engineFileRecord(
          path.join(targetRoot, item.os === "win32" ? "bin/opencode.exe" : "bin/opencode"),
        ),
        build: {
          bunVersion: Bun.version,
          bunExecutable: compiler,
          recipe: checked.recipe,
          settingsSha256: engineTextRecord(JSON.stringify(checked.recipe)).sha256,
          discoveryPass: true,
          repositoryHead: source?.head,
        },
        inventory: { schema: 1, repository: source, bundler: checked.inputs },
      },
    ])
}

if (receipts.length) {
  assertStableInputs(source, await snapshotRepository(repository), "Repository inputs")
  assertStableInputs(buildInputs, snapshotBundler(repository, dir, [], {}, buildFiles), "Build plugin entries")
  assertStableInputs(compiler, await engineFileRecord(process.execPath), "Bun executable")
  for (const receipt of receipts) await writeEngineReceipt(...receipt)
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(path.join(outputRoot, key, "bin"))
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(path.join(outputRoot, key, "bin"))
    }
  }
  const archives = Object.keys(binaries).map((key) =>
    path.join(outputRoot, key + (key.includes("linux") ? ".tar.gz" : ".zip")),
  )
  await $`gh release upload v${Script.version} ${archives} --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
