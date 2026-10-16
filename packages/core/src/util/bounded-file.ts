export * as BoundedFile from "./bounded-file"

import { Effect, FileSystem, Option, Schema } from "effect"
import { resolve } from "path"
import { FSUtil } from "../fs-util"

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("BoundedFileLimitError", {
  maximumBytes: Schema.Number,
}) {
  override get message() {
    return `File exceeded byte limit of ${this.maximumBytes}`
  }
}

export class SourceError extends Schema.TaggedErrorClass<SourceError>()("BoundedFileSourceError", {
  reason: Schema.Literals(["changed", "not_file", "range"]),
}) {
  override get message() {
    return `File source ${this.reason === "not_file" ? "is not a regular file" : this.reason}`
  }
}

export const unchanged = (first: FileSystem.File.Info, second: FileSystem.File.Info) =>
  first.dev === second.dev &&
  Option.getOrUndefined(first.ino) === Option.getOrUndefined(second.ino) &&
  first.size === second.size &&
  Option.match(first.mtime, {
    onNone: () => Option.isNone(second.mtime),
    onSome: (mtime) =>
      Option.match(second.mtime, { onNone: () => false, onSome: (value) => value.getTime() === mtime.getTime() }),
  })

export const read = (fs: FSUtil.Interface, input: string, maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return Effect.fail(new SourceError({ reason: "range" }))
  const path = resolve(input)
  return Effect.scoped(
    Effect.gen(function* () {
      const initialRealPath = yield* fs.realPath(path)
      if (!samePath(initialRealPath, path)) return yield* Effect.fail(new SourceError({ reason: "changed" }))
      const initialPathInfo = yield* fs.stat(path)
      if (initialPathInfo.type !== "File") return yield* Effect.fail(new SourceError({ reason: "not_file" }))
      if (initialPathInfo.size > BigInt(maxBytes)) return yield* Effect.fail(new LimitError({ maximumBytes: maxBytes }))

      const file = yield* fs.open(path, { flag: "r" })
      const openedInfo = yield* file.stat
      if (openedInfo.type !== "File" || !unchanged(initialPathInfo, openedInfo)) {
        return yield* Effect.fail(new SourceError({ reason: "changed" }))
      }

      const chunks: Uint8Array[] = []
      let bytes = 0
      while (bytes <= maxBytes) {
        const chunk = yield* file.readAlloc(Math.min(64 * 1024, maxBytes + 1 - bytes))
        if (Option.isNone(chunk)) break
        const value = chunk.value
        if (bytes + value.byteLength > maxBytes) return yield* Effect.fail(new LimitError({ maximumBytes: maxBytes }))
        chunks.push(value)
        bytes += value.byteLength
      }

      const finalPath = yield* fs.realPath(path)
      const finalPathInfo = yield* fs.stat(path)
      const finalHandleInfo = yield* file.stat
      if (
        !samePath(finalPath, path) ||
        !unchanged(initialPathInfo, finalPathInfo) ||
        !unchanged(initialPathInfo, finalHandleInfo)
      ) {
        return yield* Effect.fail(new SourceError({ reason: "changed" }))
      }
      return Buffer.concat(chunks, bytes)
    }),
  )
}

const samePath = (left: string, right: string) => left === right
