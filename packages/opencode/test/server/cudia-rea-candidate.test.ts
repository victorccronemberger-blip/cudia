import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const archive = process.env.CUDIA_PACKAGE_TEST
const source = process.env.CUDIA_SOURCE_TEST === "1"
const enabled = process.env.CUDIA_REA_REAL_TEST === "1" && (source || candidate !== undefined)
type Request = {
  messages: readonly { role?: string; content?: unknown }[]
  tools?: readonly { function?: { name?: string } }[]
}

test.skipIf(!enabled || process.platform !== "win32")(
  "REA prepares on explicit V1 connect and analyzes JavaScript through selected V2 tools without Node on PATH",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cudia-rea-candidate-"))
    const workspace = path.join(root, "workspace")
    const config = path.join(root, "config")
    const cache = path.join(root, "cache")
    const target = path.join(workspace, "application")
    let child: ReturnType<typeof Bun.spawn> | undefined
    let provider: ReturnType<typeof Bun.serve> | undefined
    let failure: unknown
    const requests: Request[] = []
    try {
      await Promise.all([workspace, config, cache, target].map((directory) => mkdir(directory, { recursive: true })))
      const defaults = path.join(root, "package", "defaults")
      if (archive) {
        if (!path.isAbsolute(archive)) throw new Error("CUDIA_PACKAGE_TEST must be an absolute archive path")
        const unpack = Bun.spawn({
          cmd: [
            path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $env:CUDIA_FIXTURE_ARCHIVE -DestinationPath $env:CUDIA_FIXTURE_DESTINATION -ErrorAction Stop",
          ],
          env: { ...process.env, CUDIA_FIXTURE_ARCHIVE: archive, CUDIA_FIXTURE_DESTINATION: path.dirname(defaults) },
          stdout: "ignore",
          stderr: "pipe",
          windowsHide: true,
        })
        if ((await unpack.exited) !== 0)
          throw new Error(`Package extraction failed: ${await new Response(unpack.stderr).text()}`)
        const shipped = await Bun.file(path.join(defaults, "opencode.json")).json()
        expect(shipped.mcp.rea).toMatchObject({
          command: ["cudia:rea", "mcp"],
          environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" },
          enabled: false,
        })
        expect(await Bun.file(path.join(defaults, "skills", "rea", "SKILL.md")).text()).toContain("name: rea")
        expect(await Bun.file(path.join(defaults, "command", "rea.md")).text()).toContain("$ARGUMENTS")
      }
      await writeFile(
        path.join(target, "package.json"),
        JSON.stringify({ name: "cudia-rea-static-fixture", main: "main.js" }),
      )
      await writeFile(
        path.join(target, "main.js"),
        'export function cudiaReaAdd(a, b) { return a + b }\nthrow new Error("TARGET_MUST_NOT_EXECUTE");\n',
      )
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as Request
            requests.push(input)
            const names = input.tools?.map((tool) => tool.function?.name) ?? []
            if (requests.length <= 3)
              expect(
                names.some((name) => name?.startsWith("mcp_") && name.endsWith("_analyze_javascript_application")),
              ).toBe(false)
            if (requests.length === 1) return tool("mcp", { operation: "connect", server: "rea" }, "connect")
            if (requests.length === 2)
              return tool(
                "mcp",
                { operation: "search", server: "rea", query: "analyze_javascript_application" },
                "search",
              )
            if (requests.length === 3)
              return tool(
                "mcp",
                { operation: "expose", server: "rea", names: ["analyze_javascript_application"] },
                "expose",
              )
            if (requests.length === 4) {
              const name = names.find(
                (name) => name?.startsWith("mcp_") && name.endsWith("_analyze_javascript_application"),
              )
              expect(name).toBeString()
              return tool(name!, { input_path: target, detail: "complete" }, "analyze")
            }
            expect(requests.length).toBe(5)
            const text = JSON.stringify(input.messages)
            expect(text).toContain("cudiaReaAdd")
            expect(text).toContain("evidence_id")
            expect(
              names.filter((name) => name?.startsWith("mcp_") && name.endsWith("_analyze_javascript_application")),
            ).toHaveLength(1)
            return completion("CUDIA_REA_STATIC_OK")
          } catch (error) {
            failure = error
            return completion("CUDIA_REA_FIXTURE_FAILED")
          }
        },
      })
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          formatter: false,
          lsp: false,
          model: "smoke/smoke",
          mcp: archive
            ? undefined
            : {
                rea: {
                  type: "local",
                  command: ["cudia:rea", "mcp"],
                  environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" },
                  enabled: false,
                  timeout: 180000,
                },
              },
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "REA fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
      )
      const port = await availablePort()
      const base = `http://127.0.0.1:${port}`
      const windows = process.env.SystemRoot ?? "C:\\Windows"
      const env = {
        PATH: path.join(windows, "System32"),
        SystemRoot: windows,
        WINDIR: windows,
        HOME: root,
        USERPROFILE: root,
        TEMP: root,
        TMP: root,
        APPDATA: config,
        LOCALAPPDATA: path.join(root, "local"),
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: cache,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_TEST_HOME: root,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: path.join(root, "candidate.sqlite"),
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_EXPERIMENTAL: "0",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        CUDIA_CONTEXT_MODE: "lean",
        ...(archive ? { CUDIA_DISTRIBUTION_DIR: defaults } : {}),
      }
      const stderrFile = path.join(root, "stderr.log")
      child = Bun.spawn({
        cmd: candidate
          ? [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)]
          : [process.execPath, "run", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: source ? process.cwd() : os.tmpdir(),
        env,
        stdout: "ignore",
        stderr: Bun.file(stderrFile),
        windowsHide: true,
      })
      await poll(
        async () =>
          (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok ??
          false,
        child,
        60000,
      )
      const legacy = (suffix: string) => `${base}/mcp${suffix}?directory=${encodeURIComponent(workspace)}`
      const location = `location%5Bdirectory%5D=${encodeURIComponent(workspace)}`
      const admin = `${base}/api/mcp`
      expect((await fetch(legacy(""))).status).toBe(200)
      const initial = (await (await fetch(`${admin}?${location}`)).json()) as { data: unknown }
      expect(initial.data).toMatchObject([{ name: "rea", status: "disabled", toolCount: 0 }])
      expect(await readdir(path.join(cache, "opencode", "managed-rea")).catch(() => [])).toEqual([])
      expect(requests).toHaveLength(0)
      const started = Date.now()
      expect(
        (await fetch(legacy("/rea/connect"), { method: "POST", signal: AbortSignal.timeout(240000) })).status,
      ).toBe(200)
      const connected = (await (await fetch(legacy(""))).json()) as { rea?: { status: string } }
      if (connected.rea?.status !== "connected")
        throw new Error(`REA did not connect: ${JSON.stringify(connected.rea)}`)
      expect(connected.rea?.status).toBe("connected")
      expect((await fetch(legacy("/rea/disconnect"), { method: "POST" })).status).toBe(200)
      const identities = await readdir(path.join(cache, "opencode", "managed-rea"))
      expect(identities).toHaveLength(1)
      const receiptFile = path.join(cache, "opencode", "managed-rea", identities[0]!, "receipt.json")
      const receiptBytes = await readFile(receiptFile, "utf8")
      const receipt = JSON.parse(receiptBytes) as { nodeVersion: string; nodeSha256: string; packageFiles: unknown[] }
      expect(receipt.nodeVersion).toBe("24.22.0")
      expect(receipt.nodeSha256).toBe("ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c")
      expect(receipt.packageFiles.length).toBeGreaterThan(100)
      const created = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: workspace } }),
      })
      expect(created.status).toBe(200)
      const sessionID = ((await created.json()) as { data: { id: string } }).data.id
      const prompt = await fetch(`${base}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: { text: "Analyze the synthetic application using REA." } }),
      })
      expect(prompt.status).toBe(200)
      await prompt.arrayBuffer()
      await poll(
        async () => {
          if (failure !== undefined) throw failure
          if (requests.length < 5) return false
          const active = (await (await fetch(`${base}/api/session/active`)).json()) as { data: Record<string, unknown> }
          return !Object.hasOwn(active.data, sessionID)
        },
        child,
        180000,
      )
      expect(requests).toHaveLength(5)
      const final = (await (await fetch(`${admin}?${location}`)).json()) as { data: unknown }
      expect(final.data).toMatchObject([{ name: "rea", status: "connected", toolCount: 207, exposureCount: 1 }])
      expect(await readFile(receiptFile, "utf8")).toBe(receiptBytes)
      expect((await fetch(`${admin}/rea/disconnect?${location}`, { method: "POST" })).status).toBe(204)
      console.log(
        "compiled REA",
        JSON.stringify({
          portableNode: true,
          system32OnlyPath: true,
          dormantBeforeConnect: true,
          legacyConnected: true,
          nativeTools: 207,
          exposed: 1,
          staticJavaScript: true,
          cachedReceiptPreserved: true,
          elapsedMs: Date.now() - started,
        }),
      )
    } finally {
      provider?.stop(true)
      if (child) {
        if (child.exitCode === null && process.platform === "win32") {
          const cleanup = Bun.spawn({
            cmd: [
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
              "/PID",
              String(child.pid),
              "/T",
              "/F",
            ],
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          })
          await cleanup.exited
        }
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      const absolute = path.resolve(root)
      if (!absolute.toLowerCase().startsWith((path.resolve(os.tmpdir()) + path.sep).toLowerCase()))
        throw new Error("Unsafe fixture cleanup")
      await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  360000,
)

function tool(name: string, args: Record<string, unknown>, id: string) {
  return stream([
    {
      delta: {
        role: "assistant",
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
function stream(chunks: readonly Record<string, unknown>[]) {
  return new Response(
    chunks
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: "rea-fixture", object: "chat.completion.chunk", created: 0, model: "smoke", choices: [{ index: 0, ...choice }] })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}
async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Port unavailable")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
async function poll(check: () => Promise<boolean>, child: ReturnType<typeof Bun.spawn>, timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Candidate exited ${child.exitCode}`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error("REA candidate timed out")
}
