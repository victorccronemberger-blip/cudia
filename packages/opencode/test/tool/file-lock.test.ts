import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { withFileLocks } from "../../src/tool/file-lock"

describe("tool file locks", () => {
  test("serializes same-file read-modify-write effects without blocking other files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cudia-file-lock-"))
    const shared = path.join(directory, "shared.txt")
    const unrelated = path.join(directory, "unrelated.txt")
    await fs.writeFile(shared, "initial\n", "utf-8")

    let enteredFirst!: () => void
    let releaseFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => (enteredFirst = resolve))
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    let secondObserved = ""

    try {
      const first = Effect.runPromise(
        withFileLocks(
          [shared],
          Effect.promise(async () => {
            const before = await fs.readFile(shared, "utf-8")
            enteredFirst()
            await firstGate
            await fs.writeFile(shared, `${before}first\n`, "utf-8")
          }),
        ),
      )
      await firstEntered

      const second = Effect.runPromise(
        withFileLocks(
          [shared],
          Effect.promise(async () => {
            secondObserved = await fs.readFile(shared, "utf-8")
            await fs.writeFile(shared, `${secondObserved}second\n`, "utf-8")
          }),
        ),
      )
      await Effect.runPromise(
        withFileLocks(
          [unrelated],
          Effect.promise(() => fs.writeFile(unrelated, "independent\n", "utf-8")),
        ),
      )

      expect(await fs.readFile(unrelated, "utf-8")).toBe("independent\n")
      releaseFirst()
      await Promise.all([first, second])

      expect(secondObserved).toBe("initial\nfirst\n")
      expect(await fs.readFile(shared, "utf-8")).toBe("initial\nfirst\nsecond\n")
    } finally {
      releaseFirst?.()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
