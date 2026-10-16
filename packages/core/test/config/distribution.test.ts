import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { ConfigDistribution } from "@opencode-ai/core/config/distribution"
import { ConfigAgentPlugin } from "@opencode-ai/core/config/plugin/agent"
import { ConfigCommandPlugin } from "@opencode-ai/core/config/plugin/command"
import { ConfigSkillPlugin } from "@opencode-ai/core/config/plugin/skill"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { agentHost, host } from "../plugin/host"

const previous = process.env.CUDIA_DISTRIBUTION_DIR
afterEach(() => {
  if (previous === undefined) delete process.env.CUDIA_DISTRIBUTION_DIR
  else process.env.CUDIA_DISTRIBUTION_DIR = previous
})

test("distribution source is opt-in, absolute, and resolves aliases with path boundaries", async () => {
  delete process.env.CUDIA_DISTRIBUTION_DIR
  expect(await ConfigDistribution.resolve()).toBeUndefined()
  process.env.CUDIA_DISTRIBUTION_DIR = "relative/defaults"
  await expect(ConfigDistribution.resolve()).rejects.toThrow("absolute")
  if (process.platform === "win32") {
    process.env.CUDIA_DISTRIBUTION_DIR = "\\defaults"
    await expect(ConfigDistribution.resolve()).rejects.toThrow("absolute")
  }
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "defaults")
  await fs.mkdir(root)
  await fs.symlink(root, path.join(tmp.path, "alias"), process.platform === "win32" ? "junction" : "dir")
  process.env.CUDIA_DISTRIBUTION_DIR = path.join(tmp.path, "alias")
  const source = await ConfigDistribution.resolve()
  expect(source?.directory).toBe(await fs.realpath(root))
  expect(await source?.contains(path.join(tmp.path, "alias", "missing", "opencode.json"))).toBe(true)
  expect(await source?.contains(path.join(tmp.path, "defaults-other", "opencode.json"))).toBe(false)
  if (process.platform === "win32") expect(await source?.contains(root.toUpperCase())).toBe(true)
})

test("distribution defaults reject plugin and policy declarations before compatibility decoding", () => {
  for (const input of [{ plugin: [] }, { plugins: [] }, { tui: { plugin: [] } }, { experimental: { policies: [] } }]) {
    expect(() => ConfigDistribution.validate(input, "packaged.json")).toThrow("Distribution defaults cannot declare")
  }
})

function configLayer(directory: string, global: string) {
  return AppNodeBuilder.build(
    LayerNode.group([Config.node, AgentV2.node, CommandV2.node, SkillV2.node, FSUtil.node, Global.node, Location.node]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [Global.node, Global.layerWith({ config: global })],
    ],
  )
}

test("packaged V1 defaults stay below user JSON and Markdown without writes or weakened agent permissions", async () => {
  await using tmp = await tmpdir()
  const defaults = path.join(tmp.path, "defaults")
  const global = path.join(tmp.path, "user")
  const project = path.join(tmp.path, "project")
  await Promise.all([defaults, global, project].map((dir) => fs.mkdir(dir)))
  for (const dir of [defaults, global, path.join(project, ".opencode")]) {
    await Promise.all(
      ["agent", "command", "skills/review"].map((name) => fs.mkdir(path.join(dir, name), { recursive: true })),
    )
    const label = dir === defaults ? "packaged" : dir === global ? "global" : "project"
    await fs.writeFile(path.join(dir, "agent/reviewer.md"), `---\ndescription: ${label}\n---\n${label}`)
    await fs.writeFile(path.join(dir, "command/review.md"), `${label} command`)
    await fs.writeFile(
      path.join(dir, "skills/review/SKILL.md"),
      `---\nname: review\ndescription: ${label}\n---\n${label} skill`,
    )
  }
  await fs.copyFile(
    path.join(import.meta.dir, "../../../../.opencode/agent/arena-contestant.md"),
    path.join(defaults, "agent/arena-contestant.md"),
  )
  const packaged = JSON.stringify({
    model: "packaged/model",
    username: "packaged",
    permission: { edit: "allow" },
    mcp: { disabled: { type: "local", command: ["never-run"], enabled: false } },
  })
  await fs.writeFile(path.join(defaults, "opencode.json"), packaged)
  await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ username: "global" }))
  await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ model: "project/model" }))
  process.env.CUDIA_DISTRIBUTION_DIR = defaults
  await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      expect(entries.slice(0, 2).map((entry) => entry.readOnly)).toEqual([true, true])
      expect(Config.latest(entries, "model")).toBe("project/model")
      expect(Config.latest(entries, "username")).toBe("global")
      expect(entries[0].type === "document" && entries[0].info.mcp?.servers?.disabled).toMatchObject({ disabled: true })
      const agents = yield* AgentV2.Service
      const commands = yield* CommandV2.Service
      const skills = yield* SkillV2.Service
      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
      yield* ConfigCommandPlugin.Plugin.effect(host({ command: commands }))
      yield* ConfigSkillPlugin.Plugin.effect(host({ skill: skills }))
      expect((yield* agents.get(AgentV2.ID.make("reviewer")))?.description).toBe("project")
      expect((yield* commands.list()).find((command) => command.name === "review")?.template).toBe("project command")
      expect((yield* skills.list()).find((skill) => skill.name === "review")?.description).toBe("project")
      const arena = yield* agents.get(AgentV2.ID.make("arena-contestant"))
      expect(arena).toBeDefined()
      expect(PermissionV2.evaluate("edit", "*", arena!.permissions).effect).toBe("deny")
    }).pipe(Effect.scoped, Effect.provide(configLayer(project, global))),
  )
  expect(await fs.readFile(path.join(defaults, "opencode.json"), "utf8")).toBe(packaged)
  expect((await fs.readdir(defaults)).sort()).toEqual(["agent", "command", "opencode.json", "skills"])
})

test("V2 config surfaces forbidden packaged declarations", async () => {
  await using tmp = await tmpdir()
  process.env.CUDIA_DISTRIBUTION_DIR = tmp.path
  for (const config of [
    { plugin: ["never-install"] },
    { plugins: ["never-install"] },
    { experimental: { policies: [] } },
  ]) {
    await fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify(config))
    await expect(
      Effect.runPromise(
        Config.Service.use((svc) => svc.entries()).pipe(
          Effect.scoped,
          Effect.provide(configLayer(path.join(tmp.path, "outside"), path.join(tmp.path, "user"))),
        ),
      ),
    ).rejects.toThrow("Distribution defaults cannot declare")
  }
})
