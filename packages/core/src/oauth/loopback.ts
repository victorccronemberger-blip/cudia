export * as OAuthLoopback from "./loopback"

import { Context, Deferred, Effect, Exit, Layer, Schema, Scope, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { Server } from "node:http"

const SUCCESS = "Authorization received. Return to CUDIA to check status."
const CALLBACK_CLOSED = "OAuth callback listener closed"
const CALLBACK_UNAVAILABLE = "OAuth callback listener is unavailable"
const CALLBACK_INVALID = "Invalid loopback callback request"

export class Failure extends Schema.TaggedErrorClass<Failure>()("OAuthLoopback.Failure", {
  message: Schema.String,
}) {}

type Lease = {
  readonly state: string
  readonly authority: string
  readonly path: string
  readonly deferred: Deferred.Deferred<URL, Failure>
}

type Listener = {
  readonly server: Server
  readonly bindHost: string
  readonly port: number
  readonly leases: Map<string, Lease>
  closing: boolean
  close?: Promise<void>
}

export interface Interface {
  readonly listen: (input: {
    readonly redirectURL: string
    readonly state: string
  }) => Effect.Effect<{ readonly url: string; readonly receive: Effect.Effect<URL, Failure> }, Failure, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/OAuthLoopback") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const lock = Semaphore.makeUnsafe(1)
    const listeners = new Map<string, Listener>()
    const listenerByServer = new Map<Server, Listener>()
    const states = new Map<string, { readonly listener: Listener; readonly lease: Lease }>()
    let disposed = false

    const closeListener = (listener: Listener, failure = new Failure({ message: CALLBACK_CLOSED })) => {
      if (listener.close) return listener.close
      listener.closing = true
      const key = `${listener.bindHost}:${listener.port}`
      if (listeners.get(key) === listener) listeners.delete(key)
      listenerByServer.delete(listener.server)
      for (const [state, lease] of listener.leases) {
        states.delete(state)
        Deferred.doneUnsafe(lease.deferred, Exit.fail(failure))
      }
      listener.leases.clear()
      listener.close = new Promise<void>((resolve) => {
        if (!listener.server.listening) {
          resolve()
          return
        }
        listener.server.close(() => resolve())
        listener.server.closeAllConnections()
      })
      return listener.close
    }

    const closeIfEmpty = (listener: Listener) => {
      if (listener.leases.size === 0) void closeListener(listener)
    }

    const onRequest = (
      server: Server,
      request: import("node:http").IncomingMessage,
      response: import("node:http").ServerResponse,
    ) => {
      const listener = listenerByServer.get(server)
      if (!listener || listener.closing || request.method !== "GET" || typeof request.headers.host !== "string") {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        response.end(CALLBACK_INVALID)
        return
      }

      let url: URL | undefined
      try {
        url = new URL(request.url ?? "/", `http://${request.headers.host}`)
      } catch {
        url = undefined
      }
      if (!url || url.host.toLowerCase() !== request.headers.host.toLowerCase()) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        response.end(CALLBACK_INVALID)
        return
      }

      const values = url.searchParams.getAll("state")
      const state = values.length === 1 ? values[0] : undefined
      const lease = state ? listener.leases.get(state) : undefined
      if (!lease || lease.authority !== url.host.toLowerCase() || lease.path !== url.pathname) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        response.end(CALLBACK_INVALID)
        return
      }

      listener.leases.delete(lease.state)
      states.delete(lease.state)
      Deferred.doneUnsafe(lease.deferred, Exit.succeed(url))
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      response.end(SUCCESS, () => closeIfEmpty(listener))
    }

    const openListener = (bindHost: string, port: number) =>
      Effect.tryPromise({
        try: async (signal) => {
          const { createServer } = await import("node:http")
          if (signal.aborted) throw new Error(CALLBACK_CLOSED)
          const server = createServer((request, response) => onRequest(server, request, response))
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              signal.removeEventListener("abort", onAbort)
              server.removeListener("error", onError)
              server.removeListener("listening", onListening)
            }
            const onListening = () => {
              cleanup()
              resolve()
            }
            const onError = (cause: Error) => {
              cleanup()
              reject(cause)
            }
            const onAbort = () => {
              cleanup()
              server.close(() => {})
              server.closeAllConnections()
              reject(signal.reason)
            }
            server.once("error", onError)
            server.once("listening", onListening)
            signal.addEventListener("abort", onAbort, { once: true })
            server.listen({ host: bindHost, port, exclusive: true })
          })

          if (signal.aborted) {
            server.close(() => {})
            server.closeAllConnections()
            throw new Error(CALLBACK_CLOSED)
          }

          const address = server.address()
          if (!address || typeof address === "string") {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            throw new Error(CALLBACK_UNAVAILABLE)
          }

          const listener: Listener = {
            server,
            bindHost,
            port: address.port,
            leases: new Map(),
            closing: false,
          }
          listenerByServer.set(server, listener)
          server.on("error", () => {
            void closeListener(listener, new Failure({ message: CALLBACK_UNAVAILABLE }))
          })
          listeners.set(`${bindHost}:${address.port}`, listener)
          return listener
        },
        catch: () => new Failure({ message: CALLBACK_UNAVAILABLE }),
      })

    const release = (listener: Listener, state: string) => {
      const lease = listener.leases.get(state)
      if (!lease) return Promise.resolve()
      listener.leases.delete(state)
      states.delete(state)
      Deferred.doneUnsafe(lease.deferred, Exit.fail(new Failure({ message: CALLBACK_CLOSED })))
      closeIfEmpty(listener)
      return listener.close ?? Promise.resolve()
    }

    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        disposed = true
        yield* Effect.forEach(
          Array.from(listeners.values()),
          (listener) => Effect.promise(() => closeListener(listener)),
          {
            discard: true,
          },
        )
      }),
    )

    return Service.of({
      listen: (input) =>
        Effect.gen(function* () {
          const url = parseRedirectURL(input.redirectURL)
          if (!url || input.state.length === 0)
            return yield* new Failure({ message: "Invalid loopback callback lease" })
          if (disposed) return yield* new Failure({ message: CALLBACK_CLOSED })

          const bindHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "127.0.0.1" : "::1"
          const requestedPort = url.port === "" ? 80 : Number(url.port)
          const leaseData = yield* lock.withPermit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (disposed) return yield* new Failure({ message: CALLBACK_CLOSED })
                if (states.has(input.state))
                  return yield* new Failure({ message: "OAuth callback state is already in use" })
                const existing = requestedPort === 0 ? undefined : listeners.get(`${bindHost}:${requestedPort}`)
                const listener = existing && !existing.closing ? existing : yield* openListener(bindHost, requestedPort)
                const callbackURL = new URL(url)
                callbackURL.port = String(listener.port)
                const lease: Lease = {
                  state: input.state,
                  authority: callbackURL.host.toLowerCase(),
                  path: callbackURL.pathname,
                  deferred: Deferred.makeUnsafe<URL, Failure>(),
                }
                listener.leases.set(lease.state, lease)
                states.set(lease.state, { listener, lease })
                yield* Effect.addFinalizer(() => Effect.promise(() => release(listener, lease.state)))
                return { listener, lease, callbackURL }
              }),
            ),
          )

          return { url: leaseData.callbackURL.toString(), receive: Deferred.await(leaseData.lease.deferred) }
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function parseRedirectURL(value: string) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/") ||
      !(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    )
      return undefined
    return url
  } catch {
    return undefined
  }
}
