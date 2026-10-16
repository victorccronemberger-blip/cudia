import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const ROOT = "ROOT_AMBIENT_INSTRUCTION_CANDIDATE_61CA"
const LOCAL_REJECTED = "LOCAL_REJECTED_BODY_MUST_NOT_REACH_PROVIDER_7B91"
const LOCAL_REPAIRED = "LOCAL_REPAIRED_INSTRUCTION_CANDIDATE_42AD"
const REMOTE_INITIAL = "REMOTE_INITIAL_INSTRUCTION_CANDIDATE_71FE"
const REMOTE_REJECTED = "REMOTE_REJECTED_BODY_MUST_NOT_REACH_PROVIDER_92EB"
const REMOTE_REPAIRED = "REMOTE_REPAIRED_INSTRUCTION_CANDIDATE_38DC"
const QUERY_SECRET = "REMOTE_QUERY_SECRET_CANDIDATE_63BD"

type CapturedRequest = { readonly messages: readonly { readonly role?: string; readonly content?: unknown }[] }
type Message = {
  readonly info: {
    readonly id: string
    readonly role: string
    readonly error?: unknown
    readonly time: { readonly created: number; readonly completed?: number }
  }
  readonly parts: readonly { readonly type: string; readonly text?: string }[]
}

test.skipIf(candidate === undefined)(
  "compiled legacy instruction failures persist before provider calls and recover in the same session",
  async () => {
    if (!candidate || !path.isAbsolute(candidate))
      throw new Error("CUDIA_CANDIDATE_TEST must be an absolute executable path")
    if (!(await Bun.file(candidate).exists())) throw new Error("CUDIA_CANDIDATE_TEST executable does not exist")

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-instruction-candidate-"))
    const workspace = path.join(tempRoot, "workspace")
    const config = path.join(tempRoot, "config")
    const data = path.join(tempRoot, "data")
    const cache = path.join(tempRoot, "cache")
    const state = path.join(tempRoot, "state")
    const captured: CapturedRequest[] = []
    let provider: ReturnType<typeof Bun.serve> | undefined
    let remote: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let remoteState: "initial" | "rejected" | "repaired" = "initial"
    let stage: "rejected" | "local" | "remote" | "native" = "rejected"
    let remoteHits = 0
    let failure: unknown

    try {
      await Promise.all([workspace, config, data, cache, state].map((item) => mkdir(item, { recursive: true })))
      await Promise.all([
        writeFile(path.join(workspace, "AGENTS.md"), ROOT, "utf8"),
        writeFile(path.join(workspace, "extra.rules"), LOCAL_REJECTED.padEnd(513, "x"), "utf8"),
      ])
      const environment = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: tempRoot,
        TMP: tempRoot,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        XDG_STATE_HOME: state,
        APPDATA: config,
        LOCALAPPDATA: data,
        OPENCODE_TEST_HOME: tempRoot,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
        CUDIA_INSTRUCTION_MAX_SOURCE_BYTES: "512",
        CUDIA_INSTRUCTION_MAX_TOTAL_BYTES: "2048",
        CUDIA_INSTRUCTION_MAX_SOURCES: "8",
        CUDIA_INSTRUCTION_TIMEOUT_MS: "1000",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(tempRoot, "no-global-git-config"),
      }
      // Pin instruction discovery to this fixture, including on machines with ancestor AGENTS files.
      const git = Bun.spawn({
        cmd: ["git", "init", "--quiet"],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      expect(await git.exited).toBe(0)

      remote = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname !== "/instructions") return new Response(null, { status: 404 })
          remoteHits++
          if (remoteState === "rejected") return new Response(REMOTE_REJECTED, { status: 404 })
          return new Response(remoteState === "initial" ? REMOTE_INITIAL : REMOTE_REPAIRED)
        },
      })
      const remoteURL = `http://127.0.0.1:${remote.port}/instructions?token=${QUERY_SECRET}#private-fragment`

      // The fake provider checks the compiled server's actual wire messages; this does not test model intelligence.
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as CapturedRequest
            captured.push(input)
            const wire = JSON.stringify(input.messages)
            const system = JSON.stringify(input.messages.filter((message) => message.role === "system"))
            expect(system).toContain(ROOT)
            expect(wire).not.toContain(LOCAL_REJECTED)
            expect(wire).not.toContain(REMOTE_REJECTED)
            if (stage === "rejected") throw new Error("Provider was called before instruction acquisition succeeded")
            if (stage !== "native") {
              expect(system).toContain(LOCAL_REPAIRED)
              expect(system).toContain(stage === "local" ? REMOTE_INITIAL : REMOTE_REPAIRED)
            }
            return completion(`LEGACY_INSTRUCTION_${stage.toUpperCase()}_OK`)
          } catch (error) {
            failure = error
            return completion("INSTRUCTION_FIXTURE_ASSERTION_FAILED")
          }
        },
      })
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          snapshot: false,
          model: "smoke/smoke",
          instructions: ["extra.rules", remoteURL],
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "CUDIA instruction fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )
      const port = await availablePort()
      child = Bun.spawn({
        cmd: [candidate, "--load-instructions", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const baseURL = `http://127.0.0.1:${port}`
      await poll(
        async () =>
          (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))
            ?.status === 200,
        child,
        "candidate server did not become healthy",
      )
      const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
      const route = (pathname: string) => {
        const url = new URL(pathname, baseURL)
        url.searchParams.set("directory", workspace)
        return url
      }
      const created = await fetch(route("/session"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Pinned legacy instruction fixture",
          agent: "build",
          model: { providerID: "smoke", id: "smoke" },
        }),
      })
      expect(created.status).toBe(200)
      const sessionID = ((await created.json()) as { id: string }).id
      expect(sessionID).toBeString()
      for (const input of [
        { session: "ses_missing_identity_candidate", agent: "build", missingSession: true },
        { session: sessionID, agent: "missing-agent-identity", missingSession: false },
      ]) {
        const invalid = await fetch(route(`/session/${input.session}/message`), {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: input.agent,
            model: { providerID: "smoke", modelID: "smoke" },
            parts: [{ type: "text", text: "Invalid identity fixture; no model execution expected." }],
          }),
          signal: AbortSignal.timeout(5000),
        })
        expect(invalid.ok).toBe(false)
        if (input.missingSession) expect(invalid.status).toBe(404)
        expect(captured).toHaveLength(0)
        expect(remoteHits).toBe(0)
      }
      const prompt = async (text: string) => {
        const response = await fetch(route(`/session/${sessionID}/message`), {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "smoke", modelID: "smoke" },
            parts: [{ type: "text", text }],
          }),
          signal: AbortSignal.timeout(30_000),
        })
        expect(response.status).toBe(200)
        if (failure !== undefined) throw failure
        return (await response.json()) as Message
      }
      const persistedFailure = async (message: Message) => {
        expect(message.info.role).toBe("assistant")
        expect(message.info.error).toBeDefined()
        expect(message.info.time.completed).toBeGreaterThanOrEqual(message.info.time.created)
        const response = await fetch(route(`/session/${sessionID}/message`), { headers })
        expect(response.status).toBe(200)
        const messages = (await response.json()) as Message[]
        const stored = messages.find((item) => item.info.id === message.info.id)
        expect(stored?.info.error).toEqual(message.info.error)
        expect(stored?.info.time.completed).toBe(message.info.time.completed)
        await poll(
          async () => {
            const response = await fetch(route("/session/status"), { headers })
            expect(response.status).toBe(200)
            const statuses = (await response.json()) as Record<string, { type: string }>
            return statuses[sessionID] === undefined || statuses[sessionID]?.type === "idle"
          },
          child!,
          "failed legacy session did not become idle",
        )
      }

      const oversized = await prompt("Answer the local fixture prompt.")
      await persistedFailure(oversized)
      expect(JSON.stringify(oversized.info.error)).toContain("extra.rules")
      expect(JSON.stringify(oversized.info.error)).toContain("512-byte")
      expect(JSON.stringify(oversized)).not.toContain(LOCAL_REJECTED)
      expect(captured).toHaveLength(0)
      expect(remoteHits).toBe(0)

      await writeFile(path.join(workspace, "extra.rules"), LOCAL_REPAIRED, "utf8")
      stage = "local"
      assertNormal(await prompt("Answer again after the local source was repaired."), "LEGACY_INSTRUCTION_LOCAL_OK")
      expect(captured).toHaveLength(1)
      expect(remoteHits).toBe(1)

      remoteState = "rejected"
      stage = "rejected"
      const unavailable = await prompt("Answer again with the currently configured sources.")
      await persistedFailure(unavailable)
      const error = JSON.stringify(unavailable.info.error)
      expect(error).toContain("HTTP 404")
      expect(error).toContain("/instructions")
      expect(error).not.toContain(QUERY_SECRET)
      expect(error).not.toContain("private-fragment")
      expect(JSON.stringify(unavailable)).not.toContain(REMOTE_REJECTED)
      expect(captured).toHaveLength(1)
      expect(remoteHits).toBe(2)

      remoteState = "repaired"
      stage = "remote"
      assertNormal(await prompt("Answer again after the remote source was repaired."), "LEGACY_INSTRUCTION_REMOTE_OK")
      expect(captured).toHaveLength(2)
      expect(remoteHits).toBe(3)

      // Native initialization shares the new source service; only its existing root-file behavior is asserted here.
      stage = "native"
      const native = await fetch(`${baseURL}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: workspace } }),
      })
      expect(native.status).toBe(200)
      const nativeID = ((await native.json()) as { data: { id: string } }).data.id
      const admitted = await fetch(`${baseURL}/api/session/${nativeID}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: { text: "Answer the native ambient instruction fixture prompt." } }),
      })
      expect(admitted.status).toBe(200)
      await poll(
        async () => {
          if (failure !== undefined) throw failure
          if (captured.length < 3) return false
          const response = await fetch(`${baseURL}/api/session/active`)
          if (!response.ok) return false
          const active = (await response.json()) as { data: Record<string, unknown> }
          return !Object.hasOwn(active.data, nativeID)
        },
        child,
        "native ambient instruction fixture did not become idle",
      )
      if (failure !== undefined) throw failure
      expect(captured).toHaveLength(3)
      expect(JSON.stringify(captured)).not.toContain(LOCAL_REJECTED)
      expect(JSON.stringify(captured)).not.toContain(REMOTE_REJECTED)
      console.info(
        "compiled instruction fixture",
        JSON.stringify({ legacyPrompts: 4, providerTurns: captured.length, remoteHits }),
      )
    } finally {
      provider?.stop(true)
      remote?.stop(true)
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(tempRoot)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
      if (!root.toLowerCase().startsWith(prefix.toLowerCase()))
        throw new Error("Refusing to remove a path outside the temporary directory")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)

function assertNormal(message: Message, text: string) {
  expect(message.info.role).toBe("assistant")
  expect(message.info.error).toBeUndefined()
  expect(message.info.time.completed).toBeGreaterThanOrEqual(message.info.time.created)
  expect(
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  ).toContain(text)
}

function completion(content: string) {
  const values = [{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }].map((chunk) => ({
    id: "chatcmpl-cudia-instruction-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke",
    choices: [{ index: 0, ...chunk }],
  }))
  return new Response(`${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`, {
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
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${message} (candidate exited with code ${child.exitCode})`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}
