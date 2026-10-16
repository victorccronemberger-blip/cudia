import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { engineFileRecord, engineTextRecord, writeEngineReceipt } from "../../script/engine-receipt"

test("engine receipt binds the actual executable and separately bounded inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cudia-engine-receipt-"))
  try {
    const file = path.join(root, "engine.exe")
    await writeFile(file, Buffer.alloc(8192, 31))
    const evidence = {
      version: "1.2.3+fixture",
      platform: "windows",
      arch: "x64",
      variant: "normal",
      executable: file,
      output: await engineFileRecord(file),
      build: { bunVersion: Bun.version, discoveryPass: true },
      inventory: { repository: { head: "a".repeat(40), files: [] }, bundler: { inputs: [] } },
    }
    const receipt = await writeEngineReceipt(root, evidence)
    expect(receipt.output).toEqual(await engineFileRecord(file))
    expect(receipt.output.size).toBe(8192)
    expect(receipt.inventory).toEqual({
      path: "engine-inputs.json",
      ...engineTextRecord(await readFile(path.join(root, "engine-inputs.json"), "utf8")),
    })
    expect(JSON.parse(await readFile(path.join(root, "engine-build.json"), "utf8"))).toEqual(receipt)
    expect(JSON.stringify(receipt)).not.toContain(root)
    expect(receipt.coverage.hermetic).toBe(false)
    expect(receipt.coverage.independentlyVerified).toBe(false)
    await expect(writeEngineReceipt(root, evidence)).rejects.toMatchObject({ code: "EEXIST" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("changed final images and oversized inventories cannot receive a build receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cudia-engine-receipt-reject-"))
  try {
    const file = path.join(root, "engine.exe")
    await writeFile(file, "compiled image")
    const evidence = {
      version: "1.0.0",
      platform: "windows",
      arch: "x64",
      variant: "normal",
      executable: file,
      output: await engineFileRecord(file),
      build: {},
      inventory: {},
    }
    await writeFile(file, "tampered image")
    await expect(writeEngineReceipt(root, evidence)).rejects.toThrow("Final executable changed")
    await expect(readFile(path.join(root, "engine-build.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      writeEngineReceipt(root, { ...evidence, inventory: { data: "x".repeat(4 * 1024 * 1024) } }),
    ).rejects.toThrow("inventory exceeds 4 MiB")
    await expect(readFile(path.join(root, "engine-inputs.json"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
