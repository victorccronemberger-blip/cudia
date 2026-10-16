import { describe, expect, test } from "bun:test"
import { MCPResourceCatalog } from "../src/mcp/resource-catalog"

describe("MCP resource metadata pages", () => {
  test("keeps exact identities distinct and rejects duplicates or malformed Unicode", () => {
    const items = MCPResourceCatalog.catalog("resources", [
      { uri: "custom:A?x=*", name: "A" },
      { uri: "custom:a?x=*", name: "a" },
    ])
    expect(items.map((item) => item.key)).toEqual(["custom:A?x=*", "custom:a?x=*"])
    expect(() =>
      MCPResourceCatalog.catalog("templates", [
        { uriTemplate: "custom:{name}", name: "a" },
        { uriTemplate: "custom:{name}", name: "b" },
      ]),
    ).toThrow()
    expect(() => MCPResourceCatalog.catalog("resources", [{ uri: "custom:\ud800", name: "invalid" }])).toThrow()
  })

  test("searches complete metadata while returning bounded descriptions and exact URIs", () => {
    const items = MCPResourceCatalog.catalog("resources", [
      {
        uri: "custom:exact%2FURI",
        name: "display",
        title: "Unlisted title needle",
        description: `${"x".repeat(500)} suffix-match`,
      },
    ])
    const result = MCPResourceCatalog.search("resources", items, { query: "suffix-match" }, "a".repeat(64))
    expect(result.matches).toMatchObject([{ uri: "custom:exact%2FURI", name: "display" }])
    expect(result.matches[0]?.description?.length).toBe(400)
    expect(MCPResourceCatalog.search("resources", items, { query: "needle" }, "a".repeat(64)).total).toBe(1)
  })

  test("bounds complete JSON pages and visits every multibyte escaped identity once", () => {
    const values = Array.from({ length: 64 }, (_, index) => ({
      uriTemplate: `custom:${String(index).padStart(3, "0")}/{雪%2F\\"}`,
      name: "雪".repeat(160),
      description: '\\"雪'.repeat(400),
    }))
    const items = MCPResourceCatalog.catalog("templates", values)
    const visited: string[] = []
    let offset = 0
    while (true) {
      const page = MCPResourceCatalog.search("templates", items, { query: "", offset, limit: 16 }, "a".repeat(64))
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MCPResourceCatalog.MAX_PAGE_BYTES)
      visited.push(...page.matches.map((item) => item.uriTemplate!))
      if (page.nextOffset === undefined) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(visited).toEqual(items.map((item) => item.key))
    expect(new Set(visited).size).toBe(64)
  })

  test("reports an oversized exact identity as omitted and advances to the next candidate", () => {
    const items = MCPResourceCatalog.catalog("resources", [
      { uri: `custom:0${"雪".repeat(3_000)}`, name: "oversized" },
      { uri: "custom:1small", name: "small" },
    ])
    const first = MCPResourceCatalog.search("resources", items, { query: "", limit: 1 }, "a".repeat(64))
    expect(first.matches).toEqual([])
    expect(first.omitted).toBe(1)
    expect(first.nextOffset).toBe(1)
    const second = MCPResourceCatalog.search(
      "resources",
      items,
      { query: "", offset: first.nextOffset },
      "a".repeat(64),
    )
    expect(second.matches).toMatchObject([{ uri: "custom:1small" }])
    expect(second.nextOffset).toBeUndefined()
  })
})
