import { expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Skill } from "@/skill"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Skill.node, FSUtil.node, CrossSpawnSpawner.node]), [
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableExternalSkills: true })],
  ]),
)

it.instance("discovers packaged legacy skills from an external cwd below project skill overrides", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const test = yield* TestInstance
    const defaults = yield* tmpdirScoped()
    for (const [directory, label] of [
      [defaults, "packaged"],
      [path.join(test.directory, ".opencode"), "project"],
    ]) {
      yield* fs.writeWithDirs(
        path.join(directory, "skills/distribution-shared/SKILL.md"),
        `---\nname: distribution-shared\ndescription: ${label}\n---\n${label}`,
      )
    }
    yield* fs.writeWithDirs(
      path.join(defaults, "skills/distribution-only/SKILL.md"),
      "---\nname: distribution-only\ndescription: packaged\n---\nPackaged skill",
    )
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CUDIA_DISTRIBUTION_DIR
        process.env.CUDIA_DISTRIBUTION_DIR = defaults
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const skills = yield* Skill.Service
          expect((yield* skills.get("distribution-shared"))?.description).toBe("project")
          expect((yield* skills.get("distribution-only"))?.description).toBe("packaged")
          expect(yield* fs.existsSafe(path.join(defaults, ".gitignore"))).toBe(false)
          expect(yield* fs.existsSafe(path.join(defaults, "node_modules"))).toBe(false)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CUDIA_DISTRIBUTION_DIR
          else process.env.CUDIA_DISTRIBUTION_DIR = previous
        }),
    )
  }),
)
