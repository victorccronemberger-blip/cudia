import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextHistory } from "@opencode-ai/core/harness/audit-history"
import { tmpdir } from "./fixture/tmpdir"

const packageDirectory = path.resolve(import.meta.dir, "..")
const worker = path.join(import.meta.dir, "fixture/context-history-worker.ts")
const limits = { rows: 3, bytes: 8192, captureBytes: 4096 }

describe("Context history across processes", () => {
  test(
    "initializes concurrently, bounds interleaved writes, and recovers a process crash",
    async () => {
      await using tmp = await tmpdir()
      const job = path.join(tmp.path, "context-history-runtime-jobs")
      await mkdir(job)
      const filename = path.join(job, "history.sqlite")
      const initStart = path.join(job, "initialize")
      const writesStart = path.join(job, "write")
      const env = {
        PATH: process.env.PATH ?? "C:\\Windows\\System32",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        TEMP: job,
        TMP: job,
        USERPROFILE: job,
        HOME: job,
        APPDATA: path.join(job, "AppData/Roaming"),
        LOCALAPPDATA: path.join(job, "AppData/Local"),
        XDG_CONFIG_HOME: path.join(job, "xdg/config"),
        XDG_CACHE_HOME: path.join(job, "xdg/cache"),
        XDG_DATA_HOME: path.join(job, "xdg/data"),
        OPENCODE_DB: ":memory:",
      }
      const children: Array<{ child: ReturnType<typeof Bun.spawn>; settled: boolean }> = []
      const spawnOwned = (args: string[]) => {
        const child = Bun.spawn([process.execPath, worker, ...args], {
          cwd: packageDirectory,
          env,
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        const owned = { child, settled: false }
        children.push(owned)
        return owned
      }
      const waitExit = (owned: (typeof children)[number]) =>
        owned.child.exited.then((code) => {
          owned.settled = true
          return code
        })
      const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          if (await predicate()) return
          await Bun.sleep(20)
        }
        throw new Error(`timed out waiting for ${label}`)
      }
      const exists = (file: string) => Bun.file(file).exists()
      try {
        const readyA = path.join(job, "ready-a")
        const readyB = path.join(job, "ready-b")
        const initializedA = path.join(job, "initialized-a.json")
        const initializedB = path.join(job, "initialized-b.json")
        const workerArgs = (name: string, ready: string) => [
          "worker",
          filename,
          job,
          name,
          initStart,
          path.join(job, `initialized-${name}.json`),
          writesStart,
          ready,
        ]
        const workerA = spawnOwned(workerArgs("a", readyA))
        const workerB = spawnOwned(workerArgs("b", readyB))
        await waitFor(async () => (await exists(readyA)) && (await exists(readyB)), "both pre-initialization workers")
        await writeFile(initStart, "start")
        await waitFor(
          async () => (await exists(initializedA)) && (await exists(initializedB)),
          "both first committed appends",
        )
        const firstA = JSON.parse(await readFile(initializedA, "utf8")) as {
          id: string
          sequence: number
          retained: { count: number; bytes: number }
        }
        const firstB = JSON.parse(await readFile(initializedB, "utf8")) as {
          id: string
          sequence: number
          retained: { count: number; bytes: number }
        }
        expect(firstA.id).not.toBe(firstB.id)
        expect(firstA.sequence).not.toBe(firstB.sequence)
        expect(firstA.retained.count).toBeLessThanOrEqual(limits.rows)
        expect(firstB.retained.count).toBeLessThanOrEqual(limits.rows)
        expect(firstA.retained.bytes).toBeLessThanOrEqual(limits.bytes)
        expect(firstB.retained.bytes).toBeLessThanOrEqual(limits.bytes)
        await writeFile(writesStart, "start")

        const results = await Promise.all(
          [workerA, workerB].map(async (owned) => {
            const stdout = new Response(owned.child.stdout).text()
            const stderr = new Response(owned.child.stderr).text()
            const [code, out, err] = await Promise.all([waitExit(owned), stdout, stderr])
            if (code !== 0) throw new Error(`history worker failed (${code}): ${err}`)
            return JSON.parse(out) as {
              name: string
              writes: ReadonlyArray<{ id: string; sequence: number; retained: { count: number; bytes: number } }>
            }
          }),
        )
        expect(results.map((result) => result.name).sort()).toEqual(["a", "b"])
        expect(results.every((result) => result.writes.length === 7)).toBe(true)
        expect(
          results.every((result) =>
            result.writes.every((write) => write.retained.count <= limits.rows && write.retained.bytes <= limits.bytes),
          ),
        ).toBe(true)
        const allIds = results.flatMap((result) => result.writes.map((write) => write.id))
        const allSequences = results.flatMap((result) => result.writes.map((write) => write.sequence))
        expect(new Set(allIds).size).toBe(allIds.length)
        expect(new Set(allSequences).size).toBe(allSequences.length)
        const interleaved = await Promise.all(
          Array.from(
            { length: 6 },
            async (_, index) =>
              (await exists(path.join(job, `committed-a-${index + 1}`))) &&
              (await exists(path.join(job, `committed-b-${index + 1}`))),
          ),
        )
        expect(interleaved.every(Boolean)).toBe(true)

        const beforeCrash = await Effect.runPromise(ContextHistory.read(filename, { limit: 20 }))
        expect(beforeCrash?.retained).toMatchObject({ count: limits.rows })
        const crashReady = path.join(job, "crash-ready")
        const crash = spawnOwned(["crash", filename, crashReady])
        await waitFor(() => exists(crashReady), "uncommitted child insert")
        const crashStdout = new Response(crash.child.stdout).text()
        const crashStderr = new Response(crash.child.stderr).text()
        const [crashExit, stdout, stderr] = await Promise.all([waitExit(crash), crashStdout, crashStderr])
        expect({ crashExit, stdout, stderr }).toMatchObject({ crashExit: 37, stdout: "", stderr: "" })
        expect(await Effect.runPromise(ContextHistory.read(filename, { limit: 20 }))).toEqual(beforeCrash)

        const recovery = await Effect.runPromise(ContextHistory.append(filename, report("recovery", 1), limits))
        const afterRecovery = await Effect.runPromise(ContextHistory.read(filename, { limit: 20 }))
        expect(recovery.retained.count).toBeLessThanOrEqual(limits.rows)
        expect(recovery.retained.bytes).toBeLessThanOrEqual(limits.bytes)
        expect(afterRecovery?.entries[0]?.id).toBe(recovery.id)
        expect(afterRecovery?.retained.count).toBeLessThanOrEqual(limits.rows)
        expect(afterRecovery?.retained.bytes).toBeLessThanOrEqual(limits.bytes)

        const bytes = await readFile(filename)
        expect(bytes.includes(Buffer.from("SYNTHETIC_RAW_PRIVATE"))).toBe(false)
        expect(bytes.includes(Buffer.from("SYNTHETIC_RAW_MESSAGE"))).toBe(false)
        await writeFile(
          path.join(job, "summary.json"),
          JSON.stringify(
            {
              workers: results.map((result) => ({
                name: result.name,
                appendCount: result.writes.length,
                ids: result.writes.map((write) => write.id),
                sequences: result.writes.map((write) => write.sequence),
              })),
              beforeCrash: beforeCrash?.retained,
              crashExit,
              crashRecoveryEqual: true,
              recovery: recovery.retained,
              databaseBytes: bytes.length,
            },
            null,
            2,
          ),
        )
      } finally {
        for (const owned of children) if (!owned.settled) owned.child.kill()
        await Promise.all(children.map(waitExit))
      }
    },
    { timeout: 60_000 },
  )
})

function report(worker: string, index: number) {
  return ContextAudit.report(
    {
      runtime: "v2",
      sessionID: `ses_history_${worker}`,
      agent: "fixture",
      model: { provider: "fixture", id: "synthetic-model" },
      instructions: [{ source: "fixture", text: `SYNTHETIC_RAW_PRIVATE_${worker}_${index}` }],
      messages: [{ role: "user" }],
      messageSources: [
        {
          source: "fixture-message",
          role: "user",
          messageIndex: index,
          partIndex: 0,
          text: `SYNTHETIC_RAW_MESSAGE_${worker}_${index}`,
        },
      ],
      tools: [{ name: `fixture_tool_${worker}_${index}`, description: "synthetic tool metadata" }],
    },
    { contextMode: "lean", auditMode: "content" },
    new Date(1_797_000_000_000 + index).toISOString(),
  )
}
