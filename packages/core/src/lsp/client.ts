export * as LSPClient from "./client"

import { Cause, Effect, Exit, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import type { DataCallback, Message, MessageConnection } from "vscode-jsonrpc/node"
import { ChildProcess } from "effect/unstable/process"
import { Service } from "../process"
import { LSPError } from "./error"
import { LSPFraming } from "./framing"

export const MAX_PENDING = 32
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const MAX_SERVER_REQUESTS = 16

export type Handle = {
  readonly capabilities: Record<string, unknown>
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, LSPError.Failure>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, LSPError.Failure>
  readonly close: Effect.Effect<void>
  readonly failure: () => LSPError.Failure | undefined
}

export function open(input: {
  readonly process: Service["Service"]
  readonly command: readonly string[]
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
  readonly directory: string
  readonly rootURI: string
  readonly timeout: { readonly startup: number; readonly request: number }
  readonly onDiagnostics?: (params: unknown) => void
  readonly onClose?: (error: LSPError.Failure) => void
}): Effect.Effect<Handle, LSPError.Failure, Scope.Scope> {
  return Effect.gen(function* () {
    const {
      AbstractMessageReader,
      AbstractMessageWriter,
      CancellationTokenSource,
      CancellationReceiverStrategy,
      createMessageConnection,
      ResponseError,
      ErrorCodes,
    } = yield* Effect.promise(() => import("vscode-jsonrpc/node"))
    const child = yield* input.process
      .spawn(
        ChildProcess.make(input.command[0]!, input.command.slice(1), {
          cwd: input.directory,
          env: input.env,
          extendEnv: true,
          stdin: { stream: "pipe", endOnDone: false },
          forceKillAfter: 1_000,
        }),
      )
      .pipe(Effect.mapError(() => failure("startup", "Unable to start the configured LSP server")))
    const writeLock = Semaphore.makeUnsafe(1)
    const controller = new AbortController()
    const pending = new Map<number, { cancelled: boolean; settling: boolean }>()
    const incoming = new Set<string | number>()
    let stopped: LSPError.Failure | undefined
    let queued = 0
    let queuedBytes = 0
    let closing: Promise<void> | undefined
    let partialTimer: ReturnType<typeof setTimeout> | undefined
    let rpc: MessageConnection

    class Reader extends AbstractMessageReader {
      callback?: DataCallback
      listen(callback: DataCallback) {
        this.callback = callback
        return {
          dispose: () => {
            this.callback = undefined
          },
        }
      }
      accept(message: Record<string, unknown>) {
        if (stopped) return
        if (typeof message.method === "string") {
          // Diagnostics have a dedicated bounded handler; other notifications never
          // enter the library's asynchronous queue.
          if (message.id === undefined) {
            if (message.method === "textDocument/publishDiagnostics") input.onDiagnostics?.(message.params)
            return
          }
          if (!validID(message.id) || incoming.has(message.id) || incoming.size >= MAX_SERVER_REQUESTS)
            throw new Error("LSP server request limit or identity is invalid")
          incoming.add(message.id)
          this.callback?.(message as Message)
          return
        }
        if (typeof message.id !== "number" || !Number.isSafeInteger(message.id))
          throw new Error("LSP response identity is invalid")
        if ("result" in message === "error" in message) throw new Error("LSP response shape is invalid")
        if (
          "error" in message &&
          (!LSPFraming.record(message.error) ||
            !Number.isSafeInteger(message.error.code) ||
            typeof message.error.message !== "string")
        )
          throw new Error("LSP response error is invalid")
        const entry = pending.get(message.id)
        if (!entry || entry.settling) return
        entry.settling = true
        this.callback?.(message as Message)
      }
      cancel(id: number | string) {
        const entry = typeof id === "number" ? pending.get(id) : undefined
        if (!entry) return
        entry.cancelled = true
        if (entry.settling) return
        entry.settling = true
        // vscode-jsonrpc 8.2.1 retains cancelled promises until a response arrives.
        // Feed a local error for the library-assigned ID to release that exact promise.
        // This does not claim that the server has stopped processing the request.
        this.callback?.({
          jsonrpc: "2.0",
          id,
          error: { code: -32800, message: "Request cancelled locally" },
        } as Message)
      }
    }
    const reader = new Reader()
    const stop = (error: LSPError.Failure) => {
      if (stopped) return
      stopped = error
      input.onClose?.(error)
      if (partialTimer) clearTimeout(partialTimer)
      rpc?.dispose()
      pending.clear()
      incoming.clear()
      // Keep the active sink's error listener attached while the child closes:
      // aborting first removes NodeSink's listener before the pipe emits EPIPE.
      closing ??= Effect.runPromise(child.kill({ forceKillAfter: 1_000 }).pipe(Effect.ignore)).finally(() =>
        controller.abort(),
      )
    }
    class Writer extends AbstractMessageWriter {
      write(message: Message) {
        if (stopped) return Promise.resolve()
        const value = message as unknown as Record<string, unknown>
        const encoded = Effect.runSync(
          Effect.result(
            Effect.try({
              try: () => LSPFraming.frame(message),
              catch: () => failure("budget", "LSP outgoing message is invalid or exceeds its limit"),
            }),
          ),
        )
        if (encoded._tag === "Failure") {
          stop(encoded.failure)
          return Promise.resolve()
        }
        const bytes = encoded.success
        if (queued >= MAX_PENDING || queuedBytes + bytes.length > MAX_QUEUED_BYTES) {
          stop(failure("budget", "LSP write queue exceeds its limit"))
          return Promise.resolve()
        }
        if (typeof value.method === "string" && typeof value.id === "number") {
          if (pending.size >= MAX_PENDING) {
            stop(failure("budget", "LSP request limit exceeded"))
            return Promise.resolve()
          }
          pending.set(value.id, { cancelled: false, settling: false })
        }
        const entry =
          typeof value.method === "string" && typeof value.id === "number" ? pending.get(value.id) : undefined
        if (value.method === undefined && validID(value.id)) incoming.delete(value.id)
        queued++
        queuedBytes += bytes.length
        return Effect.runPromise(
          writeLock
            .withPermit(
              Effect.suspend(() => (entry?.cancelled ? Effect.void : Stream.run(Stream.make(bytes), child.stdin))),
            )
            .pipe(
              Effect.timeoutOrElse({
                duration: input.timeout.request,
                orElse: () => Effect.fail(failure("timeout", "LSP write timed out")),
              }),
            ),
          { signal: controller.signal },
        )
          .then(() => undefined)
          .catch((cause: unknown) => {
            // The library's async Promise executor rethrows rejected writes after
            // rejecting the request. Dispose rejects its pending map without an
            // unhandled executor rejection; request/notify expose the typed stop.
            stop(cause instanceof LSPError.Failure ? cause : failure("closed", "LSP input stream closed"))
          })
          .finally(() => {
            queued--
            queuedBytes -= bytes.length
          })
      }
      end() {
        stop(failure("closed", "LSP connection closed"))
      }
    }
    const writer = new Writer()
    rpc = createMessageConnection(reader, writer, undefined, {
      cancellationStrategy: {
        receiver: CancellationReceiverStrategy.Message,
        sender: {
          sendCancellation(connection, id) {
            reader.cancel(id)
            // Local completion never waits for a congested or closed stdin.
            void connection.sendNotification("$/cancelRequest", { id }).catch(() => undefined)
            return Promise.resolve()
          },
          cleanup(id) {
            if (typeof id === "number") pending.delete(id)
          },
        },
      },
    })
    rpc.onRequest("workspace/configuration", (params: unknown) => {
      if (!LSPFraming.record(params) || !Array.isArray(params.items) || params.items.length > 32)
        return new ResponseError(ErrorCodes.InvalidParams, "Invalid workspace configuration request")
      return params.items.map((item: unknown) => {
        const section = LSPFraming.record(item) ? item.section : undefined
        return typeof section !== "string"
          ? (input.initialization ?? null)
          : (section
              .split(".")
              .reduce<unknown>(
                (value, key) => (LSPFraming.record(value) ? value[key] : undefined),
                input.initialization,
              ) ?? null)
      })
    })
    rpc.onRequest("workspace/workspaceFolders", () => [{ uri: input.rootURI, name: input.directory }])
    rpc.onRequest(
      () => new ResponseError(ErrorCodes.MethodNotFound, "LSP server requests cannot edit files or execute commands"),
    )
    rpc.listen()
    yield* Effect.addFinalizer(() => Effect.sync(() => stop(failure("closed", "LSP location closed"))))
    const parse = LSPFraming.parser((message) => reader.accept(message))
    yield* Stream.runForEach(child.stdout, (chunk) =>
      Effect.try({
        try: () => {
          parse(chunk)
          if (!parse.incomplete()) {
            if (partialTimer) clearTimeout(partialTimer)
            partialTimer = undefined
          }
          if (parse.incomplete() && partialTimer === undefined)
            partialTimer = setTimeout(
              () => stop(failure("protocol", "LSP partial frame deadline exceeded")),
              input.timeout.request,
            )
        },
        catch: () => failure("protocol", "LSP server sent invalid or oversized framing"),
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          stop(
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? failure("protocol", "LSP server output failed or contained invalid framing")
              : failure("closed", "LSP server output closed"),
          ),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped)
    const request = (method: string, params: unknown, timeout = input.timeout.request) =>
      Effect.suspend(() => {
        if (stopped) return Effect.fail(stopped)
        if (pending.size >= MAX_PENDING) return Effect.fail(failure("budget", "LSP request limit exceeded"))
        const size = Effect.runSync(
          Effect.result(
            Effect.try({
              try: () => LSPFraming.frame({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method, params }).length,
              catch: () => failure("budget", "LSP request is invalid or exceeds its byte limit"),
            }),
          ),
        )
        if (size._tag === "Failure") return Effect.fail(size.failure)
        if (queued >= MAX_PENDING || queuedBytes + size.success > MAX_QUEUED_BYTES)
          return Effect.fail(failure("budget", "LSP write queue exceeds its limit"))
        const token = new CancellationTokenSource()
        return Effect.tryPromise({
          try: (signal) => {
            const abort = () => token.cancel()
            signal.addEventListener("abort", abort, { once: true })
            return rpc
              .sendRequest<unknown>(method, params, token.token)
              .finally(() => signal.removeEventListener("abort", abort))
          },
          catch: (cause) =>
            stopped ?? (cause instanceof LSPError.Failure ? cause : failure("request", `LSP ${method} request failed`)),
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(failure("timeout", `LSP ${method} timed out`)),
          }),
          Effect.tapError(() => (closing ? Effect.promise(() => closing!) : Effect.void)),
          Effect.ensuring(Effect.sync(() => token.dispose())),
        )
      })
    const notify = (method: string, params: unknown) =>
      Effect.tryPromise({
        try: () => (stopped ? Promise.reject(stopped) : rpc.sendNotification(method, params)),
        catch: () => stopped ?? failure("closed", "LSP notification failed"),
      }).pipe(
        Effect.andThen(Effect.suspend(() => (stopped ? Effect.fail(stopped) : Effect.void))),
        Effect.timeoutOrElse({
          duration: input.timeout.request,
          orElse: () => Effect.fail(failure("timeout", "LSP notification timed out")),
        }),
      )
    const initialized = yield* request(
      "initialize",
      {
        processId: process.pid,
        rootUri: input.rootURI,
        workspaceFolders: [{ uri: input.rootURI, name: input.directory }],
        initializationOptions: input.initialization,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            callHierarchy: { dynamicRegistration: false },
            publishDiagnostics: {
              versionSupport: true,
              relatedInformation: false,
              codeDescriptionSupport: false,
              dataSupport: false,
              tagSupport: { valueSet: [1, 2] },
            },
            diagnostic: {
              dynamicRegistration: false,
              relatedDocumentSupport: false,
              relatedInformation: false,
              codeDescriptionSupport: false,
              dataSupport: false,
              tagSupport: { valueSet: [1, 2] },
            },
          },
        },
      },
      input.timeout.startup,
    )
    if (!LSPFraming.record(initialized) || !LSPFraming.record(initialized.capabilities))
      return yield* failure("protocol", "LSP initialize response has no capabilities")
    if (
      initialized.capabilities.positionEncoding !== undefined &&
      initialized.capabilities.positionEncoding !== "utf-16"
    )
      return yield* failure("unsupported", "LSP server did not negotiate UTF-16 positions")
    yield* notify("initialized", {})
    return {
      capabilities: initialized.capabilities,
      failure: () => stopped,
      request,
      notify,
      close: request("shutdown", null, Math.min(input.timeout.request, 500)).pipe(
        Effect.ignore,
        Effect.andThen(notify("exit", undefined).pipe(Effect.ignore)),
        Effect.andThen(
          child.exitCode.pipe(Effect.ignore, Effect.timeoutOrElse({ duration: 250, orElse: () => Effect.void })),
        ),
        Effect.timeoutOrElse({ duration: 750, orElse: () => Effect.void }),
        Effect.ensuring(
          Effect.gen(function* () {
            stop(failure("closed", "LSP connection closed"))
            if (closing) yield* Effect.promise(() => closing!)
          }),
        ),
      ),
    }
  })
}

function validID(value: unknown): value is string | number {
  return typeof value === "string"
    ? value.length > 0 && value.length <= 128
    : typeof value === "number" && Number.isSafeInteger(value)
}

function failure(kind: LSPError.Failure["kind"], message: string) {
  return new LSPError.Failure({ kind, message })
}
