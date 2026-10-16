import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

function testAgent(input: {
  name: string
  mode: Agent.Info["mode"]
  permission: Parameters<typeof Permission.fromConfig>[0]
}) {
  return {
    name: input.name,
    mode: input.mode,
    permission: Permission.fromConfig(input.permission),
    options: {},
  } satisfies Agent.Info
}

it.effect("subagent session permission preserves parent records without adding role-based denies", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        edit: "deny",
        task: { worker: "ask" },
      },
    })
    const parentSessionPermission = Permission.fromConfig({
      bash: "deny",
      external_directory: { "/outside/*": "ask" },
    })

    const derived = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: executor,
    })

    expect(derived).toEqual(parentSessionPermission)
    expect(derived).not.toBe(parentSessionPermission)
    expect(derived).not.toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(derived).not.toContainEqual({ permission: "task", pattern: "worker", action: "ask" })

    const effective = Permission.merge(executor.permission, derived)
    expect(effective).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(effective).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(Permission.evaluate("edit", "src/file.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.disabled(["edit", "write", "apply_patch", "bash"], effective)).toEqual(new Set())
  }),
)
