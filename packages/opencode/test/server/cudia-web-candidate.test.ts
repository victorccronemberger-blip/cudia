import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST

test.skipIf(!candidate)(
  "compiled catalog exposes web search across providers without backend flags",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an absolute executable")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-web-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await mkdir(workspace)
      await mkdir(config)
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({ snapshot: false, formatter: false, lsp: false }),
      )
      const reservation = net.createServer()
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject)
        reservation.listen(0, "127.0.0.1", resolve)
      })
      const address = reservation.address()
      if (!address || typeof address === "string") throw new Error("No fixture port")
      await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())))
      const base = `http://127.0.0.1:${address.port}`
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(address.port)],
        cwd: workspace,
        env: {
          PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
          SystemRoot: process.env.SystemRoot ?? "",
          WINDIR: process.env.WINDIR ?? "",
          TEMP: temporary,
          TMP: temporary,
          XDG_DATA_HOME: path.join(temporary, "data"),
          XDG_CONFIG_HOME: config,
          XDG_CACHE_HOME: path.join(temporary, "cache"),
          XDG_STATE_HOME: path.join(temporary, "state"),
          APPDATA: config,
          LOCALAPPDATA: path.join(temporary, "local"),
          OPENCODE_TEST_HOME: temporary,
          OPENCODE_CONFIG_DIR: config,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_FFF: "1",
          OPENCODE_ENABLE_EXA: "0",
          OPENCODE_EXPERIMENTAL_EXA: "0",
          OPENCODE_ENABLE_PARALLEL: "0",
          OPENCODE_EXPERIMENTAL_PARALLEL: "0",
          OPENCODE_EXPERIMENTAL: "0",
          CUDIA_CONTEXT_MODE: "lean",
          OPENCODE_SERVER_USERNAME: "",
          OPENCODE_SERVER_PASSWORD: "",
        },
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
      for (const provider of ["openai", "xai", "qwencloud", "custom-provider"]) {
        const url = new URL("/experimental/tool", base)
        url.searchParams.set("provider", provider)
        url.searchParams.set("model", "catalog-fixture")
        url.searchParams.set("directory", workspace)
        const response = await fetch(url, {
          headers: { "x-opencode-directory": workspace },
          signal: AbortSignal.timeout(10_000),
        })
        expect(response.status).toBe(200)
        const tools = (await response.json()) as {
          id: string
          description: string
          parameters: { required?: string[] }
        }[]
        const search = tools.find((tool) => tool.id === "websearch")
        expect(search).toBeDefined()
        expect(search?.parameters.required).toContain("query")
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(temporary)
      const parent = path.resolve(os.tmpdir()) + path.sep
      if (!root.toLowerCase().startsWith(parent.toLowerCase())) throw new Error("Unsafe fixture cleanup")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60_000,
)
