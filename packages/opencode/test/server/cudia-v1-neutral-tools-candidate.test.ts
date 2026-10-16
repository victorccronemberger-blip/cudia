import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const modelID = "neutral-tools-fixture"
const tools = ["bash", "todowrite", "glob", "task", "skill"]
const todos = [
  { content: "First", status: "in_progress", priority: "high" },
  { content: "Second", status: "in_progress", priority: "custom" },
]

type CapturedRequest = {
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
  readonly tools?: readonly {
    readonly function: { readonly name: string; readonly description: string }
  }[]
}

test.skipIf(candidate === undefined)(
  "compiled V1 exposes neutral tool contracts and executes shell, todo and glob",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")

    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-neutral-tools-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    const data = path.join(temporary, "data")
    const cache = path.join(temporary, "cache")
    const state = path.join(temporary, "state")
    const target = path.join(workspace, "shell-created.txt")
    let provider: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let failure: unknown
    let turn = 0
    let baseURL = ""
    let sessionID = ""
    const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
    const route = (pathname: string) => {
      const url = new URL(pathname, baseURL)
      url.searchParams.set("directory", workspace)
      return url
    }
    const storedTodos = async () => {
      const response = await fetch(route(`/session/${sessionID}/todo`), { headers })
      expect(response.status).toBe(200)
      return response.json()
    }

    try {
      await Promise.all(
        [workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })),
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
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(temporary, "no-global-git-config"),
      }
      const git = Bun.spawn({
        cmd: ["git", "init", "--quiet"],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      expect(await git.exited).toBe(0)

      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as CapturedRequest
            expect(input.tools?.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(tools))
            const descriptions = Object.fromEntries(
              input.tools!.map((tool) => [tool.function.name, tool.function.description]),
            )
            expect(descriptions.bash).toContain("Each invocation starts a new process")
            expect(descriptions.bash).not.toMatch(/DO NOT|pre-approved|Only commit/i)
            expect(descriptions.todowrite).toContain("Multiple entries can be in_progress")
            expect(descriptions.glob).not.toContain("use the Task tool instead")
            expect(descriptions.task).not.toContain("before choosing")
            expect(descriptions.skill).toContain("Search does not load skill bodies")
            const previous = JSON.stringify(input.messages)
            switch (turn++) {
              case 0:
                return toolCall(
                  "bash",
                  {
                    command: /PowerShell/.test(descriptions.bash)
                      ? "Set-Content -LiteralPath shell-created.txt -Value shell-value -Encoding utf8"
                      : "echo shell-value > shell-created.txt",
                    timeout: 10000,
                  },
                  "shell",
                )
              case 1:
                if (!(await Bun.file(target).exists()))
                  throw new Error(`Shell did not create fixture file: ${previous.slice(-6000)}`)
                expect((await readFile(target, "utf8")).replace(/^\uFEFF/, "")).toMatch(/^shell-value\s*$/)
                return toolCall("todowrite", { todos }, "todos")
              case 2:
                expect(await storedTodos()).toEqual(todos)
                return toolCall("glob", { pattern: "*.txt", path: "." }, "glob")
              case 3:
                expect(previous).toContain("shell-created.txt")
                return toolCall("todowrite", { todos: [todos[1]] }, "replace")
              case 4:
                expect(await storedTodos()).toEqual([todos[1]])
                return toolCall("todowrite", { todos: [] }, "clear")
              case 5:
                expect(await storedTodos()).toEqual([])
                return completion("DONE")
              default:
                throw new Error(`Unexpected provider turn ${turn}`)
            }
          } catch (error) {
            failure = error
            return completion("NEUTRAL_TOOLS_FIXTURE_ASSERTION_FAILED")
          }
        },
      })

      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          formatter: false,
          lsp: false,
          permission: { "*": "deny" },
          model: `smoke/${modelID}`,
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { [modelID]: { name: modelID, limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )
      const port = await availablePort()
      baseURL = `http://127.0.0.1:${port}`
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const deadline = Date.now() + 60_000
      while (true) {
        if (child.exitCode !== null) throw new Error(`Candidate exited: ${child.exitCode}`)
        if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok)
          break
        if (Date.now() >= deadline) throw new Error("Candidate server did not become healthy")
        await Bun.sleep(100)
      }
      const created = await fetch(route("/session"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Neutral tool contracts",
          agent: "build",
          model: { providerID: "smoke", id: modelID },
        }),
      })
      expect(created.status).toBe(200)
      sessionID = ((await created.json()) as { id: string }).id
      const response = await fetch(route(`/session/${sessionID}/message`), {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "smoke", modelID },
          parts: [
            {
              type: "text",
              text: "Create shell-created.txt with shell, store two todos in_progress, glob *.txt, replace the todo list with its second entry, then clear it.",
            },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      })
      expect(response.status).toBe(200)
      if (failure !== undefined) throw failure
      expect(turn).toBe(6)
      expect(await storedTodos()).toEqual([])
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
      ).toContain("DONE")
      console.info("compiled V1 neutral tools fixture", JSON.stringify({ turns: turn, tools }))
    } finally {
      provider?.stop(true)
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(temporary)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
      if (!root.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
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
    id: "chatcmpl-cudia-neutral-tools-fixture",
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
