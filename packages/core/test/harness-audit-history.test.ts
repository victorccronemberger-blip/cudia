import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextHistory } from "@opencode-ai/core/harness/audit-history"
import { metadata } from "@opencode-ai/core/harness/audit-metadata"
import { tmpdir } from "./fixture/tmpdir"

const capture = (sessionID = "ses_history", agent = "compaction") =>
  ContextAudit.report(
    {
      runtime: "v2",
      purpose: "compaction",
      compactionMessageID: "msg_attempt",
      sessionID,
      agent,
      model: { provider: "fixture", id: "fixture" },
      instructions: [{ source: "agent", text: "SYNTHETIC_PRIVATE_INSTRUCTION" }],
      messages: [{ role: "user" }],
      messageSources: [
        { source: "compaction-prompt", role: "user", messageIndex: 0, partIndex: 0, text: "SYNTHETIC_PRIVATE_HISTORY" },
      ],
      tools: [],
    },
    { contextMode: "lean", auditMode: "content" },
    "2026-10-16T17:00:00Z",
  )

describe("Context audit SQLite history", () => {
  test("does not create storage when reading an absent history", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "not-created", ContextHistory.FILE)
    expect(await Effect.runPromise(ContextHistory.read(file))).toBeUndefined()
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("reopens metadata with attempt identity while raw content never enters the database", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    const report = capture()
    const saved = await Effect.runPromise(ContextHistory.append(file, report))
    const page = await Effect.runPromise(ContextHistory.read(file))
    expect(saved.sequence).toBe(1)
    expect(page?.entries).toEqual([{ id: saved.id, sequence: saved.sequence, capture: metadata(report) }])
    expect(page?.entries[0]?.capture).toMatchObject({ compactionMessageID: "msg_attempt", contentIncluded: false })
    expect((await fs.readFile(file)).includes(Buffer.from("SYNTHETIC_PRIVATE"))).toBe(false)
    expect(await fs.readdir(tmp.path)).toEqual([ContextHistory.FILE])
  })

  test("prunes oldest insertions atomically and pages sessions with parameterized cursors", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    const budget = { rows: 2, bytes: 8192, captureBytes: 4096 }
    await Effect.runPromise(ContextHistory.append(file, capture("ses_old"), budget))
    const second = await Effect.runPromise(ContextHistory.append(file, capture("ses_' OR 1=1 --")))
    const third = await Effect.runPromise(ContextHistory.append(file, capture("ses_other")))
    const page = await Effect.runPromise(ContextHistory.read(file, { limit: 1 }))
    expect(page).toMatchObject({
      retained: { count: 2, first: 2, last: 3 },
      pruned: 1,
      entries: [{ id: third.id }],
      nextBefore: 3,
    })
    expect(
      (await Effect.runPromise(ContextHistory.read(file, { before: page!.nextBefore })))?.entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([second.id])
    expect(
      (await Effect.runPromise(ContextHistory.read(file, { sessionID: "ses_' OR 1=1 --" })))?.entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([second.id])
    expect((await Effect.runPromise(ContextHistory.read(file, { sessionID: "ses_old" })))?.entries).toEqual([])
  })

  test("enforces UTF-8 payload retention independently of the row-count budget", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    const report = capture("ses_same_length_0", "ação🌍".repeat(25))
    const bytes = Buffer.byteLength(JSON.stringify(metadata(report)), "utf8")
    const budget = { rows: 100, bytes: bytes * 2, captureBytes: bytes }
    const saved = []
    for (let index = 0; index < 3; index++)
      saved.push(
        await Effect.runPromise(
          ContextHistory.append(file, { ...report, sessionID: `ses_same_length_${index}` }, budget),
        ),
      )
    const page = await Effect.runPromise(ContextHistory.read(file))
    expect(page?.retained).toMatchObject({ count: 2, bytes: bytes * 2 })
    expect(page?.entries.map((entry) => entry.id)).toEqual([saved[2]!.id, saved[1]!.id])
    expect(page?.pruned).toBe(1)
    expect(
      page?.entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.capture), "utf8"), 0),
    ).toBe(page!.retained.bytes)
  })

  test("rejects oversized captures without creating a database or pruning existing evidence", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    const small = capture()
    const bytes = Buffer.byteLength(JSON.stringify(metadata(small)))
    const budget = { rows: 3, bytes: bytes * 2, captureBytes: bytes }
    const large = capture("ses_history", "x".repeat(bytes))
    expect((await Effect.runPromiseExit(ContextHistory.append(file, large, budget)))._tag).toBe("Failure")
    expect(await fs.readdir(tmp.path)).toEqual([])
    await Effect.runPromise(ContextHistory.append(file, small, budget))
    const before = await Effect.runPromise(ContextHistory.read(file))
    expect((await Effect.runPromiseExit(ContextHistory.append(file, large)))._tag).toBe("Failure")
    expect(await Effect.runPromise(ContextHistory.read(file))).toEqual(before)
  })

  test("rejects foreign and future databases without changing their bytes", async () => {
    await using tmp = await tmpdir()
    const foreign = path.join(tmp.path, "foreign.sqlite")
    const database = new Database(foreign)
    database.run("CREATE TABLE operator_data (text TEXT)")
    database.run("INSERT INTO operator_data VALUES ('synthetic preserved value')")
    database.close()
    const bytes = await fs.readFile(foreign)
    expect((await Effect.runPromiseExit(ContextHistory.append(foreign, capture())))._tag).toBe("Failure")
    expect((await Effect.runPromiseExit(ContextHistory.read(foreign)))._tag).toBe("Failure")
    expect(await fs.readFile(foreign)).toEqual(bytes)
    const future = path.join(tmp.path, ContextHistory.FILE)
    await Effect.runPromise(ContextHistory.append(future, capture()))
    const modified = new Database(future)
    modified.run("PRAGMA user_version = 2")
    modified.close()
    const futureBytes = await fs.readFile(future)
    expect((await Effect.runPromiseExit(ContextHistory.append(future, capture())))._tag).toBe("Failure")
    expect((await Effect.runPromiseExit(ContextHistory.read(future)))._tag).toBe("Failure")
    expect(await fs.readFile(future)).toEqual(futureBytes)
  })

  test("rolls back failed insertions, releases connection locks and allows a later capture", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    await Effect.runPromise(ContextHistory.append(file, capture()))
    const before = await Effect.runPromise(ContextHistory.read(file))
    const failing = new Database(file)
    failing.run(
      "CREATE TRIGGER fixture_failure AFTER INSERT ON capture BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
    )
    failing.close()
    expect((await Effect.runPromiseExit(ContextHistory.append(file, capture("ses_failed"))))._tag).toBe("Failure")
    expect(await Effect.runPromise(ContextHistory.read(file))).toEqual(before)
    const recovery = new Database(file)
    recovery.run("DROP TRIGGER fixture_failure")
    recovery.close()
    await Effect.runPromise(ContextHistory.append(file, capture("ses_recovered")))
    expect((await Effect.runPromise(ContextHistory.read(file)))?.retained.count).toBe(2)
  })

  test("bounds lock waiting without committing the contested row and recovers afterward", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    await Effect.runPromise(ContextHistory.append(file, capture()))
    const blocker = new Database(file)
    blocker.run("BEGIN IMMEDIATE")
    try {
      const started = performance.now()
      expect((await Effect.runPromiseExit(ContextHistory.append(file, capture("ses_contested"))))._tag).toBe("Failure")
      expect(performance.now() - started).toBeLessThan(3000)
    } finally {
      blocker.run("ROLLBACK")
      blocker.close()
    }
    expect((await Effect.runPromise(ContextHistory.read(file, { sessionID: "ses_contested" })))?.entries).toEqual([])
    await Effect.runPromise(ContextHistory.append(file, capture("ses_after_lock")))
    expect((await Effect.runPromise(ContextHistory.read(file)))?.retained.count).toBe(2)
  })

  test("bounds complete history pages by bytes and resumes without duplicate or missing retained rows", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    const report = capture("ses_large_metadata", "m".repeat(90_000))
    const saved = []
    for (let index = 0; index < 13; index++) saved.push(await Effect.runPromise(ContextHistory.append(file, report)))
    const page = (await Effect.runPromise(ContextHistory.read(file)))!
    expect(page.entries.length).toBeGreaterThan(0)
    expect(page.entries.length).toBeLessThan(saved.length)
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(ContextHistory.MAX_PAGE_BYTES - 2048)
    expect(page.nextBefore).toBe(page.entries.at(-1)?.sequence)
    const next = (await Effect.runPromise(ContextHistory.read(file, { before: page.nextBefore })))!
    expect([...page.entries, ...next.entries].map((entry) => entry.id)).toEqual(
      saved.toReversed().map((entry) => entry.id),
    )
    expect(next.nextBefore).toBeUndefined()
  })

  test("uses incremental reclamation after pruning without claiming payload bytes equal database size", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ContextHistory.FILE)
    const budget = { rows: 2, bytes: 256_000, captureBytes: 100_000 }
    await Effect.runPromise(ContextHistory.append(file, capture("ses_big_a", "m".repeat(90_000)), budget))
    await Effect.runPromise(ContextHistory.append(file, capture("ses_big_b", "m".repeat(90_000)), budget))
    const before = (await fs.stat(file)).size
    await Effect.runPromise(ContextHistory.append(file, capture("ses_small_a")))
    await Effect.runPromise(ContextHistory.append(file, capture("ses_small_b")))
    const after = (await fs.stat(file)).size
    const db = new Database(file, { readonly: true })
    try {
      expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    } finally {
      db.close()
    }
    expect(after).toBeLessThan(before)
    expect(after).toBeLessThanOrEqual(ContextHistory.MAX_DATABASE_BYTES)
    expect((await Effect.runPromise(ContextHistory.read(file)))?.pruned).toBe(2)
  })
})
