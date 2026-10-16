import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const candidate = process.env.CUDIA_CANDIDATE_TEST

type Message = {
  info: { id: string; role: string; summary?: boolean; error?: unknown }
  parts: { type: string; text?: string; snapshot?: string }[]
}

test.skipIf(candidate === undefined)(
  "compiled V1 preserves unreadable goals and compacts without filesystem snapshots",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-recovery-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    const data = path.join(temporary, "data")
    const state = path.join(temporary, "state")
    const trace = path.join(temporary, "git-trace.jsonl")
    let child: ReturnType<typeof Bun.spawn> | undefined
    let provider: ReturnType<typeof Bun.serve> | undefined
    let requests = 0
    let failure: unknown
    let testFailure: unknown
    let base = ""
    try {
      await Promise.all([workspace, config, data, state].map((directory) => mkdir(directory, { recursive: true })))
      const environment = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: temporary,
        TMP: temporary,
        HOME: temporary,
        APPDATA: config,
        LOCALAPPDATA: data,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_STATE_HOME: state,
        OPENCODE_TEST_HOME: temporary,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
        CUDIA_CONTEXT_MODE: "lean",
        CUDIA_CONTEXT_AUDIT: "summary",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(temporary, "no-global-config"),
        GIT_TRACE2_EVENT: trace,
      }
      const git = spawnSync("git", ["-C", workspace, "init", "--quiet"], {
        cwd: os.tmpdir(),
        env: environment,
        stdio: "ignore",
        windowsHide: true,
      })
      expect(git.status).toBe(0)
      expect((await stat(path.join(workspace, ".git"))).isDirectory()).toBe(true)
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            requests++
            const input = (await request.json()) as { messages: unknown[]; tools?: unknown[] }
            expect(requests).toBe(1)
            expect(JSON.stringify(input.messages)).toContain("RECOVERY_SUMMARY_SOURCE")
            expect(input.tools?.length ?? 0).toBe(0)
          } catch (error) {
            failure = error
          }
          const chunks = [
            { delta: { role: "assistant", content: "RECOVERY_CHECKPOINT_OK" } },
            { delta: {}, finish_reason: "stop" },
          ].map((choice) => ({
            id: "chatcmpl-recovery",
            object: "chat.completion.chunk",
            created: 0,
            model: "smoke",
            choices: [{ index: 0, ...choice }],
          }))
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: true,
          formatter: false,
          lsp: false,
          compaction: { auto: false, tail_turns: 0 },
          model: "smoke/smoke",
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "Recovery fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
      )
      const port = await availablePort()
      base = `http://127.0.0.1:${port}`
      const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
      const route = (pathname: string) => {
        const url = new URL(pathname, base)
        url.searchParams.set("directory", workspace)
        return url
      }
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        // Requests select the isolated workspace explicitly; keep the server cwd outside removable fixture data.
        cwd: os.tmpdir(),
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const deadline = Date.now() + 60000
      while (true) {
        if (child.exitCode !== null) throw new Error(`Candidate exited before readiness: ${child.exitCode}`)
        if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok) break
        if (Date.now() >= deadline) throw new Error("Recovery candidate server did not become ready")
        await Bun.sleep(100)
      }
      const create = async () => {
        const response = await fetch(route("/session"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Synthetic recovery",
            agent: "build",
            model: { providerID: "smoke", id: "smoke" },
          }),
          signal: AbortSignal.timeout(10000),
        })
        expect(response.status).toBe(200)
        return ((await response.json()) as { id: string }).id
      }
      const sessionID = await create()
      const goalFile = path.join(data, "opencode", "storage", "goal", sessionID + ".json")
      const command = (arguments_: string) =>
        fetch(route(`/session/${sessionID}/command`), {
          method: "POST",
          headers,
          body: JSON.stringify({ agent: "build", model: "smoke/smoke", command: "goal", arguments: arguments_ }),
          signal: AbortSignal.timeout(10000),
        })
      const missing = await command("status")
      expect(missing.status).toBe(200)
      expect(await missing.text()).toContain("No active goal")
      expect(await stat(goalFile).catch(() => undefined)).toBeUndefined()
      const saved = {
        id: "goal-candidate-fixture",
        sessionID,
        objective: "SYNTHETIC_PRESERVED_OBJECTIVE",
        status: "paused",
        iteration: 1,
        maxIterations: 50,
        startedAt: 1,
        updatedAt: 2,
        completionCriteria: [],
        plan: [],
        observations: [],
        failures: [],
        recentHashes: [],
        replanned: false,
        extension: { retained: true },
      }
      await mkdir(path.dirname(goalFile), { recursive: true })
      const valid = JSON.stringify(saved)
      await writeFile(goalFile, valid)
      expect((await command("status")).status).toBe(200)
      expect(await readFile(goalFile, "utf8")).toBe(valid)
      for (const content of [
        "{ invalid json",
        JSON.stringify({ ...saved, plan: null }),
        "null",
        JSON.stringify({ ...saved, sessionID: "ses_different_goal_candidate" }),
      ]) {
        await writeFile(goalFile, content)
        for (const action of ["status", "resume", "pause", "cancel", "new replacement objective"]) {
          const response = await command(action)
          expect(response.ok).toBe(false)
          await response.arrayBuffer()
          expect(await readFile(goalFile, "utf8")).toBe(content)
          expect(requests).toBe(0)
        }
      }
      await writeFile(goalFile, valid)
      expect((await command("status")).status).toBe(200)
      expect(await readFile(goalFile, "utf8")).toBe(valid)

      const summaryID = await create()
      const seeded = await fetch(route(`/session/${summaryID}/message`), {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "smoke", modelID: "smoke" },
          noReply: true,
          parts: [
            {
              type: "text",
              text: "RECOVERY_SUMMARY_SOURCE: preserve this synthetic context. " + "history ".repeat(400),
            },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      })
      expect(seeded.status).toBe(200)
      await seeded.arrayBuffer()
      expect(requests).toBe(0)
      const snapshotRoot = path.join(data, "opencode", "snapshot")
      expect(await stat(snapshotRoot).catch(() => undefined)).toBeUndefined()
      const compacted = await fetch(route(`/session/${summaryID}/summarize`), {
        method: "POST",
        headers,
        body: JSON.stringify({ providerID: "smoke", modelID: "smoke", auto: false }),
        signal: AbortSignal.timeout(30000),
      })
      expect(compacted.status).toBe(200)
      expect(await compacted.json()).toBe(true)
      if (failure !== undefined) throw failure
      expect(requests).toBe(1)
      expect(await stat(snapshotRoot).catch(() => undefined)).toBeUndefined()
      const messagesResponse = await fetch(route(`/session/${summaryID}/message`), { headers })
      expect(messagesResponse.status).toBe(200)
      const summary = ((await messagesResponse.json()) as Message[]).find(
        (message) => message.info.role === "assistant" && message.info.summary === true,
      )
      expect(summary).toBeDefined()
      expect(summary?.info.error).toBeUndefined()
      expect(summary?.parts.some((part) => part.type === "text" && part.text === "RECOVERY_CHECKPOINT_OK")).toBe(true)
      expect(summary?.parts.some((part) => part.type === "patch")).toBe(false)
      for (const part of summary?.parts ?? [])
        if (part.type === "step-start" || part.type === "step-finish") expect(part.snapshot).toBeUndefined()
      const gitEvents = (await readFile(trace, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      const snapshotCommands = gitEvents.filter(
        (event) => event.event === "start" && event.argv?.some((argument) => /[\\/]snapshot[\\/]/.test(argument)),
      )
      expect(snapshotCommands).toEqual([])
      console.info(
        "compiled V1 recovery",
        JSON.stringify({
          invalidGoalCommands: 20,
          savedBytesPreserved: true,
          summaryProviderCalls: requests,
          snapshotGitCommands: snapshotCommands.length,
        }),
      )
    } catch (error) {
      testFailure = error
      throw error
    } finally {
      let teardownFailure: unknown
      if (child && child.exitCode === null && base) {
        try {
          const response = await fetch(base + "/global/dispose", {
            method: "POST",
            headers: { "x-opencode-directory": workspace },
            signal: AbortSignal.timeout(5000),
          })
          console.info("recovery fixture disposal", JSON.stringify({ status: response.status }))
          await response.arrayBuffer()
          if (!response.ok) teardownFailure = new Error(`Recovery fixture disposal failed: ${response.status}`)
        } catch (error) {
          teardownFailure = error
        }
      }
      provider?.stop(true)
      let childExited = false
      if (child) {
        if (child.exitCode === null) child.kill()
        await child.exited
        childExited = true
      }
      const root = path.resolve(temporary)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : temp + path.sep
      if (!root.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        console.info("recovery fixture cleanup", JSON.stringify({ completed: true, childExited, gitCwd: "external" }))
      } catch (error) {
        if (testFailure === undefined) throw error
        console.error("Recovery fixture cleanup also failed", { root, code: (error as NodeJS.ErrnoException).code })
      }
      if (teardownFailure !== undefined) {
        if (testFailure === undefined) throw teardownFailure
        console.error("Recovery fixture disposal also failed", teardownFailure)
      }
    }
  },
  120000,
)

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve recovery fixture port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
