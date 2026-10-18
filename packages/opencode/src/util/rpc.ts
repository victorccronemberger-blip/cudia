type Definition = {
  [method: string]: (input: any) => any
}

type Failure = { name: string; message: string; stack?: string }

function failure(error: unknown): Failure {
  const field = (key: string) => {
    try {
      if (typeof error !== "object" || error === null) return
      const value = Reflect.get(error, key)
      if (typeof value === "string") return value
    } catch {}
  }
  return {
    name: field("name") ?? "Error",
    message: typeof error === "string" ? error : (field("message") ?? "Worker request failed"),
    stack: field("stack"),
  }
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    let request: { type: string; method: string; input: unknown; id: number }
    try {
      request = JSON.parse(evt.data)
      if (request.type !== "rpc.request") return
      if (typeof request.id !== "number" || typeof request.method !== "string") throw new Error("Invalid RPC request")
    } catch {
      process.exit(1)
    }
    try {
      if (!Object.hasOwn(rpc, request.method)) throw new Error(`Unknown worker method: ${request.method}`)
      const result = await rpc[request.method](request.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: request.id }))
    } catch (error) {
      try {
        postMessage(JSON.stringify({ type: "rpc.error", error: failure(error), id: request.id }))
      } catch {
        // A broken channel must close so its caller can reject pending requests.
        process.exit(1)
      }
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(
  target: Pick<Worker, "postMessage" | "addEventListener" | "removeEventListener">,
) {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  let id = 0
  let stopped: Error | undefined
  let disposed = false
  let resolveClosed!: (error?: Error) => void
  const closed = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve
  })

  const detach = () => {
    target.removeEventListener("message", message)
    target.removeEventListener("error", error)
    target.removeEventListener("messageerror", messageError)
    target.removeEventListener("close", exit)
  }
  const fail = (reason: Error) => {
    if (stopped || disposed) return
    stopped = reason
    detach()
    const calls = [...pending.values()]
    pending.clear()
    listeners.clear()
    resolveClosed(reason)
    for (const call of calls) call.reject(reason)
  }
  const message = (evt: MessageEvent<unknown>) => {
    if (stopped || disposed) return
    try {
      if (typeof evt.data !== "string") throw new Error("Invalid worker response")
      const parsed: unknown = JSON.parse(evt.data)
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed))
        throw new Error("Invalid worker response")
      if (parsed.type === "rpc.result" || parsed.type === "rpc.error") {
        if (!("id" in parsed) || typeof parsed.id !== "number") throw new Error("Invalid worker response ID")
        const call = pending.get(parsed.id)
        if (!call) return
        if (parsed.type === "rpc.error") {
          if (!("error" in parsed)) throw new Error("Invalid worker error")
          const details = failure(parsed.error)
          const reason = new Error(details.message)
          reason.name = details.name
          if (details.stack) reason.stack = details.stack
          pending.delete(parsed.id)
          call.reject(reason)
          return
        }
        pending.delete(parsed.id)
        // JSON omits result when a method returns undefined.
        call.resolve("result" in parsed ? parsed.result : undefined)
        return
      }
      if (parsed.type === "rpc.event") {
        if (!("event" in parsed) || typeof parsed.event !== "string") throw new Error("Invalid worker event")
        for (const handler of listeners.get(parsed.event) ?? []) {
          try {
            handler("data" in parsed ? parsed.data : undefined)
          } catch (error) {
            process.emitWarning(new Error("Worker event listener failed", { cause: error }))
          }
        }
        return
      }
      throw new Error("Unknown worker response")
    } catch (error) {
      fail(new Error("CUDIA worker sent an invalid response", { cause: error }))
    }
  }
  const error = (evt: ErrorEvent) => {
    evt.preventDefault()
    fail(new Error("CUDIA worker failed", { cause: evt.message }))
  }
  const messageError = () => fail(new Error("CUDIA worker response could not be received"))
  const exit = (evt: Event) =>
    fail(
      new Error("CUDIA worker stopped unexpectedly", {
        cause: "code" in evt ? evt.code : undefined,
      }),
    )
  target.addEventListener("message", message)
  target.addEventListener("error", error)
  target.addEventListener("messageerror", messageError)
  target.addEventListener("close", exit)

  return {
    closed,
    call<Method extends keyof T>(
      method: Method,
      input: Parameters<T[Method]>[0],
    ): Promise<Awaited<ReturnType<T[Method]>>> {
      if (stopped || disposed) return Promise.reject(stopped ?? new Error("RPC client disposed"))
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve: (value) => resolve(value as Awaited<ReturnType<T[Method]>>), reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(new Error("Could not send worker request", { cause: error }))
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      if (disposed || stopped) return () => {}
      const receive = (data: unknown) => handler(data as Data)
      const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>()
      listeners.set(event, handlers)
      handlers.add(receive)
      return () => {
        handlers.delete(receive)
        if (handlers.size === 0) listeners.delete(event)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      detach()
      const calls = [...pending.values()]
      pending.clear()
      listeners.clear()
      resolveClosed()
      for (const call of calls) call.reject(new Error("RPC client disposed"))
    },
  }
}

export * as Rpc from "./rpc"
