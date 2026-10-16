import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST

type CapturedRequest = {
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
  readonly tools?: unknown
}

test.skipIf(candidate === undefined)("compiled CUDIA candidate serves the V2 manual compaction flow", async () => {
  if (!candidate || !path.isAbsolute(candidate))
    throw new Error("CUDIA_CANDIDATE_TEST must be an absolute executable path")
  if (!(await Bun.file(candidate).exists())) throw new Error("CUDIA_CANDIDATE_TEST executable does not exist")

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-v2-candidate-"))
  const workspace = path.join(tempRoot, "workspace")
  const config = path.join(tempRoot, "config")
  const data = path.join(tempRoot, "data")
  const cache = path.join(tempRoot, "cache")
  const state = path.join(tempRoot, "state")
  const captured: CapturedRequest[] = []
  let fake: ReturnType<typeof Bun.serve> | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined

  try {
    await Promise.all([workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })))
    await writeFile(path.join(workspace, "workspace-smoke.txt"), "workspace fixture", "utf8")
    fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
        const input = (await request.json()) as { messages?: CapturedRequest["messages"]; tools?: unknown }
        captured.push({ messages: input.messages ?? [], tools: input.tools })
        const answer = captured.length === 2 ? "## Objective\n- MANUAL_CHECKPOINT_OK" : "NORMAL_REPLY_OK"
        const chunks = [
          {
            id: "chatcmpl-cudia-fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "smoke",
            choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
          },
          {
            id: "chatcmpl-cudia-fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "smoke",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
        return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      },
    })

    const configPath = path.join(config, "opencode.json")
    await writeFile(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        snapshot: false,
        compaction: { keep: { tokens: 256 }, buffer: 0 },
        model: "smoke/smoke",
        provider: {
          smoke: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "fixture-only" },
            models: { smoke: { name: "CUDIA local fixture", limit: { context: 40000, output: 4096 } } },
          },
        },
      }),
      "utf8",
    )

    const port = await availablePort()
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
    }
    child = Bun.spawn({
      cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: workspace,
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })

    const baseURL = `http://127.0.0.1:${port}`
    await poll(
      async () => {
        const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(
          () => undefined,
        )
        return response?.status === 200
      },
      child,
      "candidate server did not become healthy",
    )

    // Global metadata must not initialize a location, even when a stale directory header is present.
    const serverPaths = await fetch(`${baseURL}/api/location/paths`, {
      headers: { "x-opencode-directory": path.join(tempRoot, "does-not-exist") },
    })
    expect(serverPaths.status).toBe(200)
    expect(await serverPaths.json()).toEqual({ home: tempRoot, defaultDirectory: workspace })
    const coldProjects = await fetch(`${baseURL}/api/project`)
    expect(coldProjects.status).toBe(200)
    expect(await coldProjects.json()).toEqual([])

    // This must be the first location request: a warm catalog would hide a bootstrap race.
    const defaultQuery = new URLSearchParams({ "location[directory]": workspace })
    const configuredDefault = await fetch(`${baseURL}/api/model/default?${defaultQuery}`)
    expect(configuredDefault.status).toBe(200)
    expect(await configuredDefault.json()).toMatchObject({
      location: { directory: workspace },
      data: { providerID: "smoke", id: "smoke" },
    })
    expect(captured).toHaveLength(0)

    const missing = await fetch(`${baseURL}/api/session/ses_cudia_missing`)
    expect(missing.status).toBe(404)

    const created = await fetch(`${baseURL}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "smoke", id: "smoke" },
        location: { directory: workspace },
      }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id

    const persistedProjects = await fetch(`${baseURL}/api/project`)
    expect(persistedProjects.status).toBe(200)
    expect(await persistedProjects.json()).toContainEqual(
      expect.objectContaining({ id: "global", worktree: path.parse(workspace).root, sandboxes: [] }),
    )
    const directoryEntries = await fetch(`${baseURL}/api/fs/list?${defaultQuery}`)
    expect(directoryEntries.status).toBe(200)
    expect(await directoryEntries.json()).toMatchObject({
      location: { directory: workspace },
      data: expect.arrayContaining([{ path: "workspace-smoke.txt", type: "file" }]),
    })

    for (const route of ["/api/vcs", "/api/vcs/status", "/api/vcs/diff?mode=working"]) {
      const url = new URL(route, baseURL)
      url.searchParams.set("location[directory]", workspace)
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        location: { directory: workspace },
        data: route === "/api/vcs" ? {} : [],
      })
    }

    const find = new URL("/api/fs/find", baseURL)
    find.searchParams.set("location[directory]", workspace)
    find.searchParams.set("query", "workspace-fresh.txt")
    find.searchParams.set("type", "file")
    const beforeFile = await fetch(find)
    expect(beforeFile.status).toBe(200)
    expect(((await beforeFile.json()) as { data: { path: string; type: string }[] }).data).toEqual([])
    await writeFile(path.join(workspace, "workspace-fresh.txt"), "created after first search", "utf8")
    const afterFile = await fetch(find)
    expect(afterFile.status).toBe(200)
    expect(((await afterFile.json()) as { data: { path: string; type: string }[] }).data).toContainEqual({
      path: "workspace-fresh.txt",
      type: "file",
    })

    const firstPrompt = await fetch(`${baseURL}/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: {
          text: `Retain this earlier context for the manual checkpoint: ${"CUDIA_CHECKPOINT_DETAIL ".repeat(520)}`,
        },
      }),
    })
    expect(firstPrompt.status).toBe(200)
    await waitForIdle(baseURL, sessionID, 1, captured, child)
    expect(captured).toHaveLength(1)
    expect(JSON.stringify(captured[0]?.messages)).toContain("CUDIA_CHECKPOINT_DETAIL")

    const compacted = await fetch(`${baseURL}/api/session/${sessionID}/compact`, { method: "POST" })
    expect(compacted.status).toBe(204)
    const messagesResponse = await fetch(`${baseURL}/api/session/${sessionID}/message?order=asc`)
    expect(messagesResponse.status).toBe(200)
    const messages = (
      (await messagesResponse.json()) as { data: { type: string; reason?: string; summary?: string; text?: string }[] }
    ).data
    const checkpoint = messages.find((message) => message.type === "compaction")
    expect(checkpoint?.reason).toBe("manual")
    expect(checkpoint?.summary).toContain("MANUAL_CHECKPOINT_OK")
    expect(
      messages.some((message) => message.type === "user" && message.text?.includes("CUDIA_CHECKPOINT_DETAIL")),
    ).toBe(true)
    expect(captured).toHaveLength(2)
    expect(captured[1]?.tools ?? []).toEqual([])
    expect(JSON.stringify(captured[1]?.messages)).toContain("## Objective")

    const nextPrompt = await fetch(`${baseURL}/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: { text: "Continue after the checkpoint and finish normally." } }),
    })
    expect(nextPrompt.status).toBe(200)
    await waitForIdle(baseURL, sessionID, 3, captured, child)
    expect(captured).toHaveLength(3)
    expect(JSON.stringify(captured[2]?.messages)).toContain("MANUAL_CHECKPOINT_OK")
  } finally {
    fake?.stop(true)
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
})

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

async function poll(
  check: () => Promise<boolean>,
  child: ReturnType<typeof Bun.spawn>,
  message: string,
  timeout = 20_000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${message} (candidate exited with code ${child.exitCode})`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function waitForIdle(
  baseURL: string,
  sessionID: string,
  expectedRequests: number,
  captured: readonly CapturedRequest[],
  child: ReturnType<typeof Bun.spawn>,
) {
  await poll(
    async () => {
      if (captured.length < expectedRequests) return false
      const response = await fetch(`${baseURL}/api/session/active`).catch(() => undefined)
      if (!response?.ok) return false
      const active = (await response.json()) as { data: Record<string, unknown> }
      return !Object.hasOwn(active.data, sessionID)
    },
    child,
    "session did not become idle after the local model response",
  )
}
