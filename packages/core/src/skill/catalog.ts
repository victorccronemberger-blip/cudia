export * as SkillCatalog from "./catalog"

import { ContextManifest } from "../harness/context-manifest"
import { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"

export type Summary = { readonly name: string; readonly description?: string }

export const BUDGET = 3_200
export const PAGE_SIZE = 8
export const MAX_PAGE_SIZE = 16
export const MAX_SEARCH_BYTES = 6_000
const encoder = new TextEncoder()

const guidance =
  'Load a skill with skill({name: "..."}) when requested or useful for the task. Search metadata with skill({query: "keywords"}); query: "" browses. Only loading a name adds its instructions.'

export function render(skills: ReadonlyArray<Summary>) {
  return renderCatalog(skills, false).text
}

/** Only included metadata rows claim skill origins; omitted catalog entries contribute no text spans. */
export function renderWithOrigins(skills: ReadonlyArray<Summary>): ContextManifest.Rendered {
  return renderCatalog(skills, true)
}

function renderCatalog(skills: ReadonlyArray<Summary>, collectOrigins: boolean): ContextManifest.Rendered {
  if (skills.length === 0) return { text: `${guidance}\nNo skills are currently available.`, origins: [] }
  const described = skills.filter((skill) => skill.description !== undefined)
  const rows = described
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      skill,
      text: `- ${skill.name}: ${skill.description?.replace(/\s+/g, " ").trim()}`,
    }))
  const header = `${guidance}\n<available_skills>\n`
  const catalog = `${header}${rows.map((row) => row.text).join("\n")}\n</available_skills>`
  // Do not favor an alphabetical subset when the installed catalog is large.
  if (catalog.length > BUDGET || described.length === 0)
    return {
      text: `${guidance}\n${skills.length} skills available. Search their metadata when needed; the catalog is omitted to save context.`,
      origins: [],
    }
  if (!collectOrigins) return { text: catalog, origins: [] }
  let cursor = header.length
  const origins: ContextManifestSchema.Origin[] = rows.map((row) => {
    const start = cursor
    cursor += row.text.length + 1
    const observed = ContextManifest.describe(
      JSON.stringify({ name: row.skill.name, description: row.skill.description }),
    )
    return {
      kind: "skill",
      id: row.skill.name,
      start,
      end: start + row.text.length,
      sha256: observed.sha256,
      bytes: observed.bytes,
    }
  })
  return { text: catalog, origins }
}

export function search(skills: ReadonlyArray<Summary>, input: { query: string; offset?: number; limit?: number }) {
  const query = input.query.toLowerCase().trim()
  const terms = query.split(/\s+/).filter(Boolean)
  const ranked = skills
    .map((skill) => {
      const name = skill.name.toLowerCase()
      const description = skill.description?.toLowerCase() ?? ""
      const score =
        (name === query ? 100 : 0) +
        (query && name.includes(query) ? 20 : 0) +
        terms.reduce((score, term) => score + (name.includes(term) ? 5 : 0) + (description.includes(term) ? 1 : 0), 0)
      return { skill, score }
    })
    .filter((item) => query === "" || item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(input.limit ?? PAGE_SIZE)))
  const matches: Summary[] = []
  let visited = 0
  let omitted = 0
  for (const { skill } of ranked.slice(offset, offset + limit)) {
    const match = {
      name: skill.name,
      ...(skill.description === undefined ? {} : { description: skill.description.slice(0, 400) }),
    }
    const bytes = encoder.encode(
      JSON.stringify({
        matches: [...matches, match],
        total: ranked.length,
        nextOffset: offset + visited + 1,
        omitted: MAX_PAGE_SIZE,
      }),
    ).byteLength
    // The native tool truncates whole lines at its byte limit. Keep each JSON
    // page below that limit, including multibyte metadata and cursor fields.
    if (bytes > MAX_SEARCH_BYTES) {
      if (matches.length > 0) break
      // An oversized name cannot be shortened into a loadable name. Skip it
      // explicitly and advance the cursor so discovery cannot get stuck.
      visited++
      omitted++
      continue
    }
    matches.push(match)
    visited++
  }
  return {
    matches,
    total: ranked.length,
    ...(offset + visited < ranked.length ? { nextOffset: offset + visited } : {}),
    ...(omitted > 0 ? { omitted } : {}),
  }
}
