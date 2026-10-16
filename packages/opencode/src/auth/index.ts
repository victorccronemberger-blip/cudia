import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flock } from "@opencode-ai/core/util/flock"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { NativeChatGPT } from "../plugin/openai/chatgpt"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

// Atomic replacement keeps a crash from leaving half a rotating token pair.
// The shared lock also prevents concurrent provider updates from losing keys.
export async function readStored(): Promise<Record<string, Info>> {
  const text =
    process.env.OPENCODE_AUTH_CONTENT ??
    (await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    }))
  const data = JSON.parse(text)
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid auth data")
  const decode = Schema.decodeUnknownOption(Info)
  return Record.filterMap(data as Record<string, unknown>, (value) => Result.fromOption(decode(value), () => undefined))
}

export async function mutateStored(update: (data: Record<string, Info>) => Record<string, Info> | undefined) {
  return Flock.withLock(`auth:${file}`, async () => {
    const data = update(await readStored())
    if (!data) return false
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(data, null, 2))
      await handle.sync()
      await handle.close()
      await rename(temporary, file)
      return true
    } finally {
      await handle.close().catch(() => {})
      await rm(temporary, { force: true })
    }
  })
}

export async function replaceStored(key: string, expected: Oauth, next: Oauth) {
  return mutateStored((data) => {
    const current = data[key]
    if (
      current?.type !== "oauth" ||
      current.access !== expected.access ||
      current.refresh !== expected.refresh ||
      current.metadata?.clientId !== expected.metadata?.clientId
    )
      return
    return { ...data, [key]: next }
  })
}

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const all = Effect.fn("Auth.all")(() =>
      Effect.tryPromise({ try: readStored, catch: fail("Failed to read auth data") }),
    )

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      yield* Effect.tryPromise({
        try: () =>
          mutateStored((data) => {
            if (norm !== key) delete data[key]
            delete data[norm + "/"]
            return { ...data, [norm]: info }
          }),
        catch: fail("Failed to write auth data"),
      })
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const selected = yield* get(norm)
      const native = norm === "openai" && selected?.type === "oauth" && selected.metadata?.oauthMode === "chatgpt"
      if (native) {
        const result = yield* Effect.tryPromise({
          try: () => NativeChatGPT.logout(selected),
          catch: fail("Failed to sign out of ChatGPT"),
        })
        if (result.revocationError)
          return yield* new AuthError({
            message: "Credentials removed locally; remote ChatGPT revocation failed",
            cause: result.revocationError,
          })
        return
      }
      yield* Effect.tryPromise({
        try: () =>
          mutateStored((data) => {
            delete data[key]
            delete data[norm]
            return data
          }),
        catch: fail("Failed to write auth data"),
      })
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
