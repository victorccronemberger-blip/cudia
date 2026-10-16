import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { Effect, Scope } from "effect"

const integrationID = Integration.ID.make("integration-refresh-process-fixture")
const methodID = Integration.MethodID.make("oauth")
const childScript = fileURLToPath(new URL("./fixture/integration-refresh-child.ts", import.meta.url))

it("preserves refresh intent across process death and requires explicit credential replacement", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-integration-refresh-recovery-"))
  const databasePath = path.join(tempRoot, "refresh.sqlite")
  let requestCount = 0
  let receivedRefresh: string | undefined
  let receiveRequest: (() => void) | undefined
  let releaseResponse: (() => void) | undefined
  const requestReceived = new Promise<void>((resolve) => (receiveRequest = resolve))
  let blockResponse = true
  const responseReleased = new Promise<void>((resolve) => (releaseResponse = resolve))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/refresh") return new Response(null, { status: 404 })
      const input = (await request.json()) as { refresh?: string }
      requestCount++
      receivedRefresh = input.refresh
      receiveRequest?.()
      if (blockResponse) await responseReleased
      return Response.json({ access_token: "rotated-access-fixture-secret" })
    },
  })
  const refreshURL = `http://127.0.0.1:${server.port}/refresh`
  const children: Array<ReturnType<typeof Bun.spawn>> = []

  try {
    const saved = await run(databasePath, (credentials) =>
      Effect.gen(function* () {
        return yield* credentials.create({
          integrationID,
          label: "Refresh fixture",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "old-access-fixture-secret",
            refresh: "old-refresh-fixture-secret",
            issued: 1,
            expires: 2,
          }),
        })
      }),
    )

    const first = startChild(databasePath, saved.id, refreshURL)
    children.push(first.child)
    await withDeadline(requestReceived, "first refresh request did not reach the fixture")
    expect(requestCount).toBe(1)
    expect(receivedRefresh).toBe("old-refresh-fixture-secret")

    const concurrent = startChild(databasePath, saved.id, refreshURL)
    children.push(concurrent.child)
    expect(await finishChild(concurrent)).toEqual({ status: "authorization_required" })
    expect(requestCount).toBe(1)

    first.child.kill("SIGKILL")
    await first.child.exited
    expect(await first.output).toBe("")
    await run(databasePath, (credentials, integrations) =>
      Effect.gen(function* () {
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "Fixture" },
            authorize: () => Effect.die("unexpected authorization"),
          }),
        )
        expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
        const publicCredential = yield* credentials.get(saved.id)
        expect(publicCredential).not.toHaveProperty("refresh_attempt")
        expect(JSON.stringify(yield* integrations.get(integrationID))).not.toContain("old-refresh-fixture-secret")
        expect(JSON.stringify(yield* integrations.get(integrationID))).not.toContain("nonce")
      }),
    )

    await run(databasePath, (credentials) =>
      Effect.gen(function* () {
        yield* credentials.update(saved.id, {
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "manually-extended-access",
            refresh: "old-refresh-fixture-secret",
            issued: Date.now(),
            expires: Date.now() + 60 * 60 * 1000,
          }),
        })
        expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
      }),
    )
    const stillPending = startChild(databasePath, saved.id, refreshURL)
    children.push(stillPending.child)
    expect(await finishChild(stillPending)).toEqual({ status: "authorization_required" })
    expect(requestCount).toBe(1)

    const replacement = await run(databasePath, (credentials) =>
      Effect.gen(function* () {
        return yield* credentials.create({
          integrationID,
          label: "Reauthorized",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "new-access-fixture-secret",
            refresh: "new-refresh-fixture-secret",
            issued: 1,
            expires: 2,
          }),
        })
      }),
    )
    blockResponse = false
    releaseResponse?.()
    const refreshed = startChild(databasePath, replacement.id, refreshURL)
    children.push(refreshed.child)
    expect(await finishChild(refreshed)).toEqual({ status: "success" })
    expect(requestCount).toBe(2)
    expect(receivedRefresh).toBe("new-refresh-fixture-secret")

    await run(databasePath, (credentials) =>
      Effect.gen(function* () {
        expect(yield* credentials.refresh.pending(replacement.id)).toBe(false)
        const persisted = yield* credentials.get(replacement.id)
        expect(persisted?.value).toMatchObject({
          type: "oauth",
          access: "rotated-access-fixture-secret",
          refresh: "rotated-refresh-fixture-secret",
        })
      }),
    )
    const reused = startChild(databasePath, replacement.id, refreshURL)
    children.push(reused.child)
    expect(await finishChild(reused)).toEqual({ status: "success" })
    expect(requestCount).toBe(2)
  } finally {
    blockResponse = false
    releaseResponse?.()
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
    server.stop(true)
    const root = path.resolve(tempRoot)
    const temp = path.resolve(os.tmpdir())
    const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
    if (!root.toLowerCase().startsWith(prefix.toLowerCase()))
      throw new Error("Refusing to remove a refresh fixture path outside the temporary directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

it("keeps refresh intent after a successful provider response cannot be committed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-integration-refresh-commit-failure-"))
  const databasePath = path.join(tempRoot, "refresh.sqlite")
  let requestCount = 0
  let receiveRequest: (() => void) | undefined
  const requestReceived = new Promise<void>((resolve) => (receiveRequest = resolve))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/refresh") return new Response(null, { status: 404 })
      await request.json()
      requestCount++
      receiveRequest?.()
      return Response.json({ access_token: "rotated-access-fixture-secret" })
    },
  })
  const refreshURL = `http://127.0.0.1:${server.port}/refresh`
  const children: Array<ReturnType<typeof Bun.spawn>> = []

  try {
    const saved = await run(databasePath, (credentials, _integrations, database) =>
      Effect.gen(function* () {
        const credential = yield* credentials.create({
          integrationID,
          label: "Commit failure fixture",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "old-access-fixture-secret",
            refresh: "old-refresh-fixture-secret",
            issued: 1,
            expires: 2,
          }),
        })
        yield* database.db.run(
          `CREATE TRIGGER integration_refresh_completion_failure BEFORE UPDATE ON credential
           WHEN NEW.value != OLD.value BEGIN SELECT RAISE(ABORT, 'fixture refresh commit failure'); END`,
        )
        return credential
      }),
    )

    const first = startChild(databasePath, saved.id, refreshURL)
    children.push(first.child)
    await withDeadline(requestReceived, "refresh request did not reach the immediate fixture")
    expect(requestCount).toBe(1)
    expect(await finishChild(first, 1)).toEqual({ status: "unexpected_failure" })
    expect(requestCount).toBe(1)

    await run(databasePath, (credentials) =>
      Effect.gen(function* () {
        expect(yield* credentials.refresh.pending(saved.id)).toBe(true)
        expect((yield* credentials.get(saved.id))?.value).toEqual(saved.value)
      }),
    )
    const retry = startChild(databasePath, saved.id, refreshURL)
    children.push(retry.child)
    expect(await finishChild(retry)).toEqual({ status: "authorization_required" })
    expect(requestCount).toBe(1)
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
    server.stop(true)
    const root = path.resolve(tempRoot)
    const temp = path.resolve(os.tmpdir())
    const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
    if (!root.toLowerCase().startsWith(prefix.toLowerCase()))
      throw new Error("Refusing to remove a refresh fixture path outside the temporary directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)

function runtime(databasePath: string) {
  return AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node]), [
    [Database.node, Database.layerFromPath(databasePath)],
  ])
}

function run<A, E>(
  databasePath: string,
  program: (
    credentials: Credential.Interface,
    integrations: Integration.Interface,
    database: Database.Interface,
  ) => Effect.Effect<A, E, Credential.Service | Integration.Service | EventV2.Service | Database.Service | Scope.Scope>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          const database = yield* Database.Service
          return yield* program(credentials, integrations, database)
        }),
        runtime(databasePath),
      ),
    ),
  )
}

function startChild(databasePath: string, credentialID: Credential.ID, refreshURL: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, childScript, databasePath, credentialID, refreshURL],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  return { child, output: new Response(child.stdout).text() }
}

async function finishChild(
  child: ReturnType<typeof startChild>,
  expectedExitCode = 0,
): Promise<{ readonly status: string }> {
  await withDeadline(
    child.child.exited.then(() => undefined),
    "refresh child did not exit",
  )
  expect(child.child.exitCode).toBe(expectedExitCode)
  return JSON.parse(await child.output) as { readonly status: string }
}

function withDeadline<A>(promise: Promise<A>, message: string, timeout = 15_000) {
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
