export * as MCPResourceCatalog from "./resource-catalog"

export const MAX_PAGE_BYTES = 6_000
export const MAX_URI_BYTES = 8 * 1024
export const MAX_QUERY_BYTES = 4 * 1024
export const MAX_PAGE_SIZE = 16

export type Kind = "resources" | "templates"
export type Page = {
  readonly query: string
  readonly offset?: number
  readonly limit?: number
  readonly snapshot?: string
}
export type Item = {
  readonly key: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
}

export function catalog(
  kind: Kind,
  values: readonly {
    readonly uri?: string
    readonly uriTemplate?: string
    readonly name: string
    readonly title?: string
    readonly description?: string
    readonly mimeType?: string
  }[],
): readonly Item[] {
  const seen = new Set<string>()
  return values
    .map((value) => {
      const key = kind === "resources" ? value.uri : value.uriTemplate
      if (!key || !key.isWellFormed() || seen.has(key)) throw new Error("Invalid or duplicate MCP resource identity")
      seen.add(key)
      return { key, name: value.name, title: value.title, description: value.description, mimeType: value.mimeType }
    })
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function search(kind: Kind, items: readonly Item[], input: Page, snapshot: string) {
  const query = input.query.trim().toLowerCase()
  const terms = query.split(/\s+/).filter(Boolean)
  const ranked = items
    .map((item) => {
      const key = item.key.toLowerCase()
      const name = item.name.toLowerCase()
      const title = item.title?.toLowerCase() ?? ""
      const description = item.description?.toLowerCase() ?? ""
      const score =
        (key === query || name === query ? 100 : 0) +
        (query && (key.includes(query) || name.includes(query)) ? 20 : 0) +
        terms.reduce(
          (total, term) =>
            total +
            (key.includes(term) ? 5 : 0) +
            (name.includes(term) || title.includes(term) ? 5 : 0) +
            (description.includes(term) ? 1 : 0),
          0,
        )
      return { item, score }
    })
    .filter((entry) => query === "" || entry.score > 0)
    .toSorted((a, b) => b.score - a.score || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0))
  const offset = input.offset ?? 0
  const limit = input.limit ?? 8
  const matches: Array<{
    readonly uri?: string
    readonly uriTemplate?: string
    readonly name: string
    readonly description?: string
    readonly mimeType?: string
  }> = []
  let visited = 0
  let omitted = 0
  for (const { item } of ranked.slice(offset, offset + limit)) {
    const match = {
      ...(kind === "resources" ? { uri: item.key } : { uriTemplate: item.key }),
      name: item.name.slice(0, 160),
      ...(item.description === undefined ? {} : { description: item.description.slice(0, 400) }),
      ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType.slice(0, 128) }),
    }
    const candidate = {
      supported: true,
      matches: [...matches, match],
      total: ranked.length,
      snapshot,
      nextOffset: offset + visited + 1,
      omitted: MAX_PAGE_SIZE,
    }
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_PAGE_BYTES) {
      if (matches.length > 0) break
      visited++
      omitted++
      continue
    }
    matches.push(match)
    visited++
  }
  return {
    supported: true,
    matches,
    total: ranked.length,
    snapshot,
    ...(offset + visited < ranked.length ? { nextOffset: offset + visited } : {}),
    ...(omitted > 0 ? { omitted } : {}),
  }
}
