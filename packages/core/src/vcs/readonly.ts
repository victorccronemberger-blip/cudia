import { Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import { OperationError } from "@opencode-ai/schema/vcs"
import { AppProcess } from "../process"

export const MAX_OUTPUT_BYTES = 10_000_000

// These options apply even to discovery/config reads. No optional index refresh,
// monitor hook, pager, pathspec magic, or external diff/text converter is needed.
const options = ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"]

export function run(
  proc: AppProcess.Interface,
  cwd: string,
  args: readonly string[],
  input: { readonly config?: readonly string[]; readonly limit?: number; readonly signal?: AbortSignal } = {},
) {
  const operation = args[0] ?? "git"
  const limit = input.limit ?? MAX_OUTPUT_BYTES
  const collect = (stream: Stream.Stream<Uint8Array, PlatformError>, maximum: number) =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = []
      let bytes = 0
      yield* stream.pipe(
        Stream.runForEach((chunk) => {
          bytes += chunk.byteLength
          if (bytes > maximum)
            return Effect.fail(
              new OperationError({
                reason: "output_limit",
                operation,
                message: "Git output exceeds the response limit",
                limit: maximum,
              }),
            )
          chunks.push(chunk)
          return Effect.void
        }),
      )
      return Buffer.concat(chunks)
    })
  const effect = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* proc.spawn(
        ChildProcess.make("git", [...options, ...(input.config ?? []), ...args], {
          cwd,
          extendEnv: true,
          env: { GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
          stdin: "ignore",
        }),
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(handle.stdout, limit), collect(handle.stderr, 64_000), handle.exitCode],
        { concurrency: "unbounded" },
      )
      return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode }
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof OperationError
        ? cause
        : new OperationError({ reason: "command", operation, message: cause.message }),
    ),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new OperationError({ reason: "command", operation, message: "Git command timed out" })),
    }),
  )
  if (!input.signal) return effect
  return effect.pipe(
    Effect.raceFirst(
      AppProcess.waitForAbort(input.signal).pipe(
        Effect.mapError((cause) => new OperationError({ reason: "command", operation, message: cause.message })),
      ),
    ),
  )
}

export function requireSuccess(
  result: { stdout: string; stderr: string; exitCode: number },
  operation: string,
  accepted = [0],
) {
  return accepted.includes(result.exitCode)
    ? Effect.succeed(result.stdout)
    : Effect.fail(
        new OperationError({
          reason: "command",
          operation,
          message: result.stderr.trim() || `Git exited with status ${result.exitCode}`,
        }),
      )
}

export function parseStatus(text: string) {
  if (text && !text.endsWith("\0")) throw new Error("Incomplete Git name-status output")
  const fields = text.split("\0")
  if (fields.length % 2 !== 1) throw new Error("Invalid Git name-status output")
  const result: { file: string; status: "added" | "deleted" | "modified" }[] = []
  for (let index = 0; index < fields.length - 1; index += 2) {
    const code = fields[index]
    const file = fields[index + 1]
    if (!code || !file || !/^[ADMTUXB]$/.test(code)) throw new Error("Invalid Git name-status output")
    result.push({ file, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" })
  }
  return result
}

export function parseNumstat(text: string) {
  if (text && !text.endsWith("\0")) throw new Error("Incomplete Git numstat output")
  const fields = text.split("\0")
  const result = new Map<string, { additions: number; deletions: number }>()
  for (let index = 0; index < fields.length - 1; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index])
    if (!match) throw new Error("Invalid Git numstat output")
    // --no-index also emits the two-path form for /dev/null -> new file.
    if (!match[3] && (!fields[index + 1] || !fields[index + 2])) throw new Error("Invalid Git numstat path pair")
    const file = match[3] || fields[(index += 2)]
    if (!file) throw new Error("Invalid Git numstat path")
    result.set(file, {
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    })
  }
  return result
}
