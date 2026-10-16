import { mkdtemp, rm } from "node:fs/promises"
import { afterEach, expect, test } from "bun:test"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { GitLabWorkflowClient, GitLabWorkflowLanguageModel, type WorkflowClientEvent } from "gitlab-ai-provider"

const roots: string[] = []
const originalClientMethods = new Map<string, PropertyDescriptor | undefined>()

afterEach(async () => {
  for (const [name, descriptor] of originalClientMethods) {
    if (descriptor) Object.defineProperty(GitLabWorkflowClient.prototype, name, descriptor)
    else Reflect.deleteProperty(GitLabWorkflowClient.prototype, name)
  }
  originalClientMethods.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function modelForTest(Constructor = GitLabWorkflowLanguageModel) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-gitlab-workflow-test-"))
  roots.push(directory)
  const model = new Constructor(
    "duo-workflow-sonnet-4-6",
    {
      provider: "gitlab.workflow",
      instanceUrl: "https://gitlab.invalid",
      getHeaders: () => ({}),
      fetch: Object.assign(
        async () => {
          throw new Error("Unexpected network request in workflow test")
        },
        { preconnect: () => {} },
      ),
    },
    { workingDirectory: directory, projectId: "group/project" },
  )
  const tokenClient = Reflect.get(model, "tokenClient") as {
    getToken: (...args: unknown[]) => Promise<unknown>
    createWorkflow: (...args: unknown[]) => Promise<string>
  }
  Reflect.set(tokenClient, "getToken", async () => ({ token: "local-test-token" }))
  Reflect.set(tokenClient, "createWorkflow", async () => "workflow-test-id")
  Reflect.set(model, "resolveModelRef", async () => "test-model-ref")
  Reflect.set(model, "buildWorkflowMetadata", async () => ({}))
  return model
}

function options(abortSignal?: AbortSignal) {
  return {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "continue the workflow" }] }],
    abortSignal,
  }
}

function patchClient(name: string, value: unknown) {
  if (!originalClientMethods.has(name)) {
    originalClientMethods.set(name, Object.getOwnPropertyDescriptor(GitLabWorkflowClient.prototype, name))
  }
  Reflect.set(GitLabWorkflowClient.prototype, name, value)
}

test("an already-aborted stream resolves no model or token and creates no workflow", async () => {
  const model = await modelForTest()
  const calls = { model: 0, token: 0, create: 0 }
  Reflect.set(model, "resolveModelRef", async () => {
    calls.model++
    return "test-model-ref"
  })
  const tokenClient = Reflect.get(model, "tokenClient") as {
    getToken: () => Promise<unknown>
    createWorkflow: () => Promise<string>
  }
  Reflect.set(tokenClient, "getToken", async () => {
    calls.token++
  })
  Reflect.set(tokenClient, "createWorkflow", async () => {
    calls.create++
    return "workflow-test-id"
  })
  const controller = new AbortController()
  controller.abort(new Error("test abort"))

  await expect(model.doStream(options(controller.signal))).rejects.toThrow("test abort")
  expect(calls).toEqual({ model: 0, token: 0, create: 0 })
})

test("aborting during model, token, or project resolution prevents workflow creation", async () => {
  for (const stage of ["resolveModelRef", "getToken", "resolveProjectId"] as const) {
    const model = await modelForTest()
    const entered = deferred()
    const release = deferred()
    const calls = { create: 0 }
    if (stage === "resolveModelRef") {
      Reflect.set(model, stage, async () => {
        entered.resolve()
        await release.promise
        return "test-model-ref"
      })
    }
    if (stage === "getToken") {
      const tokenClient = Reflect.get(model, "tokenClient") as { getToken: (...args: unknown[]) => Promise<unknown> }
      Reflect.set(tokenClient, stage, async () => {
        entered.resolve()
        await release.promise
      })
    }
    if (stage === "resolveProjectId") {
      Reflect.set(model, stage, async () => {
        entered.resolve()
        await release.promise
        return "group/project"
      })
    }
    const tokenClient = Reflect.get(model, "tokenClient") as { createWorkflow: (...args: unknown[]) => Promise<string> }
    Reflect.set(tokenClient, "createWorkflow", async () => {
      calls.create++
      return "workflow-test-id"
    })
    const controller = new AbortController()
    const pending = model.doStream(options(controller.signal))
    await entered.promise
    controller.abort(new Error("test abort"))
    release.resolve()

    await expect(pending).rejects.toThrow("test abort")
    expect(calls.create).toBe(0)
  }
})

test("aborting while createWorkflow is in flight does not connect afterward", async () => {
  const model = await modelForTest()
  const entered = deferred()
  const release = deferred<string>()
  let creates = 0
  let connects = 0
  const tokenClient = Reflect.get(model, "tokenClient") as { createWorkflow: (...args: unknown[]) => Promise<string> }
  Reflect.set(tokenClient, "createWorkflow", async () => {
    creates++
    entered.resolve()
    return release.promise
  })
  patchClient("connect", async () => {
    connects++
  })
  const controller = new AbortController()
  const pending = model.doStream(options(controller.signal))
  await entered.promise
  controller.abort(new Error("test abort"))
  release.resolve("workflow-created-before-abort")

  await expect(pending).rejects.toThrow("test abort")
  expect(creates).toBe(1)
  expect(connects).toBe(0)
  expect(Reflect.get(model, "currentWorkflowId")).toBeNull()
})

test("aborting during WebSocket connect or workflow metadata rejects the stream and sends no start request", async () => {
  for (const stage of ["connect", "metadata"] as const) {
    const model = await modelForTest()
    const entered = deferred()
    const release = deferred()
    const counts = { connect: 0, metadata: 0, start: 0, close: 0 }
    if (stage === "connect") {
      patchClient("connect", async () => {
        counts.connect++
        entered.resolve()
        await release.promise
      })
    } else {
      patchClient("connect", async () => {
        counts.connect++
      })
      Reflect.set(model, "buildWorkflowMetadata", async () => {
        counts.metadata++
        entered.resolve()
        await release.promise
        return {}
      })
    }
    patchClient("sendStartRequest", () => counts.start++)
    patchClient("close", () => counts.close++)
    patchClient("stop", () => undefined)
    const controller = new AbortController()
    const result = await model.doStream(options(controller.signal))
    const reader = result.stream.getReader()
    const read = reader.read()
    await entered.promise
    controller.abort(new Error("test abort"))
    await expect(read).rejects.toThrow("test abort")
    release.resolve()
    await Promise.resolve()

    expect(counts.start).toBe(0)
    expect(counts.close).toBeGreaterThan(0)
    if (stage === "connect") expect(counts.metadata).toBe(0)
    await reader.cancel().catch(() => undefined)
  }
})

test("abort while approval is pending prevents the approval callback from reconnecting", async () => {
  const model = await modelForTest()
  const entered = deferred()
  const release = deferred<{ approved: boolean }>()
  const startSent = deferred()
  let emit: ((event: WorkflowClientEvent) => void) | undefined
  const counts = { connect: 0, start: 0 }
  patchClient("connect", async (_options: unknown, callback: (event: WorkflowClientEvent) => void) => {
    counts.connect++
    emit = callback
  })
  patchClient("sendStartRequest", () => {
    counts.start++
    startSent.resolve()
  })
  patchClient("stop", () => undefined)
  Reflect.set(model, "approvalHandler", async () => {
    entered.resolve()
    return release.promise
  })
  const controller = new AbortController()
  const result = await model.doStream(options(controller.signal))
  const reader = result.stream.getReader()
  await startSent.promise
  await reader.read()
  await reader.read()
  const read = reader.read()
  emit?.({ type: "approval-required", tools: [{ name: "write_file", args: "{}" }] })
  await entered.promise
  controller.abort(new Error("test abort"))
  await expect(read).rejects.toThrow("test abort")
  release.resolve({ approved: true })
  await Promise.resolve()

  expect(counts).toEqual({ connect: 1, start: 1 })
  await reader.cancel().catch(() => undefined)
})

test("aborting during approval reconnect closes the replacement client and sends no resumed start", async () => {
  const model = await modelForTest()
  const reconnectEntered = deferred()
  const releaseReconnect = deferred()
  const startSent = deferred()
  const approvalEntered = deferred()
  let emit: ((event: WorkflowClientEvent) => void) | undefined
  const counts = { connect: 0, start: 0, close: 0 }
  patchClient("connect", async (_options: unknown, callback: (event: WorkflowClientEvent) => void) => {
    counts.connect++
    if (counts.connect === 1) {
      emit = callback
      return
    }
    reconnectEntered.resolve()
    await releaseReconnect.promise
  })
  patchClient("sendStartRequest", () => {
    counts.start++
    startSent.resolve()
  })
  patchClient("closeAndWait", async () => undefined)
  patchClient("close", () => counts.close++)
  patchClient("stop", () => undefined)
  model.approvalHandler = async () => {
    approvalEntered.resolve()
    return { approved: true }
  }
  const controller = new AbortController()
  const result = await model.doStream(options(controller.signal))
  const reader = result.stream.getReader()
  await startSent.promise
  await reader.read()
  await reader.read()
  const read = reader.read()
  emit?.({ type: "approval-required", tools: [{ name: "write_file", args: "{}" }] })
  await approvalEntered.promise
  await reconnectEntered.promise
  controller.abort(new Error("test abort"))
  await expect(read).rejects.toThrow("test abort")
  releaseReconnect.resolve()
  await Promise.resolve()

  expect(counts.connect).toBe(2)
  expect(counts.start).toBe(1)
  expect(counts.close).toBeGreaterThan(0)
  await reader.cancel().catch(() => undefined)
})

test("normal completion retains the session workflow when the abort signal later fires", async () => {
  const model = await modelForTest()
  model.sessionID = "session-retained"
  let emit: ((event: WorkflowClientEvent) => void) | undefined
  let closes = 0
  patchClient("connect", async (_options: unknown, callback: (event: WorkflowClientEvent) => void) => {
    emit = callback
  })
  patchClient("sendStartRequest", () => undefined)
  patchClient("close", () => closes++)
  patchClient("stop", () => undefined)
  const controller = new AbortController()
  const result = await model.doStream(options(controller.signal))
  const reader = result.stream.getReader()
  const read = (async () => {
    const parts = []
    while (true) {
      const item = await reader.read()
      if (item.done) return parts
      parts.push(item.value)
    }
  })()
  emit?.({ type: "completed" })
  await read
  controller.abort(new Error("late abort"))

  const workflows = Reflect.get(model, "sessionWorkflows") as Map<string, { workflowId: string }>
  expect(workflows.get("session-retained")?.workflowId).toBe("workflow-test-id")
  expect(closes).toBeGreaterThan(0)
})

test("ESM and CJS workflow entry points contain the same lifecycle fixes and stop after deferred cancellation", async () => {
  const require = createRequire(import.meta.url)
  const cjs = require(
    path.join(path.dirname(require.resolve("gitlab-ai-provider/package.json")), "dist/index.js"),
  ) as typeof import("gitlab-ai-provider")
  expect(cjs.GitLabWorkflowLanguageModel).not.toBe(GitLabWorkflowLanguageModel)
  for (const method of ["doStream", "approveAndResume"] as const) {
    expect(Reflect.get(cjs.GitLabWorkflowLanguageModel.prototype, method).toString().replace(/\s+/g, "")).toBe(
      Reflect.get(GitLabWorkflowLanguageModel.prototype, method).toString().replace(/\s+/g, ""),
    )
  }
  for (const Constructor of [GitLabWorkflowLanguageModel, cjs.GitLabWorkflowLanguageModel]) {
    const model = await modelForTest(Constructor)
    const entered = deferred()
    const release = deferred()
    let tokens = 0
    Reflect.set(model, "resolveModelRef", async () => {
      entered.resolve()
      await release.promise
      return "ref"
    })
    const tokenClient = Reflect.get(model, "tokenClient")
    Reflect.set(tokenClient, "getToken", async () => {
      tokens++
      return { token: "test" }
    })
    const controller = new AbortController()
    const pending = model.doStream(options(controller.signal))
    await entered.promise
    controller.abort(new Error("cancel before token"))
    release.resolve()
    await expect(pending).rejects.toThrow("cancel before token")
    expect(tokens).toBe(0)
  }
})

test("late approval events from a completed invocation cannot read the next invocation handler", async () => {
  const model = await modelForTest()
  model.sessionID = "session-sequential"
  const callbacks: ((event: WorkflowClientEvent) => void)[] = []
  let approvals = 0
  let starts = 0
  const firstStarted = deferred()
  const secondStarted = deferred()
  patchClient("connect", async (_options: unknown, callback: (event: WorkflowClientEvent) => void) => {
    callbacks.push(callback)
  })
  patchClient("sendStartRequest", () => {
    starts++
    if (starts === 1) firstStarted.resolve()
    if (starts === 2) secondStarted.resolve()
  })
  patchClient("stop", () => undefined)
  patchClient("close", () => undefined)
  const drain = async (stream: ReadableStream) => {
    const reader = stream.getReader()
    while (!(await reader.read()).done) {}
  }
  const first = new AbortController()
  const a = await model.doStream(options(first.signal))
  const readingA = drain(a.stream)
  await firstStarted.promise
  callbacks[0]({ type: "completed" })
  await readingA
  first.abort()
  model.approvalHandler = async () => {
    approvals++
    return { approved: true }
  }
  const b = await model.doStream(options(new AbortController().signal))
  const readingB = drain(b.stream)
  await secondStarted.promise
  callbacks[0]({ type: "approval-required", tools: [{ name: "late", args: "{}" }] })
  await Promise.resolve()
  expect(approvals).toBe(0)
  expect(starts).toBe(2)
  expect(callbacks.length).toBe(2)
  callbacks[1]({ type: "completed" })
  await readingB
  expect((Reflect.get(model, "sessionWorkflows") as Map<string, unknown>).has("session-sequential")).toBe(true)
})
