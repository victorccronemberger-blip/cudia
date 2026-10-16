import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST

test.skipIf(candidate === undefined)(
  "compiled engine loads immutable distribution defaults below user and project config without tool runtimes",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name a compiled executable")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-distribution-candidate-"))
    const workspace = path.join(temporary, "project with spaces")
    const defaults = path.join(temporary, "immutable-defaults")
    const user = path.join(temporary, "user-config")
    const data = path.join(temporary, "data")
    let child: ReturnType<typeof Bun.spawn> | undefined
    let protectedDefaults = false
    try {
      await Promise.all(
        [workspace, defaults, user, data, path.join(defaults, "agent"), path.join(defaults, "skills", "sample")].map(
          (directory) => mkdir(directory, { recursive: true }),
        ),
      )
      const packaged = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "smoke/packaged",
        default_agent: "packaged-reviewer",
        snapshot: false,
        provider: {
          smoke: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture-only" },
            models: Object.fromEntries(
              ["packaged", "user", "project"].map((id) => [id, { name: id, limit: { context: 20000, output: 1000 } }]),
            ),
          },
        },
        mcp: { disabled: { type: "local", command: ["a-program-that-must-not-start"], enabled: false } },
      })
      await writeFile(path.join(defaults, "opencode.json"), packaged)
      await writeFile(
        path.join(defaults, "agent", "packaged-reviewer.md"),
        "---\nmode: primary\ndescription: PACKAGED_COMPILED_AGENT\n---\nPACKAGED_PROMPT",
      )
      await writeFile(
        path.join(defaults, "skills", "sample", "SKILL.md"),
        "---\nname: sample\ndescription: COMPILED_PACKAGED_SKILL\n---\nSample",
      )
      await writeFile(path.join(user, "opencode.json"), JSON.stringify({ model: "smoke/user" }))
      await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({ model: "smoke/project" }))
      const env = {
        PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: temporary,
        TMP: temporary,
        XDG_CONFIG_HOME: user,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_STATE_HOME: path.join(temporary, "state"),
        APPDATA: user,
        LOCALAPPDATA: data,
        OPENCODE_TEST_HOME: temporary,
        OPENCODE_CONFIG_DIR: user,
        CUDIA_DISTRIBUTION_DIR: defaults,
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_EXPERIMENTAL: "0",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        CUDIA_CONTEXT_MODE: "lean",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_SERVER_PASSWORD: "",
        npm_config_registry: "http://127.0.0.1:1",
        npm_config_fetch_retries: "0",
        npm_config_fetch_timeout: "1000",
      }
      if (process.platform === "win32") {
        const acl = Bun.spawn({
          cmd: ["icacls.exe", defaults, "/deny", "*S-1-1-0:(OI)(CI)(WD,AD,WEA,WA)"],
          env,
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        expect(await acl.exited).toBe(0)
        protectedDefaults = true
        let writeDenied = false
        try {
          await writeFile(path.join(defaults, "opencode.json"), packaged)
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM"].includes(String(error.code)))
            throw error
          writeDenied = true
        }
        expect(writeDenied).toBe(true)
      }
      const cli = Bun.spawn({
        cmd: [candidate, "debug", "config"],
        cwd: workspace,
        env,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, stdout, stderr] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const legacy = JSON.parse(stdout) as {
        model: string
        default_agent: string
        agent: Record<string, { description: string }>
        mcp: Record<string, { enabled: boolean }>
      }
      expect(legacy.model).toBe("smoke/user") // Explicit custom user config remains the final legacy override.
      expect(legacy.default_agent).toBe("packaged-reviewer")
      expect(legacy.agent["packaged-reviewer"]?.description).toBe("PACKAGED_COMPILED_AGENT")
      expect(legacy.mcp.disabled?.enabled).toBe(false)

      const socket = net.createServer()
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject)
        socket.listen(0, "127.0.0.1", resolve)
      })
      const address = socket.address()
      if (!address || typeof address === "string") throw new Error("Could not reserve server port")
      await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())))
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(address.port)],
        cwd: workspace,
        env,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const base = `http://127.0.0.1:${address.port}`
      const deadline = Date.now() + 20000
      let healthy = false
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("Candidate exited during startup")
        const res = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) }).catch(() => undefined)
        if (res?.ok) {
          healthy = true
          break
        }
        await Bun.sleep(100)
      }
      expect(healthy).toBe(true)
      const query = new URLSearchParams({ "location[directory]": workspace })
      const model = await fetch(`${base}/api/model/default?${query}`)
      expect(model.status).toBe(200)
      const selectedModel = ((await model.json()) as { data: { providerID: string; id: string } }).data
      expect(selectedModel.providerID).toBe("smoke")
      expect(selectedModel.id).toBe("project")
      const agents = await fetch(`${base}/api/agent?${query}`)
      expect(agents.status).toBe(200)
      expect(
        ((await agents.json()) as { data: { id: string; description?: string }[] }).data.find(
          (agent) => agent.id === "packaged-reviewer",
        )?.description,
      ).toBe("PACKAGED_COMPILED_AGENT")
      expect(await readFile(path.join(defaults, "opencode.json"), "utf8")).toBe(packaged)
      expect((await readdir(defaults)).sort()).toEqual(["agent", "opencode.json", "skills"])
    } finally {
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      if (protectedDefaults) {
        const acl = Bun.spawn({
          cmd: [
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
            defaults,
            "/remove:d",
            "*S-1-1-0",
            "/T",
            "/C",
          ],
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        if ((await acl.exited) !== 0) throw new Error("Could not restore this fixture's defaults ACL")
      }
      const root = path.resolve(temporary)
      const prefix = path.resolve(os.tmpdir()) + path.sep
      if (!root.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60000,
)
