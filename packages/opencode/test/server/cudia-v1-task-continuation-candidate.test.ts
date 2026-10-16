import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const modelID = "task-continuation-fixture"
const missingID = "ses_missing_continuation_fixture"

type CapturedRequest = {
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
}

test.skipIf(candidate === undefined)(
  "compiled V1 reports missing task identities and continues the same child session",
  async () => {
    if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")

    const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-task-continuation-candidate-"))
    const workspace = path.join(temporary, "workspace")
    const config = path.join(temporary, "config")
    const data = path.join(temporary, "data")
    const cache = path.join(temporary, "cache")
    const state = path.join(temporary, "state")
    let provider: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let failure: unknown
    let rootTurns = 0
    let childTurns = 0
    let baseURL = ""
    let sessionID = ""
    let childID = ""
    const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
    const route = (pathname: string) => {
      const url = new URL(pathname, baseURL)
      url.searchParams.set("directory", workspace)
      return url
    }
    const children = async () => {
      const response = await fetch(route(`/session/${sessionID}/children`), { headers })
      expect(response.status).toBe(200)
      return (await response.json()) as { readonly id: string; readonly parentID: string }[]
    }
    const task = (prompt: string, id: string, taskID?: string) =>
      stream([
        { delta: { role: "assistant" } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${id}`,
                type: "function",
                function: {
                  name: "task",
                  arguments: JSON.stringify({
                    description: "Continuation fixture",
                    prompt,
                    subagent_type: "general",
                    ...(taskID === undefined ? {} : { task_id: taskID }),
                  }),
                },
              },
            ],
          },
        },
        { delta: {}, finish_reason: "tool_calls" },
      ])

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
            const identity = request.headers.get("x-session-id")
            const previous = JSON.stringify(input.messages)
            if (identity !== sessionID) {
              expect(identity).toBeTruthy()
              expect(previous).not.toContain("ROOT_CONTINUATION_FIXTURE")
              expect(previous).not.toContain("INVALID_CHILD_PROMPT")
              switch (childTurns++) {
                case 0: {
                  expect(previous).toContain("CHILD_FIRST_PROMPT")
                  const current = await children()
                  expect(current).toHaveLength(1)
                  expect(current[0].id).toBe(identity!)
                  childID = current[0].id
                  return completion("CHILD_FIRST_RESULT")
                }
                case 1:
                  expect(identity).toBe(childID)
                  expect(previous).toContain("CHILD_FIRST_PROMPT")
                  expect(previous).toContain("CHILD_FIRST_RESULT")
                  expect(previous).toContain("CHILD_SECOND_PROMPT")
                  return completion("CHILD_SECOND_RESULT")
                default:
                  throw new Error(`Unexpected child provider turn ${childTurns}`)
              }
            }
            switch (rootTurns++) {
              case 0:
                return task("INVALID_CHILD_PROMPT", "missing", missingID)
              case 1:
                expect(previous).toContain(`Session not found: ${missingID}`)
                expect(await children()).toEqual([])
                expect(childTurns).toBe(0)
                return task("CHILD_FIRST_PROMPT", "new")
              case 2:
                expect(childID).toBeTruthy()
                expect(previous).toContain("CHILD_FIRST_RESULT")
                expect(previous).toContain(childID)
                return task("CHILD_SECOND_PROMPT", "continue", childID)
              case 3:
                expect(previous).toContain("CHILD_SECOND_RESULT")
                expect(await children()).toEqual([expect.objectContaining({ id: childID, parentID: sessionID })])
                expect(childTurns).toBe(2)
                return completion("DONE")
              default:
                throw new Error(`Unexpected root provider turn ${rootTurns}`)
            }
          } catch (error) {
            failure = error
            return completion("TASK_CONTINUATION_FIXTURE_ASSERTION_FAILED")
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
          title: "Task continuation",
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
              text: "ROOT_CONTINUATION_FIXTURE: resume a missing task, create one explicitly, then continue that exact task.",
            },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      expect(response.status).toBe(200)
      if (failure !== undefined) throw failure
      expect(rootTurns).toBe(4)
      expect(childTurns).toBe(2)
      expect(await children()).toEqual([expect.objectContaining({ id: childID, parentID: sessionID })])
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
      console.info(
        "compiled V1 task continuation",
        JSON.stringify({ rootTurns, childTurns, missingDidNotCreate: true, continuedSameChild: true }),
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
      if (!root.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)

function completion(content: string) {
  return stream([{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }])
}

function stream(chunks: ReadonlyArray<Record<string, unknown>>) {
  const values = chunks.map((chunk) => ({
    id: "chatcmpl-cudia-task-continuation-fixture",
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
