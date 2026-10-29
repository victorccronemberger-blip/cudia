import { expect, test } from "bun:test"
import { limitContext } from "../src/model-context"

test("caps large context and input windows without changing provider output capacity", () => {
  const original = { context: 1_000_000, input: 983_616, output: 131_072 }
  expect(limitContext(original)).toEqual({ context: 248_000, input: 248_000, output: 131_072 })
  expect(original.context).toBe(1_000_000)
})

test("caps Drael at 240k while other providers use the general maximum", () => {
  const limit = { context: 1_000_000, input: 983_616, output: 8_192 }
  expect(limitContext(limit, "drael")).toEqual({ context: 240_000, input: 240_000, output: 8_192 })
  expect(limitContext(limit, "qwencloud")).toEqual({ context: 248_000, input: 248_000, output: 8_192 })
})

test("does not raise Drael limits below its provider maximum", () => {
  expect(limitContext({ context: 96_000, input: 80_000, output: 8_000 }, "drael")).toEqual({
    context: 96_000,
    input: 80_000,
    output: 8_000,
  })
})

test("preserves smaller and unknown provider limits", () => {
  expect(limitContext({ context: 32_000, input: 24_000, output: 8_000 })).toEqual({
    context: 32_000,
    input: 24_000,
    output: 8_000,
  })
  expect(limitContext({ context: 0, output: 0 })).toEqual({ context: 0, output: 0 })
})
