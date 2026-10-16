export * as LSPV2 from "./lsp"

import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import which from "which"
import { Context, Effect, Exit, Layer, Queue, Scope, Semaphore, Stream } from "effect"
import { LspEvent } from "@opencode-ai/schema/lsp-event"
import { Config } from "./config"
import { ConfigLSP } from "./config/lsp"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { EventV2 } from "./event"
import { Service, node } from "./process"
import { BoundedFile } from "./util/bounded-file"
import { LSPClient } from "./lsp/client"
import { LSPError } from "./lsp/error"
import { LSPFraming } from "./lsp/framing"
import { LSPDiagnostics } from "./lsp/diagnostics"

export { Failure } from "./lsp/error"
export type { Diagnostic } from "./lsp/diagnostics"
export type DiagnosticResult = LSPDiagnostics.Result
export type ServerStatus = {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly status: "not_started" | "starting" | "connected" | "error" | "missing" | "disabled"
  readonly failure?: LSPError.Failure["kind"]
  readonly diagnosticMode?: "pull" | "push" | "none"
}
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_RESULTS = 256
export const MAX_RESULT_BYTES = 1024 * 1024
export const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const
export type Operation = (typeof operations)[number]
export type Query = {
  readonly operation: Operation
  readonly filePath: string
  readonly line: number
  readonly character: number
  readonly query?: string
}
export type Result = { readonly server: string; readonly result: unknown; readonly omitted: number }
export interface Interface {
  readonly supports: (input: { readonly filePath: string }) => Effect.Effect<boolean, LSPError.Failure>
  readonly query: (input: Query) => Effect.Effect<Result, LSPError.Failure>
  readonly diagnostics: (input: { readonly filePath: string }) => Effect.Effect<DiagnosticResult, LSPError.Failure>
  readonly forget: (input: { readonly filePath: string; readonly kind: "changed" | "deleted" }) => Effect.Effect<void>
  readonly didClose: (input: { readonly filePath: string }) => Effect.Effect<void, LSPError.Failure>
  readonly status: () => Effect.Effect<readonly ServerStatus[]>
}
export class LSPService extends Context.Service<LSPService, Interface>()("@opencode/v2/LSP") {}
export { LSPService as Service }

const builtins = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
  },
  gopls: { command: ["gopls"], extensions: ["go"] },
  pyright: { command: ["pyright-langserver", "--stdio"], extensions: ["py", "pyi"] },
  rust: { command: ["rust-analyzer"], extensions: ["rs"] },
  clangd: { command: ["clangd"], extensions: ["c", "h", "cc", "cpp", "cxx", "hpp"] },
} satisfies Record<string, { command: string[]; extensions: string[] }>
type Server = {
  readonly name: string
  readonly command: readonly string[]
  readonly extensions: readonly string[]
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}
type Connection = {
  readonly scope: Scope.Closeable
  readonly lock: Semaphore.Semaphore
  handle?: LSPClient.Handle
  ready?: Readiness
  error?: LSPError.Failure
  readonly documents: Map<string, Document>
  readonly files: Map<string, Semaphore.Semaphore>
  status: ServerStatus["status"]
  pushObserved: boolean
}
type Document = {
  hash: string
  end: { line: number; character: number }
  version: number
  generation: number
  open: boolean
  admitted: boolean
  dirty: boolean
  deleted: boolean
  ticket: number
  report?: LSPDiagnostics.Report
  readonly waiters: Set<() => void>
}
type Readiness = {
  readonly promise: Promise<Exit.Exit<LSPClient.Handle, LSPError.Failure>>
  readonly resolve: (exit: Exit.Exit<LSPClient.Handle, LSPError.Failure>) => void
  exit?: Exit.Exit<LSPClient.Handle, LSPError.Failure>
  registrations: number
}
const methods = {
  goToDefinition: ["textDocument/definition", "definitionProvider"],
  findReferences: ["textDocument/references", "referencesProvider"],
  hover: ["textDocument/hover", "hoverProvider"],
  documentSymbol: ["textDocument/documentSymbol", "documentSymbolProvider"],
  workspaceSymbol: ["workspace/symbol", "workspaceSymbolProvider"],
  goToImplementation: ["textDocument/implementation", "implementationProvider"],
  prepareCallHierarchy: ["textDocument/prepareCallHierarchy", "callHierarchyProvider"],
  incomingCalls: ["callHierarchy/incomingCalls", "callHierarchyProvider"],
  outgoingCalls: ["callHierarchy/outgoingCalls", "callHierarchyProvider"],
} as const

/** Construction has no filesystem or process effects; queries use the captured Location configuration. */
export function make(input: {
  readonly directory: string
  readonly configuration?: typeof ConfigLSP.Info.Type
  readonly fs: FSUtil.Interface
  readonly process: Service["Service"]
  readonly timeout?: { readonly startup: number; readonly request: number }
  readonly onChange?: Effect.Effect<void>
}): Effect.Effect<Interface, never, Scope.Scope> {
  return Effect.gen(function* () {
    const lifetime = yield* Scope.Scope
    const connections = new Map<string, Connection>()
    let closed = false
    let active = 0
    const updates = yield* Queue.dropping<void>(1)
    const changed = () => {
      if (!closed) Queue.offerUnsafe(updates, undefined)
    }
    yield* Stream.fromQueue(updates).pipe(
      Stream.runForEach(() => Effect.sleep(25).pipe(Effect.andThen(input.onChange ?? Effect.void))),
      Effect.forkScoped,
    )
    const wake = (document: Document) => {
      for (const listener of [...document.waiters]) listener()
    }
    const clear = (document: Document) => {
      document.report = undefined
      wake(document)
    }
    const cache = (document: Document, report: LSPDiagnostics.Report) => {
      let bytes = 0
      for (const current of connections.values())
        for (const doc of current.documents.values()) if (doc !== document) bytes += doc.report?.bytes ?? 0
      if (bytes + report.bytes > LSPDiagnostics.MAX_CACHE_BYTES) {
        for (const current of connections.values())
          for (const doc of current.documents.values()) {
            if (doc === document || !doc.report || bytes + report.bytes <= LSPDiagnostics.MAX_CACHE_BYTES) continue
            bytes -= doc.report.bytes
            clear(doc)
            if (bytes + report.bytes <= LSPDiagnostics.MAX_CACHE_BYTES) break
          }
      }
      document.report = report
      wake(document)
      changed()
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true
        for (const connection of connections.values()) {
          for (const document of connection.documents.values()) {
            document.admitted = false
            clear(document)
          }
          if (connection.ready) complete(connection.ready, Exit.fail(error("closed", "LSP location is closed")))
          if (connection.handle) yield* connection.handle.close
          yield* Scope.close(connection.scope, Exit.void)
        }
        connections.clear()
        yield* Queue.shutdown(updates)
      }),
    )
    const execute = (args: Query, diagnostic = false) =>
      Effect.gen(function* () {
        if (closed) return yield* fail("closed", "LSP location is closed")
        if (
          !operations.includes(args.operation) ||
          !Number.isSafeInteger(args.line) ||
          args.line < 0 ||
          !Number.isSafeInteger(args.character) ||
          args.character < 0 ||
          Buffer.byteLength(args.query ?? "") > 4096
        )
          return yield* fail("request", "LSP query or UTF-16 position is invalid")
        if (input.configuration === undefined || input.configuration === false)
          return yield* fail("disabled", "LSP is disabled; configure lsp:true or a language server explicitly")
        const root = yield* input.fs
          .realPath(input.directory)
          .pipe(Effect.mapError(() => error("path", "LSP root is unavailable")))
        if (!path.isAbsolute(args.filePath)) return yield* fail("path", "LSP file paths must be absolute")
        const file = yield* input.fs
          .realPath(args.filePath)
          .pipe(Effect.mapError(() => error("path", "LSP file is unavailable")))
        if (!same(file, args.filePath)) return yield* fail("path", "LSP file path must be canonical")
        const servers = yield* resolve(input.configuration)
        const server = match(servers, file)
        if (!server) return yield* fail("unavailable", "No configured LSP server supports this file extension")
        if (!connections.has(server.name) && connections.size >= 8)
          return yield* fail("budget", "LSP connection limit exceeded; reopen the Location")
        const connection: Connection =
          connections.get(server.name) ??
          ({
            scope: yield* Scope.make(),
            lock: Semaphore.makeUnsafe(1),
            documents: new Map(),
            files: new Map(),
            status: "not_started",
            pushObserved: false,
          } satisfies Connection)
        connections.set(server.name, connection)
        const ready = yield* connection.lock.withPermit(
          Effect.gen(function* () {
            if (closed) return yield* fail("closed", "LSP location is closed")
            if (connection.error) return yield* connection.error
            if (connection.ready) return connection.ready
            const command = yield* Effect.try({
              try: () =>
                which.sync(
                  path.isAbsolute(server.command[0]!) || !server.command[0]!.includes(path.sep)
                    ? server.command[0]!
                    : path.resolve(root, server.command[0]!),
                  { nothrow: true, path: server.env?.PATH ?? server.env?.Path ?? process.env.PATH ?? process.env.Path },
                ),
              catch: () => error("unavailable", "Configured LSP executable is unavailable"),
            })
            if (!command) {
              connection.status = "missing"
              changed()
              connection.error = error("unavailable", `LSP executable is not installed: ${server.command[0]}`)
              return yield* connection.error
            }
            const ready = readiness()
            connection.ready = ready
            connection.status = "starting"
            changed()
            const opened = LSPClient.open({
              process: input.process,
              command: [command, ...server.command.slice(1)],
              env: server.env,
              initialization: server.initialization,
              directory: root,
              rootURI: pathToFileURL(root).href,
              timeout: input.timeout ?? { startup: 15_000, request: 10_000 },
              onDiagnostics: (params) => {
                if (closed || !LSPFraming.record(params) || typeof params.uri !== "string") return
                let target: string
                try {
                  const uri = new URL(params.uri)
                  if (uri.protocol !== "file:" || uri.search || uri.hash) return
                  target = fileURLToPath(uri)
                } catch {
                  return
                }
                // Servers may encode a Windows drive colon or change its case.
                // Match admitted paths without resolving or reading any new target.
                const document = [...connection.documents].find(([file]) => same(file, target))?.[1]
                if (!document?.admitted || !document.open || document.dirty || document.deleted) return
                if (
                  params.version !== undefined &&
                  (!Number.isSafeInteger(params.version) || params.version !== document.version)
                )
                  return
                const decoded = LSPDiagnostics.decode(params.diagnostics)
                if (!decoded) return
                connection.pushObserved = true
                cache(document, {
                  ...decoded,
                  version: document.version,
                  generation: document.generation,
                  source: "push",
                  freshness: params.version === undefined ? "unversioned" : "current",
                })
              },
              onClose: (cause) => {
                connection.error = cause
                connection.status = "error"
                for (const document of connection.documents.values()) {
                  document.admitted = false
                  clear(document)
                }
                changed()
              },
            }).pipe(
              Effect.timeoutOrElse({
                duration: input.timeout?.startup ?? 15_000,
                orElse: () => fail("timeout", "LSP process startup and initialization timed out"),
              }),
              Effect.provideService(Scope.Scope, connection.scope),
              Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(connection.scope, exit))),
              Effect.tapError((cause) =>
                Effect.sync(() => {
                  connection.error = cause
                  connection.status = "error"
                  changed()
                }),
              ),
              Effect.tap((handle) =>
                Effect.sync(() => {
                  connection.handle = handle
                  connection.status = "connected"
                  changed()
                }),
              ),
            )
            // Initialization belongs to the Location scope, while callers may be interrupted independently.
            yield* Effect.forkIn(
              opened.pipe(Effect.onExit((exit) => Effect.sync(() => complete(ready, exit)))),
              lifetime,
            )
            return ready
          }),
        )
        const handle = yield* Effect.suspend(() => {
          if (ready.exit) return ready.exit
          if (ready.registrations >= 32) return fail("budget", "LSP initialization waiter limit exceeded")
          // Native Promise reactions remain registered after caller interruption.
          // Reserve their slots until initialization settles, rather than returning
          // capacity early during a cancellation storm.
          ready.registrations++
          return Effect.promise(() => ready.promise).pipe(Effect.flatMap((exit) => exit))
        })
        if (!connection.files.has(file) && connection.files.size >= 128)
          return yield* fail("budget", "LSP document limit exceeded; reopen the Location")
        const lock = connection.files.get(file) ?? Semaphore.makeUnsafe(1)
        connection.files.set(file, lock)
        let admission: { readonly document: Document; readonly ticket: number } | undefined
        return yield* lock
          .withPermit(
            Effect.gen(function* () {
              const method = methods[args.operation]
              if (
                !diagnostic &&
                handle.capabilities[method[1]] !== true &&
                !LSPFraming.record(handle.capabilities[method[1]])
              )
                return yield* fail("unsupported", `LSP server does not support ${args.operation}`)
              const bytes = yield* BoundedFile.read(input.fs, file, MAX_DOCUMENT_BYTES).pipe(
                Effect.mapError(() =>
                  error("document", "LSP requires a stable regular file within the 2 MiB document limit"),
                ),
              )
              const text = yield* Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                catch: () => error("document", "LSP documents must contain valid UTF-8"),
              })
              const lines = text.split(/\r\n|\r|\n/)
              if (
                !diagnostic &&
                args.operation !== "workspaceSymbol" &&
                args.operation !== "documentSymbol" &&
                (args.line >= lines.length || args.character > lines[args.line]!.length)
              )
                return yield* fail("request", "LSP UTF-16 position is outside the document")
              const uri = pathToFileURL(file).href
              const previous = connection.documents.get(file)
              const hash = createHash("sha256").update(bytes).digest("hex")
              const sync = handle.capabilities.textDocumentSync
              const syncKind = typeof sync === "number" ? sync : LSPFraming.record(sync) ? sync.change : undefined
              const openClose = typeof sync === "number" ? sync > 0 : LSPFraming.record(sync) && sync.openClose === true
              const reopening = !previous?.open || previous.deleted
              const modified = !previous || previous.hash !== hash || previous.dirty || reopening
              if (reopening && !openClose)
                return yield* fail("unsupported", "LSP server does not advertise opening documents with fresh text")
              if (!reopening && modified && syncKind !== 1 && syncKind !== 2)
                return yield* fail("unsupported", "LSP server cannot synchronize a changed document")
              const oldEnd = previous?.end
              const wasDeleted = previous?.deleted
              const document: Document = previous ?? {
                hash,
                end: end(text),
                version: 0,
                generation: 0,
                open: false,
                admitted: false,
                dirty: false,
                deleted: false,
                ticket: 0,
                waiters: new Set(),
              }
              if (modified) {
                document.version++
                document.generation++
                document.admitted = false
                clear(document)
              }
              document.hash = hash
              document.end = end(text)
              document.dirty = false
              document.deleted = false
              if (diagnostic) {
                document.admitted = true
                admission = { document, ticket: ++document.ticket }
              }
              connection.documents.set(file, document)
              if (wasDeleted && document.open) yield* handle.notify("textDocument/didClose", { textDocument: { uri } })
              if (reopening) {
                document.open = true
                yield* handle.notify("textDocument/didOpen", {
                  textDocument: {
                    uri,
                    languageId: language(path.extname(file).slice(1).toLowerCase()),
                    version: document.version,
                    text,
                  },
                })
              }
              if (!reopening && modified) {
                yield* handle.notify("textDocument/didChange", {
                  textDocument: { uri, version: document.version },
                  contentChanges: [
                    syncKind === 1 ? { text } : { range: { start: { line: 0, character: 0 }, end: oldEnd! }, text },
                  ],
                })
              }
              if (modified) changed()
              if (diagnostic) {
                const generation = document.generation
                const version = document.version
                const ticket = document.ticket
                const deadline = Date.now() + (input.timeout?.request ?? 10_000)
                const valid = () =>
                  !closed &&
                  document.admitted &&
                  !document.dirty &&
                  !document.deleted &&
                  document.generation === generation &&
                  document.version === version &&
                  document.ticket === ticket &&
                  !handle.failure()
                return yield* Effect.gen(function* () {
                  const provider = handle.capabilities.diagnosticProvider
                  if (LSPFraming.record(provider)) {
                    const previous =
                      document.report?.source === "pull" &&
                      document.report.generation === generation &&
                      document.report.version === version
                        ? document.report
                        : undefined
                    const report = yield* handle
                      .request("textDocument/diagnostic", {
                        textDocument: { uri },
                        ...(typeof provider.identifier === "string" ? { identifier: provider.identifier } : {}),
                        ...(previous?.resultId ? { previousResultId: previous.resultId } : {}),
                      })
                      .pipe(
                        Effect.catch((cause) =>
                          cause.kind === "timeout" && !handle.failure()
                            ? Effect.sync(() => {
                                clear(document)
                                return undefined
                              })
                            : Effect.fail(cause),
                        ),
                      )
                    if (!valid()) return yield* fail("request", "LSP diagnostics became stale while the request ran")
                    if (report !== undefined) {
                      if (
                        !LSPFraming.record(report) ||
                        (report.resultId !== undefined &&
                          (typeof report.resultId !== "string" || Buffer.byteLength(report.resultId) > 4096))
                      )
                        return yield* fail("protocol", "Invalid LSP document diagnostic report")
                      const decoded =
                        report.kind === "full"
                          ? LSPDiagnostics.decode(report.items)
                          : report.kind === "unchanged" && previous?.resultId && typeof report.resultId === "string"
                            ? previous
                            : undefined
                      if (!decoded)
                        return yield* fail(
                          "protocol",
                          "LSP unchanged diagnostics require the matching previous result ID",
                        )
                      cache(document, {
                        diagnostics: decoded.diagnostics,
                        omitted: decoded.omitted + ("relatedDocuments" in report ? 1 : 0),
                        bytes:
                          decoded.bytes +
                          (typeof report.resultId === "string" ? Buffer.byteLength(report.resultId) : 0),
                        source: "pull",
                        freshness: "current",
                        version,
                        generation,
                        ...(typeof report.resultId === "string" ? { resultId: report.resultId } : {}),
                      })
                    }
                  }
                  if (!document.report && Date.now() < deadline)
                    yield* Effect.callback<void>((resume) => {
                      const finish = () => {
                        if (document.report || !valid()) resume(Effect.void)
                      }
                      document.waiters.add(finish)
                      const timer = setTimeout(() => resume(Effect.void), Math.max(0, deadline - Date.now()))
                      finish()
                      return Effect.sync(() => {
                        clearTimeout(timer)
                        document.waiters.delete(finish)
                      })
                    })
                  if (!valid()) return yield* fail("request", "LSP diagnostic admission is no longer current")
                  const current = yield* BoundedFile.read(input.fs, file, MAX_DOCUMENT_BYTES).pipe(
                    Effect.mapError(() => error("document", "LSP diagnostic source changed or disappeared")),
                  )
                  if (!valid() || createHash("sha256").update(current).digest("hex") !== hash) {
                    document.generation++
                    document.admitted = false
                    clear(document)
                    changed()
                    return yield* fail("document", "LSP diagnostics do not match the current file contents")
                  }
                  const report = document.report
                  return {
                    server: server.name,
                    filePath: file,
                    version,
                    generation,
                    source: report?.source ?? "none",
                    freshness: report?.freshness ?? "pending",
                    diagnostics: report?.diagnostics ?? [],
                    omitted: report?.omitted ?? 0,
                  } satisfies DiagnosticResult
                })
              }
              const params = { textDocument: { uri }, position: { line: args.line, character: args.character } }
              if (args.operation === "incomingCalls" || args.operation === "outgoingCalls") {
                const prepared = yield* handle.request("textDocument/prepareCallHierarchy", params)
                const filtered = yield* sanitize("prepareCallHierarchy", prepared)
                const items = filtered.result === null ? [] : (filtered.result as unknown[])
                const results: unknown[] = []
                let omitted = filtered.omitted + Math.max(0, items.length - 8)
                let bytes = 0
                for (const item of items.slice(0, 8)) {
                  const response = yield* handle.request(method[0], { item })
                  const result = yield* sanitize(args.operation, response)
                  const values = result.result === null ? [] : (result.result as unknown[])
                  bytes += yield* resultBytes(values)
                  if (bytes > MAX_RESULT_BYTES)
                    return yield* fail("budget", "LSP call hierarchy exceeds its aggregate byte limit")
                  omitted += result.omitted + Math.max(0, results.length + values.length - MAX_RESULTS)
                  results.push(...values.slice(0, MAX_RESULTS - results.length))
                }
                return { server: server.name, result: results, omitted }
              }
              const result = yield* handle.request(
                method[0],
                args.operation === "workspaceSymbol"
                  ? { query: args.query ?? "" }
                  : args.operation === "documentSymbol"
                    ? { textDocument: { uri } }
                    : args.operation === "findReferences"
                      ? { ...params, context: { includeDeclaration: true } }
                      : params,
              )
              return { server: server.name, ...(yield* sanitize(args.operation, result)) }
            }),
          )
          .pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.sync(() => {
                    if (!admission || admission.document.ticket !== admission.ticket) return
                    admission.document.ticket++
                    admission.document.admitted = false
                    clear(admission.document)
                    changed()
                  }),
            ),
          )
      })
    const admitted = <A, E>(operation: Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (active >= 16) return fail("budget", "LSP active query limit exceeded")
          active++
          return Effect.void
        }),
        () => operation,
        () =>
          Effect.sync(() => {
            active--
          }),
      )
    const query = (args: Query) => admitted(execute(args)).pipe(Effect.map((result) => result as Result))
    const diagnostics = (args: { readonly filePath: string }) =>
      admitted(execute({ filePath: args.filePath, operation: "hover", line: 0, character: 0 }, true)).pipe(
        Effect.map((result) => result as DiagnosticResult),
      )
    const forget = (args: { readonly filePath: string; readonly kind: "changed" | "deleted" }) =>
      Effect.sync(() => {
        for (const connection of connections.values()) {
          const document = connection.documents.get(args.filePath)
          if (!document) continue
          document.generation++
          document.ticket++
          document.admitted = false
          document.dirty = true
          document.deleted = args.kind === "deleted"
          clear(document)
          changed()
        }
      })
    const didClose = (args: { readonly filePath: string }) =>
      Effect.gen(function* () {
        for (const connection of connections.values()) {
          const document = connection.documents.get(args.filePath)
          if (!document?.open || !connection.handle) continue
          document.open = false
          document.admitted = false
          document.generation++
          document.ticket++
          clear(document)
          yield* connection.handle.notify("textDocument/didClose", {
            textDocument: { uri: pathToFileURL(args.filePath).href },
          })
          changed()
        }
      })
    const status = () =>
      Effect.sync(() => {
        const configured =
          input.configuration === true
            ? Object.entries(builtins)
            : input.configuration && typeof input.configuration === "object"
              ? Object.entries(input.configuration)
              : []
        return configured.slice(0, 32).map(([name, server]): ServerStatus => {
          const connection = connections.get(name)
          return {
            id: name,
            name,
            root: input.directory,
            status: "disabled" in server && server.disabled ? "disabled" : (connection?.status ?? "not_started"),
            ...(connection?.error ? { failure: connection.error.kind } : {}),
            diagnosticMode:
              connection?.handle && LSPFraming.record(connection.handle.capabilities.diagnosticProvider)
                ? "pull"
                : connection?.pushObserved
                  ? "push"
                  : "none",
          }
        })
      })
    const supports = (args: { readonly filePath: string }) =>
      input.configuration === undefined || input.configuration === false
        ? Effect.succeed(false)
        : resolve(input.configuration).pipe(Effect.map((servers) => match(servers, args.filePath) !== undefined))
    return LSPService.of({ supports, query, diagnostics, forget, didClose, status })
  })
}

function resolve(configuration: NonNullable<typeof ConfigLSP.Info.Type>): Effect.Effect<Server[], LSPError.Failure> {
  if (configuration === true)
    return Effect.succeed(Object.entries(builtins).map(([name, config]) => ({ name, ...config })))
  if (configuration === false) return Effect.succeed([] as Server[])
  return Effect.gen(function* () {
    if (Object.keys(configuration).length > 32) return yield* fail("budget", "LSP configured server limit exceeded")
    const servers: Server[] = []
    for (const [name, config] of Object.entries(configuration)) {
      if (config.disabled) continue
      if (
        !("command" in config) ||
        config.command.length === 0 ||
        config.command.some((value) => !value || value.includes("\0"))
      )
        return yield* fail("configuration", `LSP ${name} requires a nonempty command`)
      const extensions = config.extensions ?? builtins[name as keyof typeof builtins]?.extensions
      if (!extensions?.length || extensions.some((value) => !/^\.?[a-zA-Z0-9_-]+$/.test(value)))
        return yield* fail("configuration", `LSP ${name} requires explicit file extensions`)
      const size = yield* Effect.try({
        try: () => Buffer.byteLength(JSON.stringify(config)),
        catch: () => error("configuration", "LSP configuration must be JSON serializable"),
      })
      if (config.command.length > 64 || size > MAX_RESULT_BYTES)
        return yield* fail("budget", "LSP configuration exceeds its size limit")
      servers.push({
        name,
        command: config.command,
        extensions,
        env: config.env,
        initialization: config.initialization,
      })
    }
    return servers
  })
}

function match(servers: readonly Server[], filePath: string) {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  if (!extension) return
  return servers.find((server) =>
    server.extensions.some((value) => value.replace(/^\./, "").toLowerCase() === extension),
  )
}

function sanitize(operation: Operation, result: unknown) {
  return Effect.gen(function* () {
    if ((yield* resultBytes(result)) > MAX_RESULT_BYTES)
      return yield* fail("budget", "LSP result exceeds its 1 MiB result limit")
    if (result === null) return { result: null, omitted: 0 }
    if (operation === "hover") {
      if (!LSPFraming.record(result) || !("contents" in result))
        return yield* fail("protocol", "Invalid LSP hover result")
      return { result, omitted: 0 }
    }
    if (!Array.isArray(result) && operation !== "goToDefinition" && operation !== "goToImplementation")
      return yield* fail("protocol", "Invalid LSP result list")
    const items = Array.isArray(result) ? result : [result]
    const accepted: unknown[] = []
    const omitted = Math.max(0, items.length - MAX_RESULTS)
    const treeBudget = { count: 0 }
    for (const item of items.slice(0, MAX_RESULTS)) {
      if (!LSPFraming.record(item)) return yield* fail("protocol", "Invalid LSP result entry")
      const uri =
        operation === "incomingCalls"
          ? LSPFraming.record(item.from)
            ? item.from.uri
            : undefined
          : operation === "outgoingCalls"
            ? LSPFraming.record(item.to)
              ? item.to.uri
              : undefined
            : "targetUri" in item
              ? item.targetUri
              : "uri" in item
                ? item.uri
                : LSPFraming.record(item.location)
                  ? item.location.uri
                  : undefined
      if (operation === "documentSymbol" && uri === undefined) {
        // DocumentSymbols refer only to the already authorized document. Bound nested trees as well.
        const bounded = documentSymbols(item, treeBudget)
        if (!bounded) return yield* fail("protocol", "Invalid or oversized LSP document symbols")
        accepted.push(bounded)
        continue
      }
      if (!resultEntry(operation, item)) return yield* fail("protocol", "Invalid LSP location or hierarchy entry")
      // Server locations are metadata, including external and virtual URIs.
      // Returning them must never inspect or load the referenced target.
      accepted.push(item)
    }
    return { result: Array.isArray(result) ? accepted : (accepted[0] ?? null), omitted }
  })
}

function documentSymbols(value: Record<string, unknown>, budget: { count: number }, depth = 0): unknown {
  if (
    ++budget.count > MAX_RESULTS ||
    depth > 32 ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.kind) ||
    !range(value.range) ||
    !range(value.selectionRange)
  )
    return
  if (value.children === undefined) return value
  if (!Array.isArray(value.children)) return
  const children = value.children.map((child) =>
    LSPFraming.record(child) ? documentSymbols(child, budget, depth + 1) : undefined,
  )
  return children.some((child) => child === undefined) ? undefined : { ...value, children }
}
function resultBytes(value: unknown) {
  return Effect.try({
    try: () => Buffer.byteLength(JSON.stringify(value)),
    catch: () => error("protocol", "LSP result cannot be represented as bounded JSON"),
  })
}
function readiness(): Readiness {
  let resolve: Readiness["resolve"] | undefined
  const promise = new Promise<Exit.Exit<LSPClient.Handle, LSPError.Failure>>((complete) => {
    resolve = complete
  })
  return { promise, resolve: resolve!, registrations: 0 }
}
function complete(ready: Readiness, exit: Exit.Exit<LSPClient.Handle, LSPError.Failure>) {
  if (ready.exit) return
  ready.exit = exit
  ready.resolve(exit)
}
function resultEntry(operation: Operation, value: Record<string, unknown>) {
  if (operation === "incomingCalls" || operation === "outgoingCalls") {
    const item = operation === "incomingCalls" ? value.from : value.to
    return (
      LSPFraming.record(item) && hierarchy(item) && Array.isArray(value.fromRanges) && value.fromRanges.every(range)
    )
  }
  if (operation === "prepareCallHierarchy") return hierarchy(value)
  if (operation === "workspaceSymbol" || operation === "documentSymbol")
    return (
      typeof value.name === "string" &&
      Number.isInteger(value.kind) &&
      LSPFraming.record(value.location) &&
      validURI(value.location.uri) &&
      ((operation === "workspaceSymbol" && value.location.range === undefined) || range(value.location.range))
    )
  if ("targetUri" in value)
    return validURI(value.targetUri) && range(value.targetRange) && range(value.targetSelectionRange)
  return validURI(value.uri) && range(value.range)
}
function hierarchy(value: Record<string, unknown>) {
  return (
    typeof value.name === "string" &&
    Number.isInteger(value.kind) &&
    validURI(value.uri) &&
    range(value.range) &&
    range(value.selectionRange)
  )
}
function validURI(value: unknown) {
  return typeof value === "string" && URL.canParse(value)
}
function range(value: unknown) {
  if (!LSPFraming.record(value) || !LSPFraming.record(value.start) || !LSPFraming.record(value.end)) return false
  return (
    [value.start.line, value.start.character, value.end.line, value.end.character].every(
      (part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0,
    ) &&
    (Number(value.end.line) > Number(value.start.line) ||
      (value.end.line === value.start.line && Number(value.end.character) >= Number(value.start.character)))
  )
}
function same(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}
function end(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines.at(-1)!.length }
}
function language(extension: string) {
  return (
    (
      {
        ts: "typescript",
        mts: "typescript",
        cts: "typescript",
        tsx: "typescriptreact",
        js: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        jsx: "javascriptreact",
        py: "python",
        pyi: "python",
        rs: "rust",
        go: "go",
        c: "c",
        h: "c",
        cpp: "cpp",
        cc: "cpp",
        cxx: "cpp",
        hpp: "cpp",
      } as Record<string, string>
    )[extension] ?? extension
  )
}
function error(kind: LSPError.Failure["kind"], message: string) {
  return new LSPError.Failure({ kind, message })
}
function fail(kind: LSPError.Failure["kind"], message: string) {
  return Effect.fail(error(kind, message))
}

const layer = Layer.effect(
  LSPService,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const process = yield* Service
    const events = yield* EventV2.Service
    return yield* make({
      directory: location.directory,
      configuration: Config.latest(yield* config.entries(), "lsp"),
      fs,
      process,
      onChange: events
        .publish(
          LspEvent.Updated,
          {},
          { location: { directory: location.directory, workspaceID: location.workspaceID } },
        )
        .pipe(Effect.asVoid),
    })
  }),
)
export const lspNode = makeLocationNode({
  service: LSPService,
  layer,
  deps: [
    Config.node,
    Location.node,
    FSUtil.node,
    node,
    EventV2.node,
    // Process service is global and shared; language-server handles are Location scoped.
  ],
})
export { lspNode as node }
