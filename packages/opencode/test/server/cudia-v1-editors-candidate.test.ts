import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const models = ["gpt-5.2-fixture", "qwen3.8-flash-fixture"]
const editors = ["write", "edit", "apply_patch"]
const original = "existing\n"

type CapturedRequest = {
  readonly model?: string
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
  readonly tools?: readonly { readonly function?: { readonly name?: string }; readonly name?: string }[]
}

for (const modelID of models) {
  test.skipIf(candidate === undefined)(
    `compiled V1 editor tools remain available through ${modelID}`,
    async () => {
      await runModel(modelID)
    },
    120_000,
  )
}

async function runModel(modelID: string) {
  if (!candidate || !path.isAbsolute(candidate) || !(await Bun.file(candidate).exists()))
    throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")

  const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-editors-candidate-"))
  const workspace = path.join(temporary, "workspace")
  const config = path.join(temporary, "config")
  const data = path.join(temporary, "data")
  const cache = path.join(temporary, "cache")
  const state = path.join(temporary, "state")
  const target = path.join(workspace, "target.txt")
  let provider: ReturnType<typeof Bun.serve> | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  let failure: unknown
  let turn = 0

  try {
    await Promise.all([workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })))
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
    await writeFile(target, original, "utf8")

    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
        try {
          const input = (await request.json()) as CapturedRequest
          expect(input.model).toBe(modelID)
          expect(input.tools?.map((tool) => tool.function?.name ?? tool.name)).toEqual(expect.arrayContaining(editors))
          const previous = JSON.stringify(input.messages)
          switch (turn++) {
            case 0:
              expect(await readFile(target, "utf8")).toBe(original)
              return toolCall("write", { filePath: "target.txt", content: "one\n" }, "write")
            case 1:
              expect(previous).toContain("Wrote file successfully.")
              expect(await readFile(target, "utf8")).toBe("one\n")
              return toolCall("edit", { filePath: "target.txt", oldString: "one\n", newString: "two\n" }, "edit")
            case 2:
              expect(previous).toContain("Edit applied successfully.")
              expect(await readFile(target, "utf8")).toBe("two\n")
              return toolCall(
                "apply_patch",
                {
                  patchText: "*** Begin Patch\n*** Update File: target.txt\n@@\n-two\n+three\n*** End Patch",
                },
                "apply-patch",
              )
            case 3:
              expect(previous).toContain("Success. Updated the following files:")
              expect(await readFile(target, "utf8")).toBe("three\n")
              return completion("DONE")
            default:
              throw new Error(`Unexpected provider turn ${turn}`)
          }
        } catch (error) {
          failure = error
          return completion("EDITOR_FIXTURE_ASSERTION_FAILED")
        }
      },
    })

    await writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        snapshot: false,
        formatter: false,
        lsp: false,
        permission: { "*": "deny" },
        model: `smoke/${modelID}`,
        provider: {
          smoke: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
            models: {
              [modelID]: { name: `V1 editor fixture ${modelID}`, limit: { context: 200000, output: 4096 } },
            },
          },
        },
      }),
      "utf8",
    )

    const port = await availablePort()
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
      async () =>
        (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined))
          ?.status === 200,
      child,
      "candidate server did not become healthy",
    )

    const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
    const route = (pathname: string) => {
      const url = new URL(pathname, baseURL)
      url.searchParams.set("directory", workspace)
      return url
    }
    const created = await fetch(route("/session"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `V1 editor fixture ${modelID}`,
        agent: "build",
        model: { providerID: "smoke", id: modelID },
      }),
    })
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()) as { id: string }).id
    const response = await fetch(route(`/session/${sessionID}/message`), {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "smoke", modelID },
        parts: [
          {
            type: "text",
            text: `Use write to replace target.txt with one, edit one to two, then use apply_patch to change two to three. Model fixture: ${modelID}.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    })
    expect(response.status).toBe(200)
    if (failure !== undefined) throw failure
    expect(turn).toBe(4)
    expect(await readFile(target, "utf8")).toBe("three\n")
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
    console.info("compiled V1 editor fixture", JSON.stringify({ modelID, turns: turn, editors }))
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
}

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
    id: "chatcmpl-cudia-v1-editors-fixture",
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
