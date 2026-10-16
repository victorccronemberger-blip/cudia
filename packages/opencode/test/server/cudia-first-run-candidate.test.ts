import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const archive = process.env.CUDIA_PACKAGE_TEST

test.skipIf(!candidate || !archive || process.platform !== "win32")(
  "packaged defaults keep an empty profile unconnected and preserve explicit project providers",
  async () => {
    if (!candidate || !archive || !path.isAbsolute(candidate) || !path.isAbsolute(archive))
      throw new Error("Candidate and archive must be absolute paths")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-first-run-"))
    const workspace = path.join(temporary, "project ação")
    const extracted = path.join(temporary, "package")
    const config = path.join(temporary, "config")
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await mkdir(workspace)
      await mkdir(config)
      const windows = process.env.SystemRoot ?? "C:\\Windows"
      const env = {
        PATH: path.join(windows, "System32"),
        SystemRoot: windows,
        WINDIR: windows,
        USERPROFILE: temporary,
        APPDATA: config,
        LOCALAPPDATA: path.join(temporary, "local"),
        TEMP: temporary,
        TMP: temporary,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: path.join(temporary, "data"),
        XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_STATE_HOME: path.join(temporary, "state"),
        OPENCODE_TEST_HOME: temporary,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DISABLE_CHANNEL_DB: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_FFF: "1",
        CUDIA_CONTEXT_MODE: "lean",
        CUDIA_DISTRIBUTION_DIR: path.join(extracted, "defaults"),
        CUDIA_FIXTURE_ARCHIVE: archive,
        CUDIA_FIXTURE_DESTINATION: extracted,
      }
      const unpack = Bun.spawn({
        cmd: [
          path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:CUDIA_FIXTURE_ARCHIVE -DestinationPath $env:CUDIA_FIXTURE_DESTINATION -ErrorAction Stop",
        ],
        env,
        stdout: "ignore",
        stderr: "pipe",
        windowsHide: true,
      })
      if ((await unpack.exited) !== 0)
        throw new Error(`Archive extraction failed: ${await new Response(unpack.stderr).text()}`)
      const defaults = await Bun.file(path.join(extracted, "defaults", "opencode.json")).json()
      expect(defaults).not.toHaveProperty("model")
      expect(defaults).not.toHaveProperty("small_model")
      const reservation = net.createServer()
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject)
        reservation.listen(0, "127.0.0.1", resolve)
      })
      const address = reservation.address()
      if (!address || typeof address === "string") throw new Error("No fixture port")
      await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())))
      const base = `http://127.0.0.1:${address.port}`
      const start = async () => {
        child = Bun.spawn({
          cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(address.port)],
          cwd: workspace,
          env,
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        const deadline = Date.now() + 30_000
        while (!(await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok) {
          if (child.exitCode !== null) throw new Error(`Candidate exited ${child.exitCode}`)
          if (Date.now() >= deadline) throw new Error("Candidate did not start")
          await Bun.sleep(100)
        }
      }
      const get = async (route: string) => {
        const response = await fetch(`${base}${route}?directory=${encodeURIComponent(workspace)}`, {
          signal: AbortSignal.timeout(10_000),
        })
        expect(response.status).toBe(200)
        return response.json()
      }
      await start()
      const empty = (await get("/provider")) as { all: { id: string }[]; connected: string[] }
      for (const id of ["deepseek", "glm", "qwencloud"]) {
        expect(empty.all.some((provider) => provider.id === id)).toBe(true)
        expect(empty.connected).not.toContain(id)
      }
      const visible = (await get("/config/providers")) as { providers: { id: string }[] }
      expect(visible.providers).toEqual([])
      expect(empty.all.some((provider) => ["opencode", "opencode-go"].includes(provider.id))).toBe(false)
      for (const id of ["openai", "xai"]) {
        const response = await fetch(`${base}/auth/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "api", key: "fixture-only-not-a-live-key" }),
          signal: AbortSignal.timeout(5000),
        })
        expect(response.status).toBe(200)
      }
      child!.kill()
      await child!.exited
      await start()
      const authenticated = (await get("/provider")) as { connected: string[] }
      expect(authenticated.connected).toContain("openai")
      expect(authenticated.connected).toContain("xai")
      await writeFile(
        path.join(workspace, "opencode.json"),
        JSON.stringify({
          model: "local-fixture/chat",
          provider: {
            "local-fixture": {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:1/v1" },
              models: { chat: { limit: { context: 10000, output: 1000 } } },
            },
          },
        }),
      )
      child!.kill()
      await child!.exited
      await start()
      const overridden = (await get("/provider")) as { connected: string[] }
      expect(overridden.connected).toContain("local-fixture")
      expect((await get("/config")).model).toBe("local-fixture/chat")
    } finally {
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(temporary)
      const parent = path.resolve(os.tmpdir()) + path.sep
      if (!root.toLowerCase().startsWith(parent.toLowerCase()) || !path.basename(root).startsWith("cudia-first-run-"))
        throw new Error("Unsafe fixture cleanup")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)
