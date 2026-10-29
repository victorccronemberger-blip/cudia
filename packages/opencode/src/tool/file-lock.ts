import { Effect, Semaphore } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

const locks = new Map<string, Semaphore.Semaphore>()

function lock(key: string) {
  const hit = locks.get(key)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

export function withFileLocks<A, E, R>(filePaths: string[], effect: Effect.Effect<A, E, R>) {
  const paths = [
    ...new Set(
      filePaths.map((filePath) => {
        const resolved = FSUtil.resolve(filePath)
        return process.platform === "win32" ? resolved.toLowerCase() : resolved
      }),
    ),
  ].sort()
  return paths.reduceRight((next, filePath) => lock(filePath).withPermits(1)(next), effect)
}
