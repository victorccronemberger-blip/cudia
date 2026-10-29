import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Schema } from "effect"
import path from "node:path"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"

export const Model = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  variant: Schema.optional(Schema.String),
})
export type Model = Schema.Schema.Type<typeof Model>
export const Settings = Schema.Struct({ model: Schema.optional(Model) })

const file = path.join(Global.Path.config, "compaction-model.json")

export async function read(): Promise<Model | undefined> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  try {
    return Schema.decodeUnknownSync(Model)(JSON.parse(text))
  } catch (error) {
    throw new Error(`Invalid compaction settings in ${file}: ${String(error)}`)
  }
}

export async function write(model: Model): Promise<void> {
  await Flock.withLock(`compaction-settings:${file}`, async () => {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(model, null, 2))
      await handle.sync()
      await handle.close()
      await rename(temporary, file)
    } finally {
      await handle.close().catch(() => {})
      await rm(temporary, { force: true })
    }
  })
}

export * as CompactionSettings from "./compaction-settings"
