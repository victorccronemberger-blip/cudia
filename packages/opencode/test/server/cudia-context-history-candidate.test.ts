import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const skillMarker = "COMPILED_SKILL_BODY_PRIVATE_MARKER_91A7"
const imageBytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

type CapturedRequest = {
  readonly messages: readonly Record<string, unknown>[]
  readonly tools?: readonly { readonly function: { readonly name: string } }[]
}

test.skipIf(candidate === undefined)(
  "compiled V1 persists skill history metadata and sends native image content",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")

    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-context-history-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    const data = path.join(temporary, "data")
    const cache = path.join(temporary, "cache")
    const state = path.join(temporary, "state")
    const auditFile = path.join(state, "opencode", "cudia-context-latest.json")
    const historyFile = path.join(state, "opencode", "cudia-context-history.sqlite")
    const imageFile = path.join(workspace, "pixel.png")
    let provider: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let failure: unknown
    let turn = 0
    let auditOff = false
    let base = ""
    let sessionID = ""
    const captured: CapturedRequest[] = []

    try {
      await Promise.all(
        [workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })),
      )
      await mkdir(path.join(workspace, ".opencode", "skill", "fixture-skill"), { recursive: true })
      await Promise.all([
        writeFile(
          path.join(workspace, ".opencode", "skill", "fixture-skill", "SKILL.md"),
          `---\nname: fixture-skill\ndescription: local compiled fixture\n---\n\n${skillMarker}\n`,
          "utf8",
        ),
        writeFile(imageFile, Buffer.from(imageBytes, "base64")),
      ])

      const environment: Record<string, string> = {
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
        XDG_CACHE_HOME: cache,
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
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true",
        CUDIA_CONTEXT_MODE: "lean",
        CUDIA_CONTEXT_AUDIT: "summary",
        CUDIA_CONTEXT_AUDIT_HISTORY: "1",
      }

      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as CapturedRequest
            captured.push(input)
            if (auditOff) {
              expect(input.messages.some((message) => message.role === "user")).toBe(true)
              return completion("CONTEXT_AUDIT_OFF_OK")
            }
            if (turn === 0) {
              expect(input.tools?.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["skill", "read"]))
              turn++
              return toolCall("skill", { name: "fixture-skill" }, "skill-load")
            }
            if (turn === 1) {
              expect(JSON.stringify(input.messages)).toContain(skillMarker)
              turn++
              return toolCall("read", { filePath: "pixel.png" }, "image-read")
            }
            if (turn === 2) {
              const serialized = JSON.stringify(input.messages)
              expect(serialized).toContain(skillMarker)
              const hasNativeImage = input.messages.some(
                (message) =>
                  Array.isArray(message.content) &&
                  message.content.some(
                    (part) =>
                      typeof part === "object" &&
                      part !== null &&
                      "type" in part &&
                      part.type === "image_url" &&
                      "image_url" in part &&
                      typeof part.image_url === "object" &&
                      part.image_url !== null &&
                      "url" in part.image_url &&
                      part.image_url.url === `data:image/png;base64,${imageBytes}`,
                  ),
              )
              if (!hasNativeImage)
                throw new Error(`Native image was not present in request: ${serialized.slice(-5000)}`)
              turn++
              return completion("CONTEXT_HISTORY_NATIVE_IMAGE_OK")
            }
            throw new Error(`Unexpected provider turn ${turn}`)
          } catch (error) {
            failure = error
            return completion("CONTEXT_HISTORY_FIXTURE_ASSERTION_FAILED")
          }
        },
      })

      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          formatter: false,
          lsp: false,
          skills: { paths: [path.join(workspace, ".opencode", "skill")] },
          model: "openai/smoke",
          provider: {
            openai: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: {
                smoke: {
                  name: "Context history native image fixture",
                  limit: { context: 200000, output: 4096 },
                  modalities: { input: ["text", "image"], output: ["text"] },
                },
              },
            },
          },
        }),
        "utf8",
      )
      const port = await availablePort()
      base = `http://127.0.0.1:${port}`
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: os.tmpdir(),
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      await poll(
        async () =>
          (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok ??
          false,
        child,
        "candidate server",
      )

      const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
      const route = (pathname: string) => {
        const url = new URL(pathname, base)
        url.searchParams.set("directory", workspace)
        return url
      }
      const created = await fetch(route("/session"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Compiled context history",
          agent: "build",
          model: { providerID: "openai", id: "smoke" },
        }),
      })
      expect(created.status).toBe(200)
      sessionID = ((await created.json()) as { id: string }).id
      const response = await fetch(route(`/session/${sessionID}/message`), {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "openai", modelID: "smoke" },
          parts: [{ type: "text", text: "Load fixture-skill, then read pixel.png and finish." }],
        }),
        signal: AbortSignal.timeout(60000),
      })
      expect(response.status).toBe(200)
      if (failure !== undefined) throw failure
      const message = await response.text()
      if (turn !== 3) throw new Error(`Expected three provider turns, received ${turn}: ${message.slice(0, 4000)}`)
      expect(message).toContain("CONTEXT_HISTORY_NATIVE_IMAGE_OK")

      const reportText = await readFile(auditFile, "utf8")
      const report = JSON.parse(reportText) as {
        runtime: string
        sessionID: string
        historySnapshot?: {
          stage: string
          sources: readonly {
            messageID: string
            partID: string
            text?: string
            tool?: { name: string; observation: { state: string; origin?: string } }
            prepared?: { state: string }
          }[]
        }
      }
      expect(report.runtime).toBe("v1-native")
      expect(report.sessionID).toBe(sessionID)
      expect(report.historySnapshot?.stage).toBe("pre-model-conversion")
      const loaded = report.historySnapshot?.sources.find((source) => source.tool?.name === "skill")
      expect(loaded).toMatchObject({
        tool: {
          name: "skill",
          observation: {
            state: "matched",
            origin: path.join(workspace, ".opencode", "skill", "fixture-skill", "SKILL.md"),
          },
        },
        prepared: { state: "mapped" },
      })
      expect(loaded?.messageID).toBeString()
      expect(loaded?.partID).toBeString()
      expect(reportText).not.toContain(skillMarker)

      child.kill()
      await child.exited
      child = undefined
      const history = Bun.spawn({
        cmd: [candidate, "debug", "context", "--history", "--session-id", sessionID],
        cwd: os.tmpdir(),
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const watchdog = setTimeout(() => history.kill(), 15000)
      let historyJSON = ""
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(history.stdout).text(),
          new Response(history.stderr).text(),
          history.exited,
        ])
        if (code !== 0) throw new Error(`Persisted history read failed (${code}): ${stderr}`)
        historyJSON = stdout
      } finally {
        clearTimeout(watchdog)
        if (history.exitCode === null) {
          history.kill()
          await history.exited
        }
      }
      const persisted = JSON.parse(historyJSON) as { entries?: readonly { capture?: typeof report }[] }
      expect(historyJSON).not.toContain(skillMarker)
      expect((await readFile(historyFile)).toString("utf8")).not.toContain(skillMarker)
      expect(historyJSON).toContain(sessionID)
      expect(historyJSON).toContain("loaded-tool-result")
      expect(await stat(historyFile)).toBeDefined()
      expect(persisted.entries?.length ?? 0).toBeGreaterThan(0)
      const persistedCapture = persisted.entries?.find((entry) => entry.capture?.sessionID === sessionID)?.capture
      expect(persistedCapture?.historySnapshot?.sources).toContainEqual(
        expect.objectContaining({
          source: "loaded-tool-result",
          tool: expect.objectContaining({ name: "skill", observation: expect.objectContaining({ state: "matched" }) }),
          prepared: expect.objectContaining({ state: "mapped" }),
        }),
      )

      const offRoot = path.join(temporary, "audit-off")
      const offConfig = path.join(offRoot, "config")
      const offData = path.join(offRoot, "data")
      const offCache = path.join(offRoot, "cache")
      const offState = path.join(offRoot, "state")
      await Promise.all(
        [offConfig, offData, offCache, offState].map((directory) => mkdir(directory, { recursive: true })),
      )
      const offEnvironment = {
        ...Object.fromEntries(
          Object.entries(environment).filter(
            ([key]) => key !== "CUDIA_CONTEXT_AUDIT" && key !== "CUDIA_CONTEXT_AUDIT_HISTORY",
          ),
        ),
        APPDATA: offConfig,
        LOCALAPPDATA: offData,
        XDG_CONFIG_HOME: offConfig,
        XDG_DATA_HOME: offData,
        XDG_CACHE_HOME: offCache,
        XDG_STATE_HOME: offState,
        OPENCODE_CONFIG_DIR: offConfig,
        OPENCODE_DB: path.join(offData, "candidate.sqlite"),
      }
      await writeFile(
        path.join(offConfig, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          formatter: false,
          lsp: false,
          model: "openai/smoke",
          provider: {
            openai: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "Audit-off fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )
      const offPort = await availablePort()
      const offBase = `http://127.0.0.1:${offPort}`
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(offPort)],
        cwd: os.tmpdir(),
        env: offEnvironment,
        stdout: "ignore",
        stderr: "pipe",
        windowsHide: true,
      })
      try {
        await poll(
          async () =>
            (await fetch(`${offBase}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok ??
            false,
          child,
          "audit-off candidate server",
        )
      } catch (error) {
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
        const details = child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : ""
        throw new Error(`${String(error)}: ${details}`)
      }
      auditOff = true
      const offHeaders = { "content-type": "application/json", "x-opencode-directory": workspace }
      const offURL = new URL("/session", offBase)
      offURL.searchParams.set("directory", workspace)
      const offCreated = await fetch(offURL, {
        method: "POST",
        headers: offHeaders,
        body: JSON.stringify({ title: "Audit disabled", agent: "build", model: { providerID: "openai", id: "smoke" } }),
      })
      expect(offCreated.status).toBe(200)
      const offSession = ((await offCreated.json()) as { id: string }).id
      const offMessage = new URL(`/session/${offSession}/message`, offBase)
      offMessage.searchParams.set("directory", workspace)
      const offResponse = await fetch(offMessage, {
        method: "POST",
        headers: offHeaders,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "openai", modelID: "smoke" },
          parts: [{ type: "text", text: "Reply for the audit-off fixture." }],
        }),
        signal: AbortSignal.timeout(30000),
      })
      expect(offResponse.status).toBe(200)
      expect(await offResponse.text()).toContain("CONTEXT_AUDIT_OFF_OK")
      expect(captured).toHaveLength(4)
      expect(
        await stat(path.join(offState, "opencode", "cudia-context-latest.json")).catch(() => undefined),
      ).toBeUndefined()
      expect(
        await stat(path.join(offState, "opencode", "cudia-context-history.sqlite")).catch(() => undefined),
      ).toBeUndefined()
      console.log(
        "compiled context history",
        JSON.stringify({
          nativeImage: true,
          preparedSkillMapped: true,
          historyAfterRestart: true,
          metadataBodyOmitted: true,
          auditOffStorageAbsent: true,
          providerTurns: captured.length,
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
        throw new Error("Refusing cleanup outside temporary directory")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return stream([
    { delta: { role: "assistant" } },
    {
      delta: {
        tool_calls: [
          { index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
    { delta: {}, finish_reason: "tool_calls" },
  ])
}

function completion(content: string) {
  return stream([{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }])
}

function stream(chunks: ReadonlyArray<Record<string, unknown>>) {
  const values = chunks.map((chunk) => ({
    id: "chatcmpl-cudia-context-history-fixture",
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
