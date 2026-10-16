import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, access, readFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const realRoot = process.env.CUDIA_LSP_REAL_ROOT
const node = process.env.CUDIA_LSP_NODE

type Request = {
  messages: readonly { role?: string; tool_call_id?: string; content?: unknown }[]
  tools?: readonly { function?: { name?: string }; name?: string }[]
}
type Followup = {
  files: readonly {
    filePath: string
    state: string
    source?: string
    freshness?: string
    diagnostics?: readonly { code?: number | string }[]
  }[]
  timedOut: boolean
  omittedFiles: number
  unsupportedFiles: number
}

test.skipIf(!candidate || !realRoot || !node)(
  "compiled V2 starts TypeScript LSP lazily and reports diagnostics after write, edit and patch",
  async () => {
    if (!candidate || !realRoot || !node) throw new Error("Candidate, real LSP root and Node executable are required")
    for (const file of [candidate, node, path.join(realRoot, "node_modules/typescript-language-server/lib/cli.mjs")]) {
      if (!path.isAbsolute(file)) throw new Error("LSP validation paths must be absolute")
      await access(file)
    }
    expect(
      JSON.parse(await readFile(path.join(realRoot, "node_modules/typescript-language-server/package.json"), "utf8"))
        .version,
    ).toBe("5.0.1")
    expect(
      JSON.parse(await readFile(path.join(realRoot, "node_modules/typescript/package.json"), "utf8")).version,
    ).toBe("5.8.2")
    const root = await mkdtemp(path.join(os.tmpdir(), "cudia-v2-lsp-candidate-"))
    const workspace = path.join(root, "workspace")
    const config = path.join(root, "config")
    const marker = path.join(root, "lsp-started.txt")
    const launches = path.join(root, "lsp-launches.log")
    const source = path.join(workspace, "ação [one].ts")
    const secret = "LSP_DENIED_CONTENT_32D9"
    const outside = path.join(root, "outside.ts")
    const wrapper = path.join(root, "lsp-wrapper.mjs")
    const wireLog = path.join(root, "lsp-wire.log")
    const cli = pathToFileURL(path.join(realRoot, "node_modules/typescript-language-server/lib/cli.mjs")).href
    const line = "export const result = double(21)"
    const original = `export function double(value: number) { return value * 2 }\r\n${line}\r\n`
    const position = { filePath: source, line: 2, character: line.indexOf("double") + 1 }
    let child: ReturnType<typeof Bun.spawn> | undefined
    let provider: ReturnType<typeof Bun.serve> | undefined
    let turn = 0
    let providerTurns = 0
    let issuedCalls = 0
    const initialPendingDiagnostics: { source: string; freshness: string; diagnostics: number; omitted: number }[] = []
    let done = false
    let failure: unknown
    let lastID = ""
    let coldStartTimedOut = false
    try {
      await Promise.all(
        [workspace, config, ...["data", "cache", "state"].map((name) => path.join(root, name))].map((directory) =>
          mkdir(directory, { recursive: true }),
        ),
      )
      await Promise.all([
        writeFile(source, original),
        writeFile(path.join(workspace, "denied.ts"), secret),
        writeFile(outside, `export function double(value: number) { return value * 2 }\r\n${line}\r\n`),
        writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } })),
        writeFile(
          wrapper,
          `import {writeFileSync,appendFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));appendFileSync(${JSON.stringify(launches)},String(process.pid)+String.fromCharCode(10));const original=process.stdout.write.bind(process.stdout);let bytes=0;process.stdout.write=function(chunk,...args){if(bytes<1048576){const value=Buffer.from(chunk);bytes+=value.length;appendFileSync(${JSON.stringify(wireLog)},value)}return original(chunk,...args)};await import(${JSON.stringify(cli)});`,
        ),
      ])
      const issueTool = (name: string, input: unknown) => {
        lastID = `${name}-${++issuedCalls}`
        return stream(
          {
            tool_calls: [
              {
                index: 0,
                id: lastID,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(input),
                },
              },
            ],
          },
          "tool_calls",
        )
      }
      const issue = (operation: string, filePath = source) =>
        issueTool("lsp", { ...position, operation, filePath, query: "double" })
      const followup = (text: string, completed = true): Followup => {
        const prefix = "\n\nPost-write LSP: "
        const offset = text.indexOf(prefix)
        expect(offset).toBeGreaterThanOrEqual(0)
        const result = JSON.parse(text.slice(offset + prefix.length)) as Followup
        if (completed) {
          expect(result.timedOut).toBe(false)
          expect(result.omittedFiles).toBe(0)
        }
        return result
      }
      const expectDiagnostics = (text: string, errors: boolean) => {
        const result = followup(text).files[0]!
        expect(result.filePath).toBe(source)
        expect(result.state).toBe("reported")
        expect(result.source).toBe("push")
        expect(["current", "unversioned"].includes(result.freshness ?? "")).toBe(true)
        if (errors) expect(result.diagnostics?.some((item) => item.code === 2322)).toBe(true)
        else expect(result.diagnostics).toEqual([])
      }
      // This fixture supplies deterministic model tool calls; it measures the compiled tool path, not model quality.
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as Request
            providerTurns++
            expect(JSON.stringify(input.messages)).not.toContain(secret)
            expect(input.tools?.map((tool) => tool.function?.name ?? tool.name)).toContain("lsp")
            const response = turn === 0 ? "" : toolText(input, lastID)
            switch (turn++) {
              case 0:
                expect(input.tools?.map((tool) => tool.function?.name ?? tool.name)).toEqual(
                  expect.arrayContaining(["lsp", "write", "edit", "apply_patch"]),
                )
                expect(await exists(marker)).toBe(false)
                return issue("hover", path.join(workspace, "missing.ts"))
              case 1:
                expect(response).not.toContain("contents")
                expect(await exists(marker)).toBe(false)
                return issueTool("write", {
                  path: source,
                  content: original + 'export const mismatch: number = "diagnostic fixture"\n',
                })
              case 2: {
                expect(response).toContain("Wrote file successfully")
                expect(await readFile(source, "utf8")).toContain('mismatch: number = "diagnostic fixture"')
                const result = followup(response, false)
                coldStartTimedOut = result.timedOut
                if (result.timedOut) {
                  expect(result.files).toEqual([])
                  expect(result.omittedFiles).toBe(1)
                  expect(result.unsupportedFiles).toBe(0)
                } else expectDiagnostics(response, true)
                return issue("diagnostics")
              }
              case 3: {
                const result = JSON.parse(response).result
                if (result.source === "none") {
                  expect(coldStartTimedOut).toBe(true)
                  expect(result).toMatchObject({ source: "none", freshness: "pending", diagnostics: [], omitted: 0 })
                  expect(initialPendingDiagnostics.length).toBeLessThan(2)
                  initialPendingDiagnostics.push({
                    source: result.source,
                    freshness: result.freshness,
                    diagnostics: result.diagnostics.length,
                    omitted: result.omitted,
                  })
                  console.info("Initial LSP diagnostics pending", JSON.stringify(initialPendingDiagnostics.at(-1)))
                  // A fresh, explicit read observes convergence; no mutating operation is replayed.
                  turn--
                  return issue("diagnostics")
                }
                expect(result.source).toBe("push")
                expect(["current", "unversioned"]).toContain(result.freshness)
                expect(result.diagnostics.some((item: { code?: number }) => item.code === 2322)).toBe(true)
                expect(await exists(marker)).toBe(true)
                return issue("hover", outside)
              }
              case 4:
                expect(response).toContain("double")
                expect(await exists(marker)).toBe(true)
                return issue("hover")
              case 5:
                expect(JSON.parse(response)).toMatchObject({ server: "typescript-fixture", omitted: 0 })
                expect(response).toContain("double")
                expect(await exists(marker)).toBe(true)
                return issue("goToDefinition")
              case 6:
                expect(response).toContain("uri")
                expect(response).toContain("range")
                return issue("findReferences")
              case 7:
                expect(JSON.parse(response).result.length).toBeGreaterThanOrEqual(2)
                return issue("documentSymbol")
              case 8:
                expect(response).toContain("double")
                return issue("workspaceSymbol")
              case 9:
                expect(response).toContain("double")
                return issueTool("edit", { path: source, oldString: '"diagnostic fixture"', newString: "1" })
              case 10:
                expect(response).toContain("Edited file successfully")
                expectDiagnostics(response, false)
                return issueTool("apply_patch", {
                  patchText: `*** Begin Patch\n*** Update File: ${source}\n@@\n-export const mismatch: number = 1\n+export const mismatch: number = "patch diagnostic"\n*** End Patch`,
                })
              case 11:
                expect(response).toContain("Applied patch sequentially")
                expectDiagnostics(response, true)
                return issueTool("apply_patch", {
                  patchText: `*** Begin Patch\n*** Delete File: ${outside}\n*** End Patch`,
                })
              case 12:
                expect(followup(response).files).toEqual([{ filePath: outside, state: "closed" }])
                expect(await exists(outside)).toBe(false)
                return issueTool("write", { path: source, content: "export const repaired: number = 1\n" })
              case 13:
                expectDiagnostics(response, false)
                return issue("diagnostics")
              case 14: {
                const result = JSON.parse(response).result
                if (result.source === "none") {
                  const wire = await readFile(wireLog, "utf8")
                  const uris = wire
                    .split('"method":"textDocument/publishDiagnostics"')
                    .slice(1)
                    .flatMap((part) => {
                      const value = part.match(/"uri":("(?:[^"\\]|\\.)*")/)
                      return value ? [JSON.parse(value[1]!)] : []
                    })
                  console.info(
                    "LSP diagnostic URI probe",
                    JSON.stringify({ admitted: pathToFileURL(source).href, published: [...new Set(uris)].slice(0, 8) }),
                  )
                }
                expect(result.source).toBe("push")
                expect(["current", "unversioned"]).toContain(result.freshness)
                expect(result.diagnostics).toEqual([])
                done = true
                return stream({ content: "NATIVE_LSP_REAL_SERVER_OK" }, "stop")
              }
              default:
                throw new Error("Unexpected additional LSP fixture turn")
            }
          } catch (error) {
            failure = error
            done = true
            return stream({ content: "NATIVE_LSP_FIXTURE_FAILED" }, "stop")
          }
        },
      })
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          model: "smoke/smoke",
          lsp: {
            "typescript-fixture": {
              command: [node, wrapper, "--stdio"],
              extensions: [".ts"],
              initialization: { tsserver: { path: path.join(realRoot, "node_modules/typescript/lib/tsserver.js") } },
            },
          },
          permission: { lsp: "deny", edit: "deny", external_directory: "deny" },
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "CUDIA native LSP fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
      )
      const port = await availablePort()
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          WINDIR: process.env.WINDIR ?? "",
          TEMP: root,
          TMP: root,
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          APPDATA: config,
          LOCALAPPDATA: path.join(root, "data"),
          OPENCODE_TEST_HOME: root,
          OPENCODE_CONFIG_DIR: config,
          OPENCODE_DB: path.join(root, "data/candidate.sqlite"),
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_SERVER_PASSWORD: "",
          OPENCODE_SERVER_USERNAME: "",
          OPENCODE_EXPERIMENTAL: "0",
        },
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const url = `http://127.0.0.1:${port}`
      await poll(async () => (await fetch(`${url}/api/health`).catch(() => undefined))?.status === 200, child)
      expect(await exists(marker)).toBe(false)
      const statusURL = new URL("/api/lsp", url)
      statusURL.searchParams.set("location[directory]", workspace)
      const cold = await fetch(statusURL)
      expect(cold.status).toBe(200)
      expect((await cold.json()).data).toMatchObject([{ id: "typescript-fixture", status: "not_started" }])
      expect(await exists(marker)).toBe(false)
      const session = await fetch(`${url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: workspace } }),
      })
      expect(session.status).toBe(200)
      const id = ((await session.json()) as { data: { id: string } }).data.id
      expect(
        (
          await fetch(`${url}/api/session/${id}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: { text: "Exercise the configured LSP fixture." } }),
          })
        ).status,
      ).toBe(200)
      await poll(async () => {
        if (!done) return false
        const active = (await fetch(`${url}/api/session/active`).then((response) => response.json())) as {
          data: Record<string, unknown>
        }
        return !Object.hasOwn(active.data, id)
      }, child)
      if (failure) throw failure
      expect(turn).toBe(15)
      expect(providerTurns).toBe(15 + initialPendingDiagnostics.length)
      const started = (await readFile(launches, "utf8")).trim().split(/\r?\n/)
      expect(started).toEqual([await readFile(marker, "utf8")])
      expect((await fetch(statusURL).then((value) => value.json())).data).toMatchObject([
        { id: "typescript-fixture", status: "connected", diagnosticMode: "push" },
      ])
      console.log(
        JSON.stringify({
          nativeLSP: true,
          realServer: "typescript-language-server@5.0.1",
          typescript: "5.8.2",
          turns: providerTurns,
          initialPendingDiagnostics,
          lazyStart: true,
          invalidInputBeforeStart: true,
          legacyDenyIgnored: true,
          afterWriteEditPatch: true,
          deletedDocumentClosed: true,
          coldStartTimedOut,
          serverLaunches: started.length,
          pid: Number(await readFile(marker, "utf8")),
        }),
      )
    } finally {
      provider?.stop(true)
      if (child && child.exitCode === null) {
        if (process.platform === "win32") {
          const cleanup = Bun.spawn({
            cmd: [
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"),
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
      if (
        !absolute.toLowerCase().startsWith(`${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase()) ||
        !path.basename(absolute).startsWith("cudia-v2-lsp-candidate-")
      )
        throw new Error("Refusing cleanup outside temporary directory")
      // Retry transient Windows teardown locks explicitly; permanent failures still fail the test.
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(absolute, { recursive: true, force: true })
          break
        } catch (error) {
          if (
            attempt === 5 ||
            !(error instanceof Error) ||
            !("code" in error) ||
            !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
          )
            throw error
          await Bun.sleep(100 * (attempt + 1))
        }
      }
    }
  },
  120_000,
)

async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  )
}

function toolText(input: Request, id: string) {
  const content = input.messages.find((message) => message.role === "tool" && message.tool_call_id === id)?.content
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part: unknown) => {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text
        throw new Error("Unexpected LSP tool result part")
      })
      .join("")
  throw new Error(`Missing tool result for ${id}`)
}

function stream(delta: Record<string, unknown>, reason: string) {
  const chunks = [{ role: "assistant" }, delta, {}]
    .map(
      (value, index) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-lsp",
          object: "chat.completion.chunk",
          created: 0,
          model: "smoke",
          choices: [{ index: 0, delta: value, ...(index === 2 ? { finish_reason: reason } : {}) }],
        })}\n\n`,
    )
    .join("")
  return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate local port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function poll(check: () => Promise<boolean>, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Candidate exited: ${child.exitCode}`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error("Compiled LSP fixture timed out")
}
