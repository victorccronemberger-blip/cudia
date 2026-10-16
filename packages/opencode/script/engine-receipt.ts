import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, writeFile } from "node:fs/promises"
import path from "node:path"

export async function engineFileRecord(file: string) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Build evidence must name a regular file")
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of createReadStream(file)) {
    size += chunk.length
    hash.update(chunk)
  }
  if (size !== info.size) throw new Error("Build evidence changed while hashing")
  return { size, sha256: hash.digest("hex") }
}

export function engineTextRecord(text: string) {
  return { size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }
}

export async function writeEngineReceipt(
  directory: string,
  evidence: {
    version: string
    platform: string
    arch: string
    variant: string
    executable: string
    output: { size: number; sha256: string }
    build: object
    inventory: object
  },
) {
  const inventory = JSON.stringify(evidence.inventory)
  if (Buffer.byteLength(inventory) > 4 * 1024 * 1024) throw new Error("Engine input inventory exceeds 4 MiB")
  const output = await engineFileRecord(evidence.executable)
  if (output.size !== evidence.output.size || output.sha256 !== evidence.output.sha256)
    throw new Error("Final executable changed before its receipt was written")
  const receipt = {
    schema: 1,
    product: "cudia",
    kind: "engine-build",
    identity: {
      version: evidence.version,
      platform: evidence.platform,
      arch: evidence.arch,
      variant: evidence.variant,
    },
    output,
    build: evidence.build,
    inventory: { path: "engine-inputs.json", ...engineTextRecord(inventory) },
    coverage: {
      repository: "git-listed paths in the declared source scope, checked before and after compilation",
      bundler: "discovered input set and file bytes checked before and after final compilation",
      generated: "explicit virtual files, model data and effective settings frozen for both passes",
      buildPlugins: "explicitly named entry files; transitive runtime reads are not fully inventoried",
      environment: "effective build settings only; unrestricted environment is not captured",
      targetRuntime: "managed by Bun; separate target runtime artifact is not inventoried",
      hermetic: false,
      reproducible: false,
      independentlyVerified: false,
    },
  }
  const bytes = JSON.stringify(receipt, null, 2)
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("Engine build receipt exceeds 1 MiB")
  await writeFile(path.join(directory, "engine-inputs.json"), inventory, { flag: "wx" })
  await writeFile(path.join(directory, "engine-build.json"), bytes, { flag: "wx" })
  return receipt
}
