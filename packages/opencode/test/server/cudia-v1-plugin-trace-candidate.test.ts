import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const SYSTEM_MARKER = "PLUGIN_SYSTEM_TRACE_SECRET_6F31"
const MESSAGE_MARKER = "PLUGIN_MESSAGE_TRACE_SECRET_91C2"
const PROMPT_MARKER = "USER_PROMPT_TRACE_SECRET_4A87"
const IGNORED_MARKER = "IGNORED_SYSTEM_WRAPPER_SECRET_F2B7"
const HEADER_SECRET = "HEADER_PRIVATE_SECRET_1D99"
const OPTION_SECRET = "OPTION_PRIVATE_SECRET_A581"
const ID_SECRET = "ORIGIN_PASSWORD_SECRET_7B16"
const QUERY_SECRET = "ORIGIN_QUERY_SECRET_4C12"

type CapturedRequest = {
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
}

type TraceRecord = {
  readonly ordinal: number
  readonly stage: string
  readonly projection: string
  readonly source: { readonly kind: string; readonly id: string; readonly ordinal: number; readonly entry?: string }
  readonly status: string
  readonly before: { readonly status: string; readonly sha256?: string }
  readonly after?: { readonly status: string; readonly sha256?: string }
  readonly change: string
}

test.skipIf(candidate === undefined)(
  "compiled V1 plugin trace observes hook changes and attributes duplicate plugin IDs",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")

    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-plugin-trace-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    const data = path.join(temporary, "data")
    const cache = path.join(temporary, "cache")
    const state = path.join(temporary, "state")
    const firstPlugin = path.join(temporary, "first-plugin.mjs")
    const secondPlugin = path.join(temporary, "second-plugin.mjs")
    const wrapperPlugin = path.join(temporary, "wrapper-plugin.mjs")
    const stderrFile = path.join(temporary, "candidate-stderr.log")
    const startedAt = Date.now()
    const mark = (stage: string) =>
      console.info("plugin-trace stage", JSON.stringify({ stage, elapsedMs: Date.now() - startedAt }))
    const captured: CapturedRequest[] = []
    let provider: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let testFailure: unknown

    try {
      mark("fixture-start")
      await Promise.all(
        [workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })),
      )
      await writeFile(
        firstPlugin,
        `export default {
  id: "duplicate",
  server: async () => ({
    "experimental.chat.system.transform": (_input, output) => { output.system[0] += ${JSON.stringify(SYSTEM_MARKER)} },
    "experimental.chat.messages.transform": (_input, output) => {
      const part = output.messages.flatMap((message) => message.parts).find((item) => item.type === "text")
      if (part) part.text += ${JSON.stringify(MESSAGE_MARKER)}
    },
    "chat.params": (_input, output) => { output.options.traceFixturePrivate = ${JSON.stringify(OPTION_SECRET)} },
    "chat.headers": (_input, output) => { output.headers["x-fixture-private"] = ${JSON.stringify(HEADER_SECRET)} },
  }),
}
`,
        "utf8",
      )
      await writeFile(
        secondPlugin,
        `export default {
  id: "duplicate",
  server: async () => ({
    "experimental.chat.system.transform": (_input, output) => { output.system[0] = output.system[0].replace(${JSON.stringify(SYSTEM_MARKER)}, "") },
  }),
}
`,
        "utf8",
      )
      await writeFile(
        wrapperPlugin,
        `export default { id: "https://fixture:${ID_SECRET}@plugins.example/wrapper?token=${QUERY_SECRET}#fragment", server: async () => ({
  "experimental.chat.system.transform": (_input, output) => { output.system = [${JSON.stringify(IGNORED_MARKER)}] },
}) }`,
        "utf8",
      )

      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          mark("provider-request")
          expect(request.headers.get("x-fixture-private")).toBe(HEADER_SECRET)
          captured.push((await request.json()) as CapturedRequest)
          return completion("V1_PLUGIN_TRACE_FIXTURE_OK")
        },
      })

      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          snapshot: false,
          model: "smoke/smoke",
          plugin: [
            pathToFileURL(firstPlugin).href,
            pathToFileURL(secondPlugin).href,
            pathToFileURL(wrapperPlugin).href,
          ],
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "V1 plugin trace fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )

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
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
        CUDIA_CONTEXT_MODE: "lean",
        CUDIA_CONTEXT_AUDIT: "summary",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(temporary, "no-global-git-config"),
      }
      // Bound ambient instruction discovery to this fixture's repository.
      const git = Bun.spawn({
        cmd: ["git", "init", "--quiet"],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      expect(await git.exited).toBe(0)
      const port = await availablePort()
      mark("server-spawn")
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: Bun.file(stderrFile),
        windowsHide: true,
      })
      const baseURL = `http://127.0.0.1:${port}`
      await poll(
        async () =>
          (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined))
            ?.status === 200,
        child,
        "candidate server did not become healthy",
      )
      mark("server-healthy")

      const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
      const route = (pathname: string) => {
        const url = new URL(pathname, baseURL)
        url.searchParams.set("directory", workspace)
        return url
      }
      mark("session-create-start")
      const created = await fetch(route("/session"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "V1 plugin trace fixture",
          agent: "build",
          model: { providerID: "smoke", id: "smoke" },
        }),
      })
      expect(created.status).toBe(200)
      const sessionID = ((await created.json()) as { id: string }).id
      mark("session-created")
      mark("message-submit-start")
      const response = await fetch(route(`/session/${sessionID}/message`), {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "smoke", modelID: "smoke" },
          parts: [{ type: "text", text: `Reply to this local fixture: ${PROMPT_MARKER}` }],
        }),
        signal: AbortSignal.timeout(30_000),
      })
      expect(response.status).toBe(200)
      mark("message-response")
      const result = (await response.json()) as {
        readonly info?: { readonly error?: unknown }
        readonly parts?: readonly { readonly type: string; readonly text?: string }[]
      }
      expect(result.info?.error).toBeUndefined()
      expect(
        result.parts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).toContain("V1_PLUGIN_TRACE_FIXTURE_OK")
      expect(captured).toHaveLength(1)

      const wire = JSON.stringify(captured[0]?.messages)
      expect(wire).toContain(PROMPT_MARKER)
      expect(wire).toContain(MESSAGE_MARKER)
      expect(wire).not.toContain(SYSTEM_MARKER)
      expect(wire).not.toContain(IGNORED_MARKER)

      const auditPath = path.join(state, "opencode", "cudia-context-latest.json")
      const serialized = await Bun.file(auditPath).text()
      const report = JSON.parse(serialized) as {
        version: number
        runtime: string
        trace?: { coverage: string; records: TraceRecord[] }
      }
      expect(report.version).toBe(2)
      expect(report.runtime).toBe("v1-ai-sdk")
      expect(report.trace?.records).toBeDefined()
      expect(serialized).not.toContain(SYSTEM_MARKER)
      expect(serialized).not.toContain(MESSAGE_MARKER)
      expect(serialized).not.toContain(PROMPT_MARKER)
      for (const secret of [IGNORED_MARKER, HEADER_SECRET, OPTION_SECRET, ID_SECRET, QUERY_SECRET]) {
        expect(serialized).not.toContain(secret)
      }
      expect(report.trace?.coverage).toBe(
        "observed prepared-request projections; not complete runtime or wire coverage",
      )

      const records = report.trace!.records
      const allSystems = records.filter((record) => record.stage === "experimental.chat.system.transform")
      expect(allSystems).toHaveLength(3)
      const systems = allSystems.filter((record) => record.source.id === "duplicate")
      expect(systems).toHaveLength(2)
      expect(systems.map((record) => record.projection)).toEqual(["consumed-system-array", "consumed-system-array"])
      expect(systems.map((record) => record.status)).toEqual(["success", "success"])
      expect(systems.map((record) => record.change)).toEqual(["changed", "changed"])
      expect(systems[0]?.before).toMatchObject({ status: "complete" })
      expect(systems[0]?.after).toMatchObject({ status: "complete" })
      expect(systems[1]?.before.sha256).toBe(systems[0]?.after?.sha256)
      expect(systems[1]?.after?.sha256).toBe(systems[0]?.before.sha256)

      const attributed = systems.map((record) => record.source)
      expect(attributed.map((source) => source.id)).toEqual(["duplicate", "duplicate"])
      expect(attributed.every((source) => source.kind === "file")).toBe(true)
      expect(new Set(attributed.map((source) => source.ordinal)).size).toBe(2)
      expect(attributed[0]?.entry).toContain("first-plugin.mjs")
      expect(attributed[1]?.entry).toContain("second-plugin.mjs")
      const ignored = allSystems.find((record) => record.source.id === "https://plugins.example/wrapper")
      expect(ignored?.change).toBe("unchanged")
      expect(ignored?.source.entry).toContain("wrapper-plugin.mjs")
      expect(ignored?.before).toEqual(ignored?.after)

      const messages = records.filter((record) => record.stage === "experimental.chat.messages.transform")
      expect(messages).toHaveLength(1)
      expect(messages.every((record) => record.projection === "consumed-session-messages")).toBe(true)
      expect(messages.every((record) => record.status === "success" && record.change === "changed")).toBe(true)
      expect(messages.map((record) => record.source.id)).toEqual(["duplicate"])
      expect(messages[0]?.source.entry).toContain("first-plugin.mjs")

      expect(records).toContainEqual(
        expect.objectContaining({
          stage: "ProviderTransform.message",
          projection: "normalized-model-messages",
          source: expect.objectContaining({ kind: "runtime", id: "provider-message-transform" }),
          status: "success",
        }),
      )
      console.info(
        "compiled V1 plugin trace fixture",
        JSON.stringify({ records: records.length, duplicatePluginHooks: systems.length + messages.length }),
      )
    } catch (error) {
      testFailure = error
      mark("test-failed")
      throw error
    } finally {
      mark("teardown-start")
      provider?.stop(true)
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      if (child) mark(`server-exited-${child.exitCode}`)
      const stderr = await readFile(stderrFile, "utf8").catch(() => "")
      if (testFailure !== undefined || stderr.trim().length > 0)
        console.info("candidate stderr tail", stderr.slice(-8000))
      const root = path.resolve(temporary)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
      if (!root.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      mark("fixture-cleanup-complete")
    }
  },
  120_000,
)

function completion(content: string) {
  const values = [{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }].map((chunk) => ({
    id: "chatcmpl-cudia-plugin-trace-fixture",
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
