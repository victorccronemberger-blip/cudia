import { createServer, request, type Server } from "node:http"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OAuthLoopback } from "@opencode-ai/core/oauth/loopback"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(OAuthLoopback.node))

describe("OAuthLoopback", () => {
  it.effect("accepts only credential-free loopback redirect URLs", () =>
    Effect.gen(function* () {
      const service = yield* OAuthLoopback.Service
      for (const redirectURL of [
        "https://127.0.0.1/callback",
        "http://example.com/callback",
        "http://user:password@127.0.0.1/callback",
        "http://127.0.0.1/callback?state=leak",
        "http://127.0.0.1/callback#fragment",
      ]) {
        const result = yield* Effect.exit(service.listen({ redirectURL, state: "state" }))
        expect(Exit.isFailure(result)).toBe(true)
      }
    }),
  )

  it.effect("shares an owned port across leases and consumes each state once", () =>
    Effect.gen(function* () {
      const service = yield* OAuthLoopback.Service
      const firstScope = yield* Scope.fork(yield* Scope.Scope)
      const secondScope = yield* Scope.fork(yield* Scope.Scope)
      const thirdScope = yield* Scope.fork(yield* Scope.Scope)
      const first = yield* service
        .listen({ redirectURL: "http://127.0.0.1:0/callback", state: "state-one" })
        .pipe(Scope.provide(firstScope))
      const firstURL = new URL(first.url)
      const second = yield* service
        .listen({ redirectURL: `http://127.0.0.1:${firstURL.port}/callback`, state: "state-two" })
        .pipe(Scope.provide(secondScope))
      const third = yield* service
        .listen({ redirectURL: `http://127.0.0.1:${firstURL.port}/callback`, state: "state-three" })
        .pipe(Scope.provide(thirdScope))

      expect(new URL(second.url).port).toBe(firstURL.port)

      yield* Scope.close(firstScope, Exit.void)
      const closedLease = yield* Effect.promise(() => fetch(`${first.url}?state=state-one`))
      expect(closedLease.status).toBe(400)

      const callback = yield* Effect.promise(() => fetch(`${second.url}?state=state-two`))
      expect(callback.status).toBe(200)
      expect(yield* Effect.promise(() => callback.text())).toBe(
        "Authorization received. Return to CUDIA to check status.",
      )
      expect(yield* second.receive).toMatchObject({ pathname: "/callback", search: "?state=state-two" })

      const repeated = yield* Effect.promise(() => fetch(`${second.url}?state=state-two`))
      expect(repeated.status).toBe(400)
      expect(yield* Effect.promise(() => repeated.text())).not.toContain("state-two")
      const thirdCallback = yield* Effect.promise(() => fetch(`${third.url}?state=state-three`))
      expect(thirdCallback.status).toBe(200)
      expect(yield* third.receive).toMatchObject({ pathname: "/callback" })
      yield* Scope.close(secondScope, Exit.void)
      yield* Scope.close(thirdScope, Exit.void)
    }),
  )

  it.effect("rejects mismatched callback requests without consuming the lease", () =>
    Effect.gen(function* () {
      const service = yield* OAuthLoopback.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const lease = yield* service
        .listen({ redirectURL: "http://127.0.0.1:0/callback", state: "expected" })
        .pipe(Scope.provide(scope))
      const invalidURLs = [
        `${lease.url}/wrong?state=expected`,
        `${lease.url}?state=wrong`,
        `${lease.url}?state=expected&state=expected`,
      ]

      for (const url of invalidURLs) {
        const response = yield* Effect.promise(() => fetch(url))
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
        expect(yield* Effect.promise(() => response.text())).not.toContain("expected")
      }

      expect(yield* Effect.promise(() => requestStatus(lease.url, "POST", "state=expected"))).toBeGreaterThanOrEqual(
        400,
      )
      expect(
        yield* Effect.promise(() => requestStatus(lease.url, "GET", "state=expected", "127.0.0.1:1")),
      ).toBeGreaterThanOrEqual(400)
      const callback = yield* Effect.promise(() => fetch(`${lease.url}?state=expected`))
      expect(callback.status).toBe(200)
      expect(yield* lease.receive).toMatchObject({ pathname: "/callback" })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("fails closed when another process owns the requested port", () =>
    Effect.gen(function* () {
      const service = yield* OAuthLoopback.Service
      const occupied = createServer((_request, response) => response.end("still-owned"))
      const port = yield* Effect.acquireRelease(
        Effect.promise(() => listen(occupied)),
        () => Effect.promise(() => close(occupied)),
      )
      const result = yield* Effect.exit(
        service.listen({ redirectURL: `http://127.0.0.1:${port}/callback`, state: "occupied" }),
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.toString()).toContain("OAuth callback listener is unavailable")
      }
      const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`))
      expect(yield* Effect.promise(() => response.text())).toBe("still-owned")
    }),
  )

  it.effect("fails a pending receive on lease close and allows the port to be rebound", () =>
    Effect.gen(function* () {
      const service = yield* OAuthLoopback.Service
      const firstScope = yield* Scope.fork(yield* Scope.Scope)
      const first = yield* service
        .listen({ redirectURL: "http://127.0.0.1:0/callback", state: "first" })
        .pipe(Scope.provide(firstScope))
      const receiveFiber = yield* Effect.exit(first.receive).pipe(Effect.forkScoped)

      yield* Scope.close(firstScope, Exit.void)
      const receiveExit = yield* Fiber.join(receiveFiber)
      expect(Exit.isFailure(receiveExit)).toBe(true)

      const secondScope = yield* Scope.fork(yield* Scope.Scope)
      const second = yield* service.listen({ redirectURL: first.url, state: "second" }).pipe(Scope.provide(secondScope))
      const callback = yield* Effect.promise(() => fetch(`${second.url}?state=second`))
      expect(callback.status).toBe(200)
      expect(yield* second.receive).toMatchObject({ pathname: "/callback" })
      yield* Scope.close(secondScope, Exit.void)
    }),
  )
})

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Server did not bind to a TCP port"))
      resolve(address.port)
    })
  })
}

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

function requestStatus(url: string, method: string, path: string, host?: string) {
  return new Promise<number>((resolve, reject) => {
    const target = new URL(url)
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: method === "GET" ? `${target.pathname}?${path}` : target.pathname,
        method,
        headers: host ? { host } : undefined,
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      },
    )
    req.on("error", reject)
    if (method !== "GET") req.end(path)
    else req.end()
  })
}
