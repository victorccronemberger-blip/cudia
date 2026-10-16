import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Permission } from "../src/permission"
import { Config } from "@/config/config"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Config.node))

const load = Config.use.get()

describe("Permission.evaluate for permission.task", () => {
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionV1.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("legacy allow, ask, and deny records do not restrict task evaluation", () => {
    for (const action of ["allow", "ask", "deny"] as const) {
      const ruleset = createRuleset({ "orchestrator-*": action, "*": action })
      expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
      expect(Permission.evaluate("task", "future-agent", ruleset).action).toBe("allow")
    }
    expect(Permission.evaluate("task", "future-agent", []).action).toBe("allow")
  })
})

describe("Permission.disabled for task tool", () => {
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionV1.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("legacy task records never remove task from the enabled catalog", () => {
    for (const action of ["allow", "ask", "deny"] as const) {
      const disabled = Permission.disabled(["task", "bash", "read"], createRuleset({ "*": action }))
      expect(disabled).toEqual(new Set())
    }
    expect(Permission.disabled(["task"], [])).toEqual(new Set())
  })
})

// Integration tests that load permissions from real config files
describe("permission.task with real config files", () => {
  it.instance(
    "loads task permissions from opencode.json config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        // Parsing retains legacy records even though they no longer govern availability.
        expect(ruleset.filter((rule) => rule.permission === "task")).toEqual([
          { permission: "task", pattern: "*", action: "allow" },
          { permission: "task", pattern: "code-reviewer", action: "deny" },
        ])
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "allow",
            "code-reviewer": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "loads task permissions with wildcard patterns from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        expect(ruleset.filter((rule) => rule.permission === "task")).toEqual([
          { permission: "task", pattern: "*", action: "ask" },
          { permission: "task", pattern: "orchestrator-*", action: "deny" },
        ])
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "ask",
            "orchestrator-*": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "retains task permission records from config without restricting new agents",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        expect(ruleset.filter((rule) => rule.permission === "task")).toEqual([
          { permission: "task", pattern: "general", action: "allow" },
          { permission: "task", pattern: "code-reviewer", action: "deny" },
        ])
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "unknown-agent", ruleset).action).toBe("allow")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            general: "allow",
            "code-reviewer": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "mixed permission config with task and other tools",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Verify task permission records are retained while task availability remains unrestricted.
        expect(ruleset.filter((rule) => rule.permission === "task")).toEqual([
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "general", action: "allow" },
        ])
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")

        // Verify other tool permissions
        expect(Permission.evaluate("bash", "*", ruleset).action).toBe("allow")
        expect(Permission.evaluate("edit", "*", ruleset).action).toBe("allow")

        // Verify disabled tools
        const disabled = Permission.disabled(["bash", "edit", "task"], ruleset)
        expect(disabled.has("bash")).toBe(false)
        expect(disabled.has("edit")).toBe(false)
        expect(disabled.has("task")).toBe(false)
      }),
    {
      git: true,
      config: {
        permission: {
          bash: "allow",
          edit: "ask",
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    },
  )

  it.instance(
    "retains task record order when global deny comes last in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        expect(ruleset.filter((rule) => rule.permission === "task")).toEqual([
          { permission: "task", pattern: "general", action: "allow" },
          { permission: "task", pattern: "code-reviewer", action: "allow" },
          { permission: "task", pattern: "*", action: "deny" },
        ])
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "unknown", ruleset).action).toBe("allow")
        expect(Permission.disabled(["task"], ruleset)).toEqual(new Set())
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            general: "allow",
            "code-reviewer": "allow",
            "*": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "retains task record order when a specific allow follows a global deny",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        expect(ruleset.filter((rule) => rule.permission === "task")).toEqual([
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "general", action: "allow" },
        ])
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
        expect(Permission.disabled(["task"], ruleset)).toEqual(new Set())
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    },
  )
})
