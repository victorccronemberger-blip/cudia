import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { ContextManifest } from "@opencode-ai/core/harness/context-manifest"
import type { ContextAudit } from "@opencode-ai/core/harness/audit"
import type { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const revisions = [
  "\uFEFFORIGIN_ALPHA_67AB 😀\r\n",
  "ORIGIN_BETA_32F9 界\n",
  "ORIGIN_GAMMA_71B2 🧪\n",
  "ORIGIN_DELTA_9D43\n",
]
type CapturedRequest = { messages: { role: string; content: unknown }[] }
type Epoch = { baseline: string; baseline_manifest: string | null; snapshot: string; baseline_seq: number }
type Update = { id: string; type: string; text: string; contextManifest?: ContextManifestSchema.Manifest }

test.skipIf(candidate === undefined)(
  "compiled native context origins survive updates, restart, removal and compaction without entering the model prompt",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-context-manifest-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    const data = path.join(temporary, "data")
    const cache = path.join(temporary, "cache")
    const state = path.join(temporary, "state")
    const filename = path.join(workspace, "AGENTS.md")
    const database = path.join(data, "candidate.sqlite")
    const captured: CapturedRequest[] = []
    let provider: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let compacting = false
    try {
      await Promise.all(
        [workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })),
      )
      await writeFile(filename, revisions[0]!, "utf8")
      const canonicalFile = await realpath(filename)
      const environment = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: temporary,
        TMP: temporary,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        XDG_STATE_HOME: state,
        APPDATA: config,
        LOCALAPPDATA: data,
        OPENCODE_TEST_HOME: temporary,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: database,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
        CUDIA_CONTEXT_MODE: "lean",
        CUDIA_CONTEXT_AUDIT: "summary",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(temporary, "no-global-git-config"),
      }
      const git = Bun.spawn({
        cmd: ["git", "init", "--quiet"],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      expect(await git.exited).toBe(0)
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          captured.push((await request.json()) as CapturedRequest)
          return completion(compacting ? "## Objective\nCONTEXT_ORIGIN_CHECKPOINT_OK" : "CONTEXT_ORIGIN_REPLY_OK")
        },
      })
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          compaction: { keep: { tokens: 256 }, buffer: 0 },
          model: "smoke/smoke",
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "Context manifest fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )
      const start = async () => {
        const port = await availablePort()
        child = Bun.spawn({
          cmd: [candidate, "--load-instructions", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
          cwd: workspace,
          env: environment,
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        const base = `http://127.0.0.1:${port}`
        await poll(
          async () =>
            (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))
              ?.status === 200,
          child,
          "server health",
        )
        return base
      }
      let base = await start()
      const created = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: workspace } }),
      })
      expect(created.status).toBe(200)
      const sessionID = ((await created.json()) as { data: { id: string } }).data.id
      const epoch = () => {
        const db = new Database(database, { readonly: true })
        try {
          const row = db
            .query<
              Epoch,
              [string]
            >("SELECT baseline, baseline_manifest, snapshot, baseline_seq FROM session_context_epoch WHERE session_id = ?")
            .get(sessionID)
          if (!row) throw new Error("Missing durable epoch")
          return row
        } finally {
          db.close()
        }
      }
      const audit = async () => {
        const serialized = await readFile(path.join(state, "opencode", "cudia-context-latest.json"), "utf8")
        const report = JSON.parse(serialized) as ContextAudit.Report
        expect(report.version).toBe(2)
        expect(report.runtime).toBe("v2")
        expect(report.sessionID).toBe(sessionID)
        expect(report.contentIncluded).toBe(false)
        expect(report.boundary).toContain("not a wire capture")
        for (const revision of revisions) expect(serialized).not.toContain(revision.trim())
        return report
      }
      const prompt = async () => {
        const target = captured.length + 1
        const response = await fetch(`${base}/api/session/${sessionID}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: {
              text: "Reply normally for this local protocol fixture. " + "Retained fixture context. ".repeat(100),
            },
          }),
        })
        expect(response.status).toBe(200)
        await poll(
          async () => {
            if (captured.length < target) return false
            const response = await fetch(`${base}/api/session/active`)
            const active = (await response.json()) as { data: Record<string, unknown> }
            return !Object.hasOwn(active.data, sessionID)
          },
          child!,
          "prompt completion",
        )
        expect(captured).toHaveLength(target)
      }
      const updates = async () => {
        const response = await fetch(`${base}/api/session/${sessionID}/message?order=asc`)
        expect(response.status).toBe(200)
        return ((await response.json()) as { data: Update[] }).data.filter((message) => message.type === "system")
      }
      const checkpoint = () => {
        const db = new Database(database, { readonly: true })
        try {
          const row = db
            .query<
              { id: string; data: string },
              [string]
            >("SELECT id, data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1")
            .get(sessionID)
          if (!row) throw new Error("Missing persisted compaction checkpoint")
          return { id: row.id, ...(JSON.parse(row.data) as { summary: string; recent: string }) }
        } finally {
          db.close()
        }
      }
      const origin = (text: string, manifest: unknown, expected: string) => {
        expect(ContextManifest.verify(text, manifest)).toBe("valid")
        const value = manifest as ContextManifestSchema.Manifest
        const file = value.parts
          .flatMap((part) => part.origins)
          .find((item) => item.kind === "file" && item.id === canonicalFile)
        expect(file).toBeDefined()
        if (!file) throw new Error("Missing actual file origin")
        expect(text.slice(file.start, file.end)).toBe(expected)
        expect(file.sha256).toBe(ContextManifest.describe(expected).sha256)
        expect(file.bytes).toBe(Buffer.byteLength(expected))
      }

      await prompt()
      const initial = epoch()
      const initialManifest = JSON.parse(initial.baseline_manifest!) as ContextManifestSchema.Manifest
      origin(initial.baseline, initialManifest, revisions[0]!)
      expect((await audit()).instructions.find((item) => item.source === "context-baseline")).toMatchObject({
        originState: "valid",
        baselineSeq: initial.baseline_seq,
        contextManifest: initialManifest,
      })
      expect(systemText(captured.at(-1)!)).toContain(initial.baseline)

      await writeFile(filename, revisions[1]!, "utf8")
      await prompt()
      expect(epoch().baseline).toBe(initial.baseline)
      expect(epoch().baseline_manifest).toBe(initial.baseline_manifest)
      const beta = (await updates()).at(-1)!
      origin(beta.text, beta.contextManifest, revisions[1]!)
      expect((await audit()).instructions.find((item) => item.messageID === beta.id)).toMatchObject({
        source: "context-update",
        originState: "valid",
        contextManifest: beta.contextManifest,
      })
      expect(systemText(captured.at(-1)!)).toContain(initial.baseline)
      expect(userText(captured.at(-1)!)).toContain(`<system-update>\n${beta.text}\n</system-update>`)
      const db = new Database(database, { readonly: true })
      try {
        const events = db
          .query<
            { data: string },
            [string]
          >("SELECT data FROM event WHERE aggregate_id = ? AND type = 'session.next.context.updated.1' ORDER BY seq")
          .all(sessionID)
        expect(
          events.some((row) => {
            const event = JSON.parse(row.data) as Update & { messageID: string }
            return event.messageID === beta.id && ContextManifest.verify(event.text, event.contextManifest) === "valid"
          }),
        ).toBe(true)
      } finally {
        db.close()
      }

      // Restart only this fixture's child; its database and fake provider remain isolated and intact.
      child!.kill()
      await child!.exited
      child = undefined
      base = await start()
      await prompt()
      expect(epoch().baseline_manifest).toBe(initial.baseline_manifest)
      expect((await updates()).find((item) => item.id === beta.id)?.contextManifest).toEqual(beta.contextManifest)
      expect((await audit()).instructions.find((item) => item.messageID === beta.id)?.contextManifest).toEqual(
        beta.contextManifest,
      )
      expect(userText(captured.at(-1)!)).toContain(`<system-update>\n${beta.text}\n</system-update>`)

      await writeFile(filename, revisions[2]!, "utf8")
      await prompt()
      const gamma = (await updates()).at(-1)!
      origin(gamma.text, gamma.contextManifest, revisions[2]!)
      expect(epoch().baseline_manifest).toBe(initial.baseline_manifest)
      expect(userText(captured.at(-1)!)).toContain(`<system-update>\n${beta.text}\n</system-update>`)
      expect(userText(captured.at(-1)!)).toContain(`<system-update>\n${gamma.text}\n</system-update>`)

      await rm(filename)
      await prompt()
      const removed = (await updates()).at(-1)!
      expect(ContextManifest.verify(removed.text, removed.contextManifest)).toBe("valid")
      expect(removed.contextManifest?.parts).toContainEqual(
        expect.objectContaining({ producer: "core/instructions", phase: "removed", origins: [] }),
      )

      compacting = true
      const compactTurn = captured.length
      const compacted = await fetch(`${base}/api/session/${sessionID}/compact`, { method: "POST" })
      expect(compacted.status).toBe(204)
      compacting = false
      expect(captured).toHaveLength(compactTurn + 1)
      const compactRequest = captured[compactTurn]!
      const compactWireMessages = messageTexts(compactRequest, "user")
      expect(compactWireMessages).toHaveLength(1)
      const compactPrompt = compactWireMessages[0]!
      expect(compactPrompt.length).toBeGreaterThan(0)
      const compactCheckpoint = checkpoint()
      const compactAudit = await audit()
      expect(compactAudit).toMatchObject({ purpose: "compaction", instructions: [], contentIncluded: false })
      expect(compactAudit.compactionMessageID).toBe(compactCheckpoint.id)
      const compactSource = compactAudit.messageSources?.find((item) => item.source === "compaction-prompt")
      expect(compactSource).toMatchObject({ source: "compaction-prompt", role: "user", messageIndex: 0, partIndex: 0 })
      expect(compactSource?.bytes).toBe(Buffer.byteLength(compactPrompt, "utf8"))
      expect(compactSource?.sha256).toBe(createHash("sha256").update(compactPrompt, "utf8").digest("hex"))
      expect(compactSource).not.toHaveProperty("content")
      const compactAuditText = JSON.stringify(compactAudit)
      expect(compactAuditText).not.toContain("Reply normally for this local protocol fixture.")
      expect(compactAuditText).not.toContain("Retained fixture context.")
      expect(compactAuditText).not.toContain("CONTEXT_ORIGIN_CHECKPOINT_OK")

      await writeFile(filename, revisions[3]!, "utf8")
      await prompt()
      const replaced = epoch()
      expect(replaced.baseline_seq).toBeGreaterThan(initial.baseline_seq)
      expect(replaced.baseline_manifest).not.toBe(initial.baseline_manifest)
      origin(replaced.baseline, JSON.parse(replaced.baseline_manifest!), revisions[3]!)
      const finalAudit = await audit()
      expect(finalAudit).toMatchObject({ purpose: "main", contentIncluded: false })
      expect(finalAudit.compactionMessageID).toBeUndefined()
      const checkpointSource = finalAudit.messageSources?.find(
        (item) => item.source === "conversation-checkpoint" && item.messageID === compactCheckpoint.id,
      )
      expect(checkpointSource).toMatchObject({ source: "conversation-checkpoint", role: "user", partIndex: 0 })
      const wireCheckpoint = messageTexts(captured.at(-1)!, "user").find((text) =>
        text.includes("CONTEXT_ORIGIN_CHECKPOINT_OK"),
      )
      expect(wireCheckpoint).toBeDefined()
      expect(checkpointSource?.bytes).toBe(Buffer.byteLength(wireCheckpoint!, "utf8"))
      expect(checkpointSource?.sha256).toBe(createHash("sha256").update(wireCheckpoint!, "utf8").digest("hex"))
      expect(checkpointSource).not.toHaveProperty("content")
      const mainAuditText = JSON.stringify(finalAudit)
      expect(mainAuditText).not.toContain("CONTEXT_ORIGIN_CHECKPOINT_OK")
      expect(mainAuditText).not.toContain("Reply normally for this local protocol fixture.")
      expect(mainAuditText).not.toContain("Retained fixture context.")
      expect(finalAudit.instructions.some((item) => item.source === "context-update")).toBe(false)
      expect(systemText(captured.at(-1)!)).toContain(replaced.baseline)
      expect(systemText(captured.at(-1)!)).not.toContain(beta.text)
      expect(systemText(captured.at(-1)!)).not.toContain(gamma.text)
      expect(userText(captured.at(-1)!)).not.toContain(beta.text)
      expect(userText(captured.at(-1)!)).not.toContain(gamma.text)
      for (const request of captured) {
        expect(JSON.stringify(request.messages)).not.toContain("contextManifest")
        expect(JSON.stringify(request.messages)).not.toContain("hashEncoding")
      }
      expect(captured).toHaveLength(7)
      const inspect = async () => {
        const inspection = Bun.spawn({
          cmd: [candidate, "debug", "context"],
          cwd: workspace,
          env: environment,
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        const watchdog = setTimeout(() => inspection.kill(), 15_000)
        try {
          const [output, error, code] = await Promise.all([
            new Response(inspection.stdout).text(),
            new Response(inspection.stderr).text(),
            inspection.exited,
          ])
          if (code !== 0) throw new Error(`Context inspection failed: ${error}`)
          return JSON.parse(output) as { version: number; instructions: ContextAudit.Report["instructions"] }
        } finally {
          clearTimeout(watchdog)
          if (inspection.exitCode === null) {
            inspection.kill()
            await inspection.exited
          }
        }
      }
      expect(
        (await inspect()).instructions.find((item) => item.source === "context-baseline")?.contextManifest,
      ).toEqual(finalAudit.instructions.find((item) => item.source === "context-baseline")?.contextManifest)
      const reportFile = path.join(state, "opencode", "cudia-context-latest.json")
      const savedReport = await readFile(reportFile, "utf8")
      await writeFile(
        reportFile,
        JSON.stringify({
          ...finalAudit,
          version: 1,
          instructions: finalAudit.instructions.map(
            ({ originState, contextManifest, originOmission, messageID, baselineSeq, ...instruction }) => instruction,
          ),
        }),
        "utf8",
      )
      const legacyReport = await inspect()
      expect(legacyReport.version).toBe(1)
      expect(
        legacyReport.instructions.every((item) => item.originState === "missing" && item.contextManifest === undefined),
      ).toBe(true)
      await writeFile(reportFile, savedReport, "utf8")
      expect(captured).toHaveLength(7)
      console.info(
        "compiled context provenance",
        JSON.stringify({
          providerTurns: captured.length,
          restarts: 1,
          baselineRevisions: 2,
          updateRevisions: 2,
          removalNotices: 1,
        }),
      )
    } finally {
      provider?.stop(true)
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(temporary)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
      if (!root.toLowerCase().startsWith(prefix.toLowerCase()))
        throw new Error("Refusing cleanup outside the temporary directory")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)

function systemText(request: CapturedRequest) {
  return messageText(request, "system")
}

function userText(request: CapturedRequest) {
  return messageText(request, "user")
}

function messageText(request: CapturedRequest, role: string) {
  return messageTexts(request, role).join("\n\n")
}

function messageTexts(request: CapturedRequest, role: string) {
  return request.messages
    .filter((message) => message.role === role)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((part: unknown) =>
                part !== null &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n\n")
          : "",
    )
}

function completion(content: string) {
  const chunks = [{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }].map((chunk) => ({
    id: "chatcmpl-context-origin",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke",
    choices: [{ index: 0, ...chunk }],
  }))
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function poll(check: () => Promise<boolean>, child: ReturnType<typeof Bun.spawn>, label: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label}: child exited ${child.exitCode}`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`${label}: timed out`)
}
