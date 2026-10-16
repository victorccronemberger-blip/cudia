import { Effect, JsonSchema } from "effect"
import { RegistrationError } from "./tool"

type Dialect = "draft-07" | "draft-2019-09" | "draft-2020-12"
type Validator = (input: unknown) => boolean

export type Compiled = {
  readonly schema: JsonSchema.JsonSchema
  readonly validate: Validator
}

export type Compiler = {
  readonly compile: (raw: JsonSchema.JsonSchema) => Compiled
}

const registrationError = () =>
  new RegistrationError({ name: "json-input", message: "Invalid JSON Schema for tool input" })

export const load = (): Effect.Effect<Compiler> =>
  Effect.gen(function* () {
    const [{ default: Ajv }, { default: Ajv2019 }, { default: Ajv2020 }, { default: addFormats }] =
      yield* Effect.promise(() =>
        Promise.all([import("ajv"), import("ajv/dist/2019.js"), import("ajv/dist/2020.js"), import("ajv-formats")]),
      )

    return {
      compile: (raw: JsonSchema.JsonSchema): Compiled => {
        const prepared = snapshot(raw)
        try {
          const options = {
            allErrors: true,
            strict: false,
            strictSchema: true,
            strictTypes: false,
            strictTuples: false,
            strictRequired: false,
            validateFormats: true,
            useDefaults: false,
            coerceTypes: false,
            removeAdditional: false,
          } as const
          const ajv =
            prepared.dialect === "draft-07"
              ? new Ajv(options)
              : prepared.dialect === "draft-2019-09"
                ? new Ajv2019(options)
                : new Ajv2020(options)
          addFormats(ajv, { mode: "full" })
          for (const keyword of prepared.keywords) ajv.addKeyword(keyword)
          const validate = ajv.compile(prepared.schema)
          return { schema: prepared.schema, validate: (input) => validate(input) }
        } catch {
          throw registrationError()
        }
      },
    }
  })

export const compile = (raw: JsonSchema.JsonSchema): Effect.Effect<Compiled, RegistrationError> =>
  Effect.flatMap(load(), (compiler) => Effect.try({ try: () => compiler.compile(raw), catch: registrationError }))

function snapshot(raw: JsonSchema.JsonSchema) {
  let nodes = 0
  const keywords = new Set<string>()
  const inspect = (value: unknown, depth: number): void => {
    nodes++
    if (nodes > 4096 || depth > 64) throw registrationError()
    if (value === null || typeof value === "string" || typeof value === "boolean") return
    if (typeof value === "number" && Number.isFinite(value)) return
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1)
      return
    }
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw registrationError()
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("x-")) keywords.add(key)
      inspect(item, depth + 1)
    }
  }
  inspect(raw, 0)

  const serialized = JSON.stringify(raw)
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 32 * 1024) throw registrationError()
  const schema = JSON.parse(serialized) as JsonSchema.JsonSchema
  if (typeof schema !== "object" || schema === null || Array.isArray(schema) || schema.type !== "object")
    throw registrationError()

  const dialectURI = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : undefined
  const dialect =
    dialectURI === undefined || dialectURI === "https://json-schema.org/draft/2020-12/schema"
      ? "draft-2020-12"
      : dialectURI === "http://json-schema.org/draft-07/schema"
        ? "draft-07"
        : dialectURI === "https://json-schema.org/draft/2019-09/schema"
          ? "draft-2019-09"
          : undefined
  if (dialect === undefined) throw registrationError()

  if (schema.$vocabulary !== undefined) {
    if (dialect === "draft-07" || typeof schema.$vocabulary !== "object" || schema.$vocabulary === null)
      throw registrationError()
    const supported =
      dialect === "draft-2020-12"
        ? new Set([
            "https://json-schema.org/draft/2020-12/vocab/core",
            "https://json-schema.org/draft/2020-12/vocab/applicator",
            "https://json-schema.org/draft/2020-12/vocab/unevaluated",
            "https://json-schema.org/draft/2020-12/vocab/validation",
            "https://json-schema.org/draft/2020-12/vocab/meta-data",
            "https://json-schema.org/draft/2020-12/vocab/format-annotation",
            "https://json-schema.org/draft/2020-12/vocab/content",
            "https://json-schema.org/draft/2020-12/vocab/format-assertion",
          ])
        : new Set([
            "https://json-schema.org/draft/2019-09/vocab/core",
            "https://json-schema.org/draft/2019-09/vocab/applicator",
            "https://json-schema.org/draft/2019-09/vocab/validation",
            "https://json-schema.org/draft/2019-09/vocab/meta-data",
            "https://json-schema.org/draft/2019-09/vocab/format",
            "https://json-schema.org/draft/2019-09/vocab/content",
          ])
    if (
      Object.entries(schema.$vocabulary).some(
        ([uri, required]) => typeof required !== "boolean" || (required && !supported.has(uri)),
      )
    )
      throw registrationError()
  }

  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  freeze(schema)

  return { schema, dialect: dialect as Dialect, keywords }
}
