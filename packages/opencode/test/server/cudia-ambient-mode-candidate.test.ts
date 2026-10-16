import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const GLOBAL = "AMBIENT_GLOBAL_MARKER_39A1"
const PROJECT = "AMBIENT_PROJECT_MARKER_24D8"
const NESTED = "AMBIENT_NESTED_MARKER_88CE"
const CONFIGURED = "AMBIENT_CONFIGURED_FILE_MARKER_71B3"
const REMOTE = "AMBIENT_CONFIGURED_URL_MARKER_6A20"
const DIRECT_SYSTEM = "DIRECT_USER_SYSTEM_MARKER_5C19"
const DIRECT_TEXT = "DIRECT_USER_TEXT_MARKER_A2E7"

type Message = { readonly role?: string; readonly content?: unknown }
type CapturedRequest = { readonly messages?: readonly Message[] }

test.skipIf(candidate === undefined)(
  "compiled candidate sends ambient instructions only after explicit CLI opt-in in V1 and V2",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")

    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-ambient-mode-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const nested = path.join(workspace, "nested")
    const configuredFile = path.join(temporary, "configured.rules")
    const captured: CapturedRequest[] = []
    let provider: ReturnType<typeof Bun.serve> | undefined
    let remote: ReturnType<typeof Bun.serve> | undefined
    const children: ReturnType<typeof Bun.spawn>[] = []
    let remoteHits = 0

    try {
      await mkdir(nested, { recursive: true })
      await Promise.all([
        writeFile(path.join(workspace, "AGENTS.md"), PROJECT, "utf8"),
        writeFile(path.join(nested, "AGENTS.md"), NESTED, "utf8"),
        writeFile(configuredFile, CONFIGURED, "utf8"),
        // This project environment variable is intentionally not a CLI opt-in.
        writeFile(path.join(workspace, ".env"), "CUDIA_LOAD_INSTRUCTIONS=1\n", "utf8"),
      ])

      remote = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname !== "/instructions") return new Response(null, { status: 404 })
          remoteHits++
          return new Response(REMOTE)
        },
      })
      const remoteURL = `http://127.0.0.1:${remote.port}/instructions`

      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          captured.push((await request.json()) as CapturedRequest)
          return completion("AMBIENT_MODE_FIXTURE_OK")
        },
      })

      const headers = { "content-type": "application/json", "x-opencode-directory": nested }
      const environment = (config: string, database: string) => ({
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: temporary,
        TMP: temporary,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: path.join(temporary, "data"),
        XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_STATE_HOME: path.join(temporary, "state"),
        APPDATA: config,
        LOCALAPPDATA: path.join(temporary, "data"),
        OPENCODE_TEST_HOME: temporary,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: database,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
        CUDIA_LOAD_INSTRUCTIONS: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(temporary, "no-global-git-config"),
      })

      const runMode = async (automatic: boolean) => {
        const suffix = automatic ? "opt-in" : "default"
        const config = path.join(temporary, `config-${suffix}`)
        await mkdir(config, { recursive: true })
        const env = environment(config, path.join(temporary, `data-${suffix}`, "candidate.sqlite"))
        await mkdir(path.join(temporary, `data-${suffix}`), { recursive: true })
        await writeFile(path.join(config, "AGENTS.md"), GLOBAL, "utf8")
        await writeFile(
          path.join(config, "opencode.json"),
          JSON.stringify({
            snapshot: false,
            model: "smoke/smoke",
            instructions: [configuredFile, remoteURL],
            provider: {
              smoke: {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: `http://127.0.0.1:${provider!.port}/v1`, apiKey: "fixture-only" },
                models: { smoke: { name: "Ambient mode fixture", limit: { context: 200000, output: 4096 } } },
              },
            },
          }),
          "utf8",
        )
        const git = Bun.spawn({
          cmd: ["git", "init", "--quiet"],
          cwd: workspace,
          env,
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        expect(await git.exited).toBe(0)
        const statusProcess = Bun.spawn({
          cmd: [candidate!, ...(automatic ? ["--load-instructions"] : []), "debug", "context", "--status"],
          cwd: workspace,
          env,
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        children.push(statusProcess)
        const [statusText, statusError, statusCode] = await Promise.all([
          new Response(statusProcess.stdout).text(),
          new Response(statusProcess.stderr).text(),
          statusProcess.exited,
        ])
        expect(statusCode, statusError).toBe(0)
        expect(JSON.parse(statusText)).toMatchObject({
          ambientInstructions: { automatic, source: automatic ? "cli" : "default" },
          scope: "current process",
        })
        const port = await availablePort()
        const child = Bun.spawn({
          cmd: [
            candidate!,
            ...(automatic ? ["--load-instructions"] : []),
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(port),
          ],
          cwd: workspace,
          env: env,
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        children.push(child)
        const base = `http://127.0.0.1:${port}`
        await poll(
          async () =>
            (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))
              ?.status === 200,
          child,
          `candidate server did not start (${suffix})`,
        )

        const before = captured.length
        const legacy = await fetch(`${base}/session?directory=${encodeURIComponent(nested)}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: `Ambient legacy ${suffix}`,
            agent: "build",
            model: { providerID: "smoke", id: "smoke" },
          }),
        })
        expect(legacy.status).toBe(200)
        const legacyID = ((await legacy.json()) as { id: string }).id
        const legacyPrompt = await fetch(
          `${base}/session/${legacyID}/message?directory=${encodeURIComponent(nested)}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "smoke", modelID: "smoke" },
              system: DIRECT_SYSTEM,
              parts: [{ type: "text", text: `${DIRECT_TEXT} Please answer normally.` }],
            }),
            signal: AbortSignal.timeout(30_000),
          },
        )
        expect(legacyPrompt.status).toBe(200)
        await poll(() => Promise.resolve(captured.length >= before + 1), child, `V1 request not captured (${suffix})`)
        assertRequest(captured[before]!, automatic, "v1")

        const modern = await fetch(`${base}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: "smoke", id: "smoke" },
            location: { directory: nested },
          }),
        })
        expect(modern.status).toBe(200)
        const modernID = ((await modern.json()) as { data: { id: string } }).data.id
        const modernPrompt = await fetch(`${base}/api/session/${modernID}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: { text: `${DIRECT_SYSTEM} ${DIRECT_TEXT} Please answer normally.` },
          }),
          signal: AbortSignal.timeout(30_000),
        })
        expect(modernPrompt.status).toBe(200)
        await poll(() => Promise.resolve(captured.length >= before + 2), child, `V2 request not captured (${suffix})`)
        await waitForIdle(base, modernID, child)
        assertRequest(captured[before + 1]!, automatic, "v2")
        expect(captured).toHaveLength(before + 2)
        expect(remoteHits).toBe(automatic ? 1 : 0)
      }

      await runMode(false)
      expect(remoteHits).toBe(0)
      children.at(-1)!.kill()
      await children.at(-1)!.exited
      await runMode(true)
      expect(remoteHits).toBe(1)
      console.info("compiled ambient mode wire fixture", JSON.stringify({ requests: captured.length, remoteHits }))
    } finally {
      provider?.stop(true)
      remote?.stop(true)
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
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

function assertRequest(request: CapturedRequest, automatic: boolean, runtime: "v1" | "v2") {
  const messages = request.messages ?? []
  const serialized = JSON.stringify(messages)
  const system = JSON.stringify(messages.filter((message) => message.role === "system"))
  const user = JSON.stringify(messages.filter((message) => message.role === "user"))
  if (runtime === "v1") {
    expect(system).toContain(DIRECT_SYSTEM)
    expect(user).toContain(DIRECT_TEXT)
  } else {
    expect(user).toContain(DIRECT_SYSTEM)
    expect(user).toContain(DIRECT_TEXT)
  }
  const ambient = [GLOBAL, PROJECT, NESTED]
  if (runtime === "v1") ambient.push(CONFIGURED, REMOTE)
  for (const marker of ambient) {
    if (automatic) expect(serialized).toContain(marker)
    else expect(serialized).not.toContain(marker)
  }
}

function completion(content: string) {
  const chunks = [{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }].map((chunk) => ({
    id: "chatcmpl-cudia-ambient-mode",
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
  if (!address || typeof address === "string") throw new Error("Could not reserve a candidate server port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function poll(check: () => Promise<boolean>, child: ReturnType<typeof Bun.spawn>, message: string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${message} (candidate exited with code ${child.exitCode})`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function waitForIdle(base: string, sessionID: string, child: ReturnType<typeof Bun.spawn>) {
  await poll(
    async () => {
      const response = await fetch(`${base}/api/session/active`).catch(() => undefined)
      if (!response?.ok) return false
      const active = (await response.json()) as { data: Record<string, unknown> }
      return !Object.hasOwn(active.data, sessionID)
    },
    child,
    "V2 session did not become idle",
  )
}
