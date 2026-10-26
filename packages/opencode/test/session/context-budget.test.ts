import { expect, test } from "bun:test"
import { isOverflow, usable } from "../../src/session/overflow"
import { Provider } from "../../src/provider/provider"

test("compacts before input plus output exceeds a capped window", () => {
  const model = { limit: { context: 248_000, input: 248_000, output: 131_072 } } as Provider.Model
  expect(usable({ cfg: {}, model })).toBe(216_000)
  expect(
    isOverflow({
      cfg: {},
      model,
      tokens: { input: 216_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ).toBe(true)
})

test("keeps lower input limits and explicit compaction buffers", () => {
  const model = { limit: { context: 128_000, input: 50_000, output: 8_000 } } as Provider.Model
  expect(usable({ cfg: {}, model })).toBe(42_000)
  expect(usable({ cfg: { compaction: { reserved: 10_000 } }, model })).toBe(40_000)
})
