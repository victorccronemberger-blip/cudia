import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"

test("each runtime resolves its database placement after the module has been imported", async () => {
  const temporaryRoot = resolve(tmpdir())
  const directory = resolve(await mkdtemp(join(temporaryRoot, "cudia-database-runtime-")))
  const within = relative(temporaryRoot, directory)
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error("Refusing to remove a database fixture outside the temporary directory")
  const previous = Flag.OPENCODE_DB
  try {
    for (const name of ["first.sqlite", "second.sqlite"]) {
      Flag.OPENCODE_DB = join(directory, name)
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const placement = yield* database.db.get<{ file: string }>(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
          )
          const existing = yield* database.db.all("SELECT name FROM sqlite_master WHERE name = 'runtime_probe'")
          yield* database.db.run("CREATE TABLE runtime_probe (value TEXT)")
          return { placement, existing }
        }).pipe(Effect.provide(AppNodeBuilder.build(Database.node)), Effect.scoped),
      )
      expect(resolve(observed.placement!.file)).toBe(resolve(directory, name))
      expect(observed.existing).toEqual([])
    }
  } finally {
    Flag.OPENCODE_DB = previous
    Bun.gc(true)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
