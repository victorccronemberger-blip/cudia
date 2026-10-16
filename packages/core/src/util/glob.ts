import { glob, globSync, globIterate, globIterateSync, type GlobOptions } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
    maxResults?: number
  }

  export class ResultLimitError extends Error {
    constructor(readonly maximumResults: number) {
      super(`Glob scan exceeded result limit of ${maximumResults}`)
      this.name = "ResultLimitError"
    }
  }

  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
    }
  }

  export async function scan(pattern: string, options: Options = {}, signal?: AbortSignal): Promise<string[]> {
    if (options.maxResults === undefined) return glob(pattern, toGlobOptions(options)) as Promise<string[]>
    if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 0) {
      throw new RangeError("maxResults must be a nonnegative safe integer")
    }
    // Minipass's async iterator `return()` only pauses the stream. Give the
    // bounded scan its own signal so we can stop Glob's walker when the cap is
    // exceeded or this consumer exits early, while still relaying cancellation
    // from the caller.
    const controller = new AbortController()
    const relayAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) relayAbort()
    else signal?.addEventListener("abort", relayAbort, { once: true })

    const iterator = globIterate(pattern, { ...toGlobOptions(options), signal: controller.signal })
    const results: string[] = []
    let completed = false
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) {
          completed = true
          return results
        }
        if (results.length >= options.maxResults) throw new ResultLimitError(options.maxResults)
        results.push(result.value as string)
      }
    } finally {
      if (!completed && !controller.signal.aborted) controller.abort()
      signal?.removeEventListener("abort", relayAbort)
      await iterator.return(undefined)
    }
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    if (options.maxResults === undefined) return globSync(pattern, toGlobOptions(options)) as string[]
    if (!Number.isSafeInteger(options.maxResults) || options.maxResults < 0) {
      throw new RangeError("maxResults must be a nonnegative safe integer")
    }
    const iterator = globIterateSync(pattern, toGlobOptions(options))
    const results: string[] = []
    try {
      while (true) {
        const result = iterator.next()
        if (result.done) return results
        if (results.length >= options.maxResults) throw new ResultLimitError(options.maxResults)
        results.push(result.value as string)
      }
    } finally {
      iterator.return(undefined)
    }
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
