import { describe, expect, test } from "bun:test"
import { SkillCatalog } from "@opencode-ai/core/skill/catalog"

describe("SkillCatalog", () => {
  test("small catalogs advertise metadata without bodies or resource paths", () => {
    const skills = [
      { name: "zeta", description: "Zeta workflow", content: "private body", location: "/private/zeta" },
      { name: "alpha", description: "Alpha\nworkflow" },
      { name: "manual" },
    ]
    const output = SkillCatalog.render(skills)
    expect(output).toContain("- alpha: Alpha workflow")
    expect(output.indexOf("- alpha:")).toBeLessThan(output.indexOf("- zeta:"))
    expect(output).not.toContain("private")
    expect(output).not.toContain("manual")
  })

  test("large catalogs stay bounded without choosing an alphabetical subset", () => {
    const skills = Array.from({ length: 1_000 }, (_, i) => ({
      name: `skill-${i}`,
      description: "Workflow ".repeat(100),
    }))
    const output = SkillCatalog.render(skills)
    expect(output.length).toBeLessThanOrEqual(SkillCatalog.BUDGET)
    expect(output).toContain("1000 skills available")
    expect(output).not.toContain("skill-0")
    expect(output).not.toContain("Workflow")
  })

  test("search ranks exact names, pages results, and returns metadata only", () => {
    const skills = [
      { name: "other", description: "Authentication testing", content: "secret", location: "/secret" },
      { name: "auth", description: "Authentication workflow" },
      { name: "auth-api", description: "API authentication" },
    ]
    const first = SkillCatalog.search(skills, { query: "auth", limit: 2 })
    expect(first).toEqual({
      matches: [
        { name: "auth", description: "Authentication workflow" },
        { name: "auth-api", description: "API authentication" },
      ],
      total: 3,
      nextOffset: 2,
    })
    expect(SkillCatalog.search(skills, { query: "auth", offset: first.nextOffset, limit: 2 })).toEqual({
      matches: [{ name: "other", description: "Authentication testing" }],
      total: 3,
    })
  })

  test("empty query browses undescribed names and long search descriptions are bounded", () => {
    expect(SkillCatalog.search([{ name: "manual" }], { query: "" })).toEqual({
      matches: [{ name: "manual" }],
      total: 1,
    })
    const result = SkillCatalog.search([{ name: "large", description: "x".repeat(10_000) }], { query: "" })
    expect(result.matches[0].description).toHaveLength(400)
    expect(SkillCatalog.search([{ name: "manual" }], { query: "missing" })).toEqual({ matches: [], total: 0 })
  })

  test("Unicode pages fit the byte budget and pagination retains every match", () => {
    const skills = Array.from({ length: 16 }, (_, i) => ({ name: `skill-${i}`, description: "日".repeat(400) }))
    const names: string[] = []
    let offset = 0
    do {
      const page = SkillCatalog.search(skills, { query: "", limit: 16, offset })
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
        SkillCatalog.MAX_SEARCH_BYTES,
      )
      names.push(...page.matches.map((skill) => skill.name))
      offset = page.nextOffset ?? skills.length
    } while (offset < skills.length)
    expect(names.toSorted()).toEqual(skills.map((skill) => skill.name).toSorted())
  })

  test("oversized names are omitted explicitly without blocking the cursor", () => {
    const page = SkillCatalog.search([{ name: "a".repeat(10_000) }, { name: "b" }], { query: "", limit: 1 })
    expect(page).toEqual({ matches: [], total: 2, nextOffset: 1, omitted: 1 })
    expect(
      SkillCatalog.search([{ name: "a".repeat(10_000) }, { name: "b" }], { query: "", offset: page.nextOffset }),
    ).toEqual({
      matches: [{ name: "b" }],
      total: 2,
    })
  })
})
