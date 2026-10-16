import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import type { CommandApi, ReferenceApi } from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import type { ServerApi } from "@/utils/server"
import type { NativeMcpClient } from "@/utils/native-mcp"
import type { NativeCatalogClient } from "@/utils/native-catalog"
import type { NativeWorkspaceClient } from "@/utils/native-workspace"

type ProjectApi = ServerApi["project"]

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const nativeCatalog = {} as NativeCatalogClient
const api = {
  agent: { list: async () => ({ location: {}, data: [] }) },
  provider: { list: async () => ({ location: {}, data: [] }) },
  model: {
    list: async () => ({ location: {}, data: [] }),
    default: async () => ({ location: {}, data: null }),
  },
  permission: { request: { list: async () => ({ location: {}, data: [] }) } },
  project: {
    list: async () => [],
    current: async () => ({ id: "project", directory: "/project" }),
  },
  question: { request: { list: async () => ({ location: {}, data: [] }) } },
  reference: { list: async () => ({ location: {}, data: [] }) },
  vcs: { get: async () => ({ location: {}, data: {} }) },
} as unknown as ServerApi

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("uses legacy MCP endpoints while refreshing a v1 directory", async () => {
    const legacyConfigReads: string[] = []
    const mcpReads: string[] = []
    const vcsCacheWrites: unknown[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      nativeCatalog,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: {
          get: async () => {
            legacyConfigReads.push("directory")
            return { data: {} }
          },
        },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: { branch: "main", default_branch: "main" } }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        experimental: {
          resource: {
            list: async () => {
              mcpReads.push("resource")
              return { data: {} }
            },
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: {
        setStore(...args: unknown[]) {
          vcsCacheWrites.push(args)
        },
      } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(legacyConfigReads).toEqual(["directory"])
    expect(mcpReads.sort()).toEqual(["command", "resource", "status"])
    expect(store.vcs).toEqual({ branch: "main", default_branch: "main" })
    expect(vcsCacheWrites).toEqual([["value", { branch: "main", default_branch: "main" }]])
  })

  test("skips legacy config and MCP resources while refreshing a v2 directory", async () => {
    const [store, setStore] = directoryState()
    let mcpLists = 0
    let resourceCatalogs = 0
    let legacyVcsReads = 0
    const vcsCalls: unknown[] = []
    const vcsCacheWrites: unknown[] = []

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      nativeCatalog: {
        agents: { list: async () => ({ location: {}, data: [] }) },
        models: {
          list: async () => ({ location: {}, data: [] }),
          default: async () => ({ location: {}, data: null }),
        },
        providers: { list: async () => ({ location: {}, data: [] }) },
      } as unknown as NativeCatalogClient,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        config: {
          get: async () => {
            throw new Error("legacy directory config should not be called")
          },
        },
        vcs: {
          get: async () => {
            legacyVcsReads++
            throw new Error("legacy VCS route should not be called")
          },
        },
      } as unknown as OpencodeClient,
      nativeWorkspace: {
        vcs: {
          get: async (input: unknown) => {
            vcsCalls.push(input)
            return {
              location: { directory: "/project", project: { id: "project", directory: "/project" } },
              data: { branch: "feature", defaultBranch: "main" },
            }
          },
        },
      } as unknown as NativeWorkspaceClient,
      nativeMcp: {
        mcp: {
          list: async () => {
            mcpLists++
            return {
              location: { directory: "/project", project: { id: "project", directory: "/project" } },
              data: [],
            }
          },
        },
      } as unknown as NativeMcpClient,
      api: {
        ...api,
        command: { list: async () => ({ location: {}, data: [] }) },
        mcp: {
          resource: {
            catalog: async () => {
              resourceCatalogs++
              return {
                location: { directory: "/project", project: { id: "project", directory: "/project" } },
                data: { resources: [], templates: [] },
              }
            },
          },
        },
      } as unknown as ServerApi,
      store,
      setStore,
      vcsCache: {
        setStore(...args: unknown[]) {
          vcsCacheWrites.push(args)
        },
      } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v2"),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpLists).toBe(1)
    expect(resourceCatalogs).toBe(0)
    expect(vcsCalls).toEqual([{ location: { directory: "/project" } }])
    expect(legacyVcsReads).toBe(0)
    expect(store.vcs).toEqual({ branch: "feature", default_branch: "main" })
    expect(vcsCacheWrites).toEqual([["value", { branch: "feature", default_branch: "main" }]])
  })
})

describe("config queries", () => {
  test("skips legacy global config for v2 servers", async () => {
    const sdk = {
      global: {
        config: {
          get: async () => {
            throw new Error("legacy global config should not be called")
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v2")),
    )

    expect(result).toEqual({})
  })

  test("loads legacy global config for v1 servers", async () => {
    const calls: string[] = []
    const config = { shell: "zsh" } satisfies Config
    const sdk = {
      global: {
        config: {
          get: async () => {
            calls.push("global")
            return { data: config }
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v1")),
    )

    expect(result).toEqual(config)
    expect(calls).toEqual(["global"])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const api = {} as NativeCatalogClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("loads the current provider and model catalog", async () => {
    const calls: unknown[] = []
    const api = {
      providers: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return {
            location: {},
            data: [
              {
                id: "openai",
                name: "OpenAI",
                api: { type: "aisdk", package: "@ai-sdk/openai" },
                request: { headers: {}, body: {} },
              },
            ],
          }
        },
      },
      models: {
        list: async (input: unknown) => {
          calls.push(["model", input])
          return { location: {}, data: [] }
        },
        default: async (input: unknown) => {
          calls.push(["default", input])
          return { location: {}, data: null }
        },
      },
    } as unknown as NativeCatalogClient

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([
      ["provider", { location: { directory: "/repo" } }],
      ["model", { location: { directory: "/repo" } }],
      ["default", { location: { directory: "/repo" } }],
    ])
    expect(result.connected).toEqual(["openai"])
  })

  test("loads agents from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [] }
      },
    } as unknown as NativeCatalogClient["agents"]

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([])
  })

  test("loads commands from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [{ name: "review", template: "Review files" /* source: "command" as const */ }],
        }
      },
    } as unknown as CommandApi

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([{ name: "review", template: "Review files" /* source: "command" */ }])
  })

  test("loads projects from the current endpoint", async () => {
    const api = {
      list: async () => [
        { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
        { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    } as unknown as ProjectApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
  })

  test("loads canonical V2 projects without consulting the legacy project endpoint", async () => {
    const nativeWorkspace = {
      projects: {
        list: async () => [
          {
            id: "repo",
            worktree: "/repo",
            vcs: "git" as const,
            time: { created: 1, updated: 2 },
            sandboxes: ["/repo-copy"],
          },
        ],
      },
    } as unknown as NativeWorkspaceClient
    const legacy = {
      list: async () => {
        throw new Error("legacy project route called")
      },
    } as unknown as ProjectApi

    const result = await new QueryClient().fetchQuery(
      loadProjectsQuery(ServerScope.local, legacy, nativeWorkspace, Promise.resolve("v2")),
    )

    expect(result).toMatchObject([{ id: "repo", worktree: "/repo", sandboxes: ["/repo-copy"] }])
  })

  test("fails an unwired V2 project query without sending a request to a legacy route", async () => {
    let calls = 0
    const legacy = {
      list: async () => {
        calls++
        return []
      },
    } as unknown as ProjectApi

    await expect(
      new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, legacy, undefined, Promise.resolve("v2"))),
    ).rejects.toMatchObject({ cause: "NativeWorkspaceUnavailable" })
    expect(calls).toBe(0)
  })

  test("loads the canonical home and selected directory while retaining the project root", async () => {
    const calls: unknown[] = []
    const nativeWorkspace = {
      locationPaths: { get: async () => ({ home: "/home/user", defaultDirectory: "/repo/subdir" }) },
      location: {
        get: async (input: unknown) => {
          calls.push(input)
          return { directory: "/repo/subdir", project: { id: "repo", directory: "/repo" } }
        },
      },
    } as unknown as NativeWorkspaceClient
    const legacy = {} as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadPathQuery(ServerScope.local, null, legacy, Promise.resolve("v2"), nativeWorkspace),
    )

    expect(result).toEqual({
      state: "",
      config: "",
      worktree: "/repo",
      directory: "/repo/subdir",
      home: "/home/user",
    })
    expect(calls).toEqual([{ location: { directory: "/repo/subdir" } }])
  })

  test("loads references from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
