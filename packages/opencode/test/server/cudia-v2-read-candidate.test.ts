import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const PAGE_BUDGET = 6000
const LINE_BUDGET = 8
const PAGE_LIMIT = 4096
const SECRET = "READ_OPERATOR_REQUESTED_CONTENT_19C7"
const SEARCH_NEIGHBOR = "SEARCH_NEIGHBOR_MUST_NOT_REACH_PROVIDER_72B1"

type Message = { readonly role?: string; readonly content?: unknown; readonly tool_call_id?: string }
type CapturedRequest = {
  readonly messages: readonly Message[]
  readonly tools?: readonly { readonly function?: { readonly name?: string }; readonly name?: string }[]
}
type ExactPage = {
  readonly path: string
  readonly text: string
  readonly contentHash: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly totalLength: number
  readonly complete: boolean
  readonly offsetUnit: string
}
type DirectoryPage = {
  readonly entries: readonly { readonly path: string; readonly type: string }[]
  readonly truncated: boolean
  readonly next?: number
  readonly snapshot: string
}

test.skipIf(candidate === undefined)(
  "compiled CUDIA candidate recovers exact native reads and keeps search targets scoped",
  async () => {
    if (!candidate || !path.isAbsolute(candidate))
      throw new Error("CUDIA_CANDIDATE_TEST must be an absolute executable path")
    if (!(await Bun.file(candidate).exists())) throw new Error("CUDIA_CANDIDATE_TEST executable does not exist")

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-v2-read-candidate-"))
    const workspace = path.join(tempRoot, "workspace")
    const config = path.join(tempRoot, "config")
    const data = path.join(tempRoot, "data")
    const cache = path.join(tempRoot, "cache")
    const state = path.join(tempRoot, "state")
    const directory = path.join(workspace, "listing")
    const sourcePath = path.join(workspace, "long.txt")
    const searchDirectory = path.join(workspace, "search space [dir]")
    const searchFile = path.join(searchDirectory, "ação [file].ts")
    const outside = path.join(tempRoot, "outside")
    const source = '\uFEFFCANDIDATE_READ_SOURCE: "hello" \\\t🧪 e\u0301; ' + 'item-😀-"x"-\\-界 '.repeat(420)
    const expectedHash = createHash("sha256").update(JSON.stringify(source), "utf8").digest("hex")
    const names = Array.from({ length: 7 }, (_, index) => `entry-${String(index).padStart(2, "0")}-界界😀.txt`)
    const captured: CapturedRequest[] = []
    const exactPages: ExactPage[] = []
    const directoryEntries: string[] = []
    let provider: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let step:
      | "normal"
      | "recover"
      | "exact"
      | "changed"
      | "directoryFirst"
      | "missing"
      | "directory"
      | "drift"
      | "legacyAllowed"
      | "searchMissing"
      | "searchExact"
      | "searchGlob"
      | "searchLimit"
      | "searchInvalid"
      | "searchExternal"
      | "done" = "normal"
    let lastCall = ""
    let directorySnapshot: string | undefined
    let directoryOffset = 1
    let directoryPages = 0
    let completed = false
    let failure: unknown

    try {
      await Promise.all(
        [workspace, config, data, cache, state, directory, searchDirectory, outside].map((item) =>
          mkdir(item, { recursive: true }),
        ),
      )
      await Promise.all([
        writeFile(sourcePath, source, "utf8"),
        writeFile(path.join(workspace, "secret.txt"), SECRET, "utf8"),
        writeFile(searchFile, "é needle café\n", "utf8"),
        writeFile(path.join(searchDirectory, "many.txt"), "needle\n".repeat(14), "utf8"),
        writeFile(path.join(workspace, "neighbor.txt"), `${SEARCH_NEIGHBOR} needle`, "utf8"),
        writeFile(path.join(outside, "secret.txt"), SECRET, "utf8"),
        ...names.map((name) => writeFile(path.join(directory, name), "directory fixture", "utf8")),
      ])

      const issue = (args: Record<string, unknown>, id: string, name = "read") => {
        lastCall = `call-${id}`
        return toolCall(args, lastCall, name)
      }
      const consumeDirectory = (request: CapturedRequest) => {
        const response = toolResponse(request, lastCall)
        assertBudget(response)
        const page = JSON.parse(response) as DirectoryPage
        expect(page.snapshot).toMatch(/^[\da-f]{64}$/)
        if (directorySnapshot !== undefined) expect(page.snapshot).toBe(directorySnapshot)
        directorySnapshot ??= page.snapshot
        expect(page.entries.length).toBeGreaterThan(0)
        expect(page.entries.length).toBeLessThanOrEqual(2)
        expect(page.entries.map((entry) => entry.path)).toEqual(
          names.slice(directoryEntries.length, directoryEntries.length + page.entries.length),
        )
        expect(page.entries.every((entry) => entry.type === "file")).toBe(true)
        directoryEntries.push(...page.entries.map((entry) => entry.path))
        directoryPages++
        if (page.truncated) {
          expect(page.next).toBe(directoryOffset + page.entries.length)
          directoryOffset = page.next!
        } else expect(page.next).toBeUndefined()
        return page
      }

      // The fake provider controls tool arguments and checks the compiled server's actual provider-facing messages.
      // This is a deterministic protocol fixture, not evidence of model intelligence or prompt-injection resistance.
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as CapturedRequest
            const current: CapturedRequest = { messages: input.messages ?? [], tools: input.tools }
            captured.push(current)
            expect(captured.length).toBeLessThanOrEqual(40)
            expect((current.tools ?? []).map((tool) => tool.function?.name ?? tool.name)).toContain("read")
            if (step === "normal" || step === "recover" || step === "exact")
              expect(JSON.stringify(current.messages)).not.toContain(SECRET)
            expect(JSON.stringify(current.messages)).not.toContain(SEARCH_NEIGHBOR)

            if (step === "normal") {
              step = "recover"
              return issue({ path: "long.txt" }, "read-normal")
            }
            if (step === "recover") {
              const response = toolResponse(current, lastCall)
              assertBudget(response)
              const page = JSON.parse(response) as {
                type: string
                lineTruncated?: boolean
                truncated: boolean
                recovery?: { textPage?: unknown }
                next?: number
              }
              expect(page.type).toBe("text-page")
              expect(page.truncated).toBe(true)
              expect(page.lineTruncated).toBe(true)
              expect(page.recovery).toEqual({ textPage: {} })
              expect(page.next).toBeUndefined()
              step = "exact"
              return issue({ path: "long.txt", textPage: page.recovery!.textPage }, "read-exact-0")
            }
            if (step === "exact") {
              const response = toolResponse(current, lastCall)
              assertBudget(response)
              const page = JSON.parse(response) as ExactPage
              expect(page.contentHash).toBe(expectedHash)
              expect(page.offsetUnit).toBe("utf16_code_units")
              expect(page.totalLength).toBe(source.length)
              expect(page.offset).toBe(exactPages.reduce((sum, item) => sum + item.text.length, 0))
              expect(page.text.isWellFormed()).toBe(true)
              if (exactPages.length === 0) expect(page.text.startsWith("\uFEFF")).toBe(true)
              exactPages.push(page)
              if (!page.complete) {
                expect(page.nextOffset).toBe(page.offset + page.text.length)
                expect(page.nextOffset!).toBeGreaterThan(page.offset)
                return issue(
                  {
                    path: "long.txt",
                    textPage: { offset: page.nextOffset, limit: PAGE_LIMIT, contentHash: page.contentHash },
                  },
                  `read-exact-${page.nextOffset}`,
                )
              }
              expect(page.nextOffset).toBeNull()
              expect(exactPages.map((item) => item.text).join("")).toBe(source)
              expect(exactPages.length).toBeGreaterThan(1)
              const offset = exactPages[0]!.nextOffset
              expect(offset).not.toBeNull()
              await writeFile(sourcePath, `changed:${source}`, "utf8")
              step = "changed"
              return issue({ path: "long.txt", textPage: { offset, contentHash: expectedHash } }, "read-changed")
            }
            if (step === "changed") {
              const response = toolResponse(current, lastCall)
              expect(response).toMatch(/content changed; restart at offset 0/i)
              expect(response).not.toContain("CANDIDATE_READ_SOURCE")
              step = "directoryFirst"
              return issue({ path: "listing", limit: 2 }, "read-directory-1")
            }
            if (step === "directoryFirst") {
              const page = consumeDirectory(current)
              expect(page.truncated).toBe(true)
              step = "missing"
              return issue({ path: "listing", offset: directoryOffset, limit: 2 }, "read-directory-missing")
            }
            if (step === "missing") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain("Directory snapshot is missing or changed")
              expect(response).not.toContain('"entries"')
              step = "directory"
              return issue(
                { path: "listing", offset: directoryOffset, limit: 2, snapshot: directorySnapshot },
                `read-directory-${directoryOffset}`,
              )
            }
            if (step === "directory") {
              const page = consumeDirectory(current)
              if (page.truncated)
                return issue(
                  { path: "listing", offset: directoryOffset, limit: 2, snapshot: directorySnapshot },
                  `read-directory-${directoryOffset}`,
                )
              expect(directoryEntries).toEqual(names)
              expect(directoryPages).toBe(4)
              await writeFile(path.join(directory, "entry-00-new.txt"), "changes directory snapshot", "utf8")
              step = "drift"
              return issue(
                { path: "listing", offset: 3, limit: 2, snapshot: directorySnapshot },
                "read-directory-drift",
              )
            }
            if (step === "drift") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain("Directory snapshot is missing or changed")
              expect(response).not.toContain('"entries"')
              step = "legacyAllowed"
              return issue({ path: "secret.txt", textPage: {} }, "read-legacy-allowed")
            }
            if (step === "legacyAllowed") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain(SECRET)
              // Stored deny records must not override the operator-governed tool policy.
              step = "searchMissing"
              return issue({ path: "missing-search.txt", pattern: "needle" }, "search-missing", "grep")
            }
            if (step === "searchMissing") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain("Unable to grep")
              expect(response).not.toContain(SEARCH_NEIGHBOR)
              step = "searchExact"
              return issue(
                { path: path.relative(workspace, searchFile), pattern: "needle", include: "*.txt" },
                "search-exact",
                "grep",
              )
            }
            if (step === "searchExact") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain("Found 1 matches")
              expect(response).toContain(searchFile)
              expect(response).toContain("é needle café")
              await writeFile(path.join(searchDirectory, "fresh.ts"), "fresh needle", "utf8")
              step = "searchGlob"
              return issue(
                { path: path.relative(workspace, searchDirectory), pattern: "**/*.ts" },
                "search-glob",
                "glob",
              )
            }
            if (step === "searchGlob") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain(searchFile)
              expect(response).toContain(path.join(searchDirectory, "fresh.ts"))
              expect(response).not.toContain("many.txt")
              step = "searchLimit"
              return issue(
                { path: path.relative(workspace, searchDirectory), pattern: "needle", limit: 1 },
                "search-limit",
                "grep",
              )
            }
            if (step === "searchLimit") {
              const response = toolResponse(current, lastCall)
              assertBudget(response)
              expect(response).toContain("Found 1 matches")
              expect(response).toContain("Result limit reached (1)")
              step = "searchInvalid"
              return issue({ path: path.relative(workspace, searchFile), pattern: "[" }, "search-invalid", "grep")
            }
            if (step === "searchInvalid") {
              expect(toolResponse(current, lastCall)).toContain("regex")
              step = "searchExternal"
              return issue(
                { path: path.join(outside, "secret.txt"), pattern: "READ_OPERATOR" },
                "search-external",
                "grep",
              )
            }
            if (step === "searchExternal") {
              const response = toolResponse(current, lastCall)
              expect(response).toContain(SECRET)
              expect(response).toContain(path.join(outside, "secret.txt"))
              step = "done"
              completed = true
              return completion("NATIVE_READ_AND_SEARCH_RECOVERY_OK")
            }
            throw new Error(`Unexpected provider turn after ${step}`)
          } catch (error) {
            failure = error
            completed = true
            return completion("NATIVE_READ_FIXTURE_ASSERTION_FAILED")
          }
        },
      })

      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          snapshot: false,
          model: "smoke/smoke",
          tool_output: { max_bytes: PAGE_BUDGET, max_lines: LINE_BUDGET },
          permission: {
            read: { "*": "allow", "secret.txt": "deny" },
            glob: "allow",
            grep: "allow",
            external_directory: "deny",
          },
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "CUDIA native read fixture", limit: { context: 200000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )
      const environment = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: tempRoot,
        TMP: tempRoot,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        XDG_STATE_HOME: state,
        APPDATA: config,
        LOCALAPPDATA: data,
        OPENCODE_TEST_HOME: tempRoot,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
      }
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
          (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))
            ?.status === 200,
        child,
        "candidate server did not become healthy",
      )
      const created = await fetch(`${baseURL}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: workspace } }),
      })
      expect(created.status).toBe(200)
      const sessionID = ((await created.json()) as { data: { id: string } }).data.id
      const evaluation = await fetch(`${baseURL}/api/session/${sessionID}/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read", resources: ["secret.txt"] }),
      })
      expect(evaluation.status).toBe(200)
      expect((await evaluation.json()).data.effect).toBe("allow")
      const missingAgent = await fetch(`${baseURL}/api/session/${sessionID}/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read", resources: ["secret.txt"], agent: "missing-agent" }),
      })
      expect(missingAgent.status).toBe(400)
      expect(
        (await fetch(`${baseURL}/api/session/${sessionID}/permission`).then((value) => value.json())).data,
      ).toEqual([])
      const prompt = await fetch(`${baseURL}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: { text: "Exercise the local read fixture, its continuations and scoped searches." },
        }),
      })
      expect(prompt.status).toBe(200)
      await poll(
        async () => {
          if (!completed) return false
          const response = await fetch(`${baseURL}/api/session/active`).catch(() => undefined)
          if (!response?.ok) return false
          const active = (await response.json()) as { data: Record<string, unknown> }
          return !Object.hasOwn(active.data, sessionID)
        },
        child,
        "native read fixture session did not become idle",
      )
      if (failure !== undefined) throw failure
      expect(String(step)).toBe("done")
      expect(exactPages.map((page) => page.text).join("")).toBe(source)
      expect(directoryEntries).toEqual(names)
      expect(captured.some((request) => JSON.stringify(request.messages).includes(SECRET))).toBe(true)
      console.info(
        "compiled native read fixture",
        JSON.stringify({
          providerTurns: captured.length,
          sourceBytes: Buffer.byteLength(source),
          exactPages: exactPages.length,
          directoryPages,
          wholeOutputBytes: PAGE_BUDGET,
          wholeOutputLines: LINE_BUDGET,
        }),
      )
    } finally {
      provider?.stop(true)
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(tempRoot)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
      if (!root.toLowerCase().startsWith(prefix.toLowerCase()))
        throw new Error("Refusing to remove a path outside the temporary directory")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)

function assertBudget(output: string) {
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(PAGE_BUDGET)
  expect(output.split("\n").length).toBeLessThanOrEqual(LINE_BUDGET)
}

function toolResponse(request: CapturedRequest, callID: string) {
  const message = request.messages.find((item) => item.role === "tool" && item.tool_call_id === callID)
  if (!message) throw new Error(`Provider did not receive tool result for ${callID}`)
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content))
    return message.content
      .map((item: unknown) => {
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text
        throw new Error(`Unexpected non-text tool result for ${callID}`)
      })
      .join("")
  throw new Error(`Unexpected tool result content for ${callID}`)
}

function toolCall(args: Record<string, unknown>, id: string, name: string) {
  return stream([
    { delta: { role: "assistant" } },
    {
      delta: {
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
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
    id: "chatcmpl-cudia-read-fixture",
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
