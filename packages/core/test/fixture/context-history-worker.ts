import { mkdir, writeFile } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextHistory } from "@opencode-ai/core/harness/audit-history"
import { metadata } from "@opencode-ai/core/harness/audit-metadata"

const mode = Bun.argv[2]
const filename = Bun.argv[3]!
const limits = { rows: 3, bytes: 8192, captureBytes: 4096 }

if (mode === "worker") {
  const job = Bun.argv[4]!
  const name = Bun.argv[5]!
  const startInitialize = Bun.argv[6]!
  const initialized = Bun.argv[7]!
  const startWrites = Bun.argv[8]!
  const ready = Bun.argv[9]!
  await mkdir(job, { recursive: true })
  await writeFile(ready, "ready")
  await waitFor(() => Bun.file(startInitialize).exists())
  const first = await Effect.runPromise(ContextHistory.append(filename, report(name, 0), limits))
  if (first.retained.count > limits.rows || first.retained.bytes > limits.bytes)
    throw new Error("initialization append exceeded its persisted retention budget")
  await writeFile(initialized, JSON.stringify(first))
  await waitFor(() => Bun.file(startWrites).exists())
  const writes = [first]
  for (let index = 1; index <= 6; index++) {
    const saved = await Effect.runPromise(ContextHistory.append(filename, report(name, index), limits))
    if (saved.retained.count > limits.rows || saved.retained.bytes > limits.bytes)
      throw new Error("append exceeded its persisted retention budget")
    writes.push(saved)
    await writeFile(`${job}/committed-${name}-${index}`, "done")
    const peer = name === "a" ? "b" : "a"
    await waitFor(() => Bun.file(`${job}/committed-${peer}-${index}`).exists())
  }
  const page = await Effect.runPromise(ContextHistory.read(filename, { limit: 20 }))
  console.log(JSON.stringify({ name, writes, page }))
  process.exit(0)
}

if (mode === "crash") {
  const ready = Bun.argv[4]!
  const payload = JSON.stringify(metadata(report("crash", 99)))
  const db = new Database(filename)
  db.run("PRAGMA busy_timeout = 100")
  db.run("BEGIN IMMEDIATE")
  db.query("INSERT INTO capture (id, session_id, bytes, payload) VALUES (?, ?, ?, ?)").run(
    "synthetic-abrupt-process-row",
    "ses_history_process_crash",
    Buffer.byteLength(payload, "utf8"),
    payload,
  )
  await writeFile(ready, "inserted-before-process-exit")
  process.exit(37)
}

throw new Error(`unknown worker mode: ${mode}`)

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

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("worker readiness deadline exceeded")
}
