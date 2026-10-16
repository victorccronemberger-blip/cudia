import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST

test.skipIf(candidate === undefined)(
  "compiled distribution uses its bundled catalog and local UI without implicit OpenCode services",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-backend-candidate-"))
    const requests: string[] = []
    const catalog = {
      fixture: {
        id: "fixture",
        name: "Operator catalog",
        env: ["FIXTURE_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "http://operator-provider.cudia.test/v1",
        models: {
          fixture: {
            id: "fixture",
            name: "Operator model",
            release_date: "2026-10-16",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 20000, output: 1000 },
          },
        },
      },
    }
    const proxy = http.createServer((request, response) => {
      requests.push(request.url ?? "missing-url")
      if (request.url === "http://operator-catalog.cudia.test/api.json") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(catalog))
        return
      }
      response.writeHead(502)
      response.end()
    })
    proxy.on("connect", (request, socket) => {
      requests.push(`CONNECT ${request.url}`)
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", resolve)
    })
    const address = proxy.address()
    if (!address || typeof address === "string") throw new Error("Proxy did not start")
    const proxyURL = `http://127.0.0.1:${address.port}`
    const children: ReturnType<typeof Bun.spawn>[] = []
    try {
      const workspace = path.join(temporary, "workspace")
      const config = path.join(temporary, "config")
      await Promise.all([workspace, config].map((directory) => mkdir(directory, { recursive: true })))
      await writeFile(path.join(config, "opencode.json"), JSON.stringify({ snapshot: false }))
      const env = {
        PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
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
        OPENCODE_DB: path.join(temporary, "data", "candidate.sqlite"),
        HTTP_PROXY: proxyURL,
        HTTPS_PROXY: proxyURL,
        http_proxy: proxyURL,
        https_proxy: proxyURL,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      }
      // No disable-model-fetch, disable-updater, disable-plugin or no-network flag:
      // the compiled product defaults must account for absence of these requests.
      const cli = async (args: string[], extra: Record<string, string> = {}) => {
        const process = Bun.spawn({
          cmd: [candidate!, ...args],
          cwd: workspace,
          env: { ...env, ...extra },
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        children.push(process)
        const timeout = setTimeout(() => process.kill(), 30_000)
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ])
          return { stdout, stderr, code }
        } finally {
          clearTimeout(timeout)
        }
      }
      const models = await cli(["models", "--refresh"])
      expect(models.code, models.stderr).toBe(0)
      expect(models.stdout + models.stderr).not.toMatch(/^opencode(?:-go)?\//m)
      expect(requests).toEqual([])

      const port = await availablePort()
      const server = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: workspace,
        env,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      children.push(server)
      const base = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 30_000
      let ready = false
      while (Date.now() < deadline && server.exitCode === null) {
        const response = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(1000) }).catch(
          () => undefined,
        )
        if (response?.ok) {
          ready = true
          break
        }
        await Bun.sleep(100)
      }
      expect(ready, "Compiled server failed to start").toBe(true)
      const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
      const providers = await fetch(`${base}/provider`, { headers }).then((response) => response.json())
      expect(providers.all.some((provider: { id: string }) => ["opencode", "opencode-go"].includes(provider.id))).toBe(false)
      expect(providers.connected).toEqual([])
      const ui = await fetch(base)
      expect(ui.status).toBe(503)
      expect(await ui.text()).toMatch(/(?:CUDIA|Cudia|assets|interface)/)
      const upgrade = await fetch(`${base}/global/upgrade`, {
        method: "POST",
        headers,
        body: JSON.stringify({ target: "1.2.3" }),
      })
      expect(upgrade.status).toBe(503)
      expect(await upgrade.text()).toContain("cudia update")
      const created = await fetch(`${base}/session`, { method: "POST", headers, body: "{}" })
      expect(created.status).toBe(200)
      const session = (await created.json()) as { id: string }
      const share = await fetch(`${base}/session/${session.id}/share`, { method: "POST", headers, body: "{}" })
      expect(share.ok).toBe(false)
      expect(requests).toEqual([])

      const rawUpgrade = await cli(["upgrade"])
      expect(rawUpgrade.stdout + rawUpgrade.stderr).toContain("cudia update")
      const github = await cli(["github", "install"])
      expect(github.code).not.toBe(0)
      const account = await cli(["console", "login"])
      expect(account.code).not.toBe(0)
      expect(requests).toEqual([])

      // Positive control: the same transport observes a URL explicitly supplied
      // by the operator. A disconnected observer cannot pass this fixture.
      const custom = await cli(["models", "--refresh"], {
        OPENCODE_MODELS_URL: "http://operator-catalog.cudia.test",
      })
      expect(custom.code, custom.stderr).toBe(0)
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every((url) => url === "http://operator-catalog.cudia.test/api.json")).toBe(true)
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) =>
          error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? reject(error) : resolve(),
        ),
      )
      await rm(temporary, { recursive: true, force: true })
    }
  },
  180_000,
)

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Cannot reserve a server port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
