import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { KimiAuthPlugin } from "./kimi"
import { CerebrasPlugin } from "./cerebras"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Cause, Effect, Exit, Layer, Context } from "effect"
import type { ContextTrace } from "@opencode-ai/core/harness/trace"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

type State = {
  hooks: Hooks[]
  registrations: { hook: Hooks; origin: ContextTrace.Origin }[]
}

export type Observer<Output> = (
  source: ContextTrace.Origin,
  output: Output,
) => ((outcome: ContextTrace.Outcome) => void) | undefined

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
    observer?: Observer<Output>,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): { id: string; load: PluginInstance }[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    {
      id: "openai-codex",
      load: (input) =>
        CodexAuthPlugin(input, {
          experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
        }),
    },
    { id: "github-copilot", load: CopilotAuthPlugin },
    { id: "modal", load: ModalPlugin },
    { id: "gitlab", load: GitlabAuthPlugin },
    { id: "poe", load: PoeAuthPlugin },
    { id: "cloudflare-workers", load: CloudflareWorkersAuthPlugin },
    { id: "cloudflare-ai-gateway", load: CloudflareAIGatewayAuthPlugin },
    { id: "azure", load: AzureAuthPlugin },
    { id: "digitalocean", load: DigitalOceanAuthPlugin },
    { id: "snowflake-cortex", load: SnowflakeCortexAuthPlugin },
    { id: "xai", load: XaiAuthPlugin },
    { id: "kimi", load: KimiAuthPlugin },
    { id: "cerebras", load: CerebrasPlugin },
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: { name: string; server: PluginInstance }[] = []

  for (const [name, entry] of Object.entries(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push({ name, server: plugin })
  }

  return result
}

// These are observed registration labels, not verified publisher identities.
// Never retain plugin options or URL credentials/query strings in attribution.
function observedLabel(value: string) {
  const head = value.slice(0, 2048).replace(/[\u0000-\u001f\u007f]/g, "")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(head)) {
    try {
      const url = new URL(head)
      url.username = ""
      url.password = ""
      url.search = ""
      url.hash = ""
      return url.href.slice(0, 512)
    } catch {
      return "unparseable-plugin-label"
    }
  }
  return head.split(/[?#]/, 1)[0].slice(0, 512)
}

async function applyPlugin(
  load: PluginLoader.Loaded,
  input: PluginInput,
  register: (hook: Hooks, source: Omit<ContextTrace.Origin, "ordinal">) => void,
) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    const id = await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    register(await (plugin as PluginModule).server(input, load.options), {
      kind: load.source,
      id: observedLabel(id),
      entry: observedLabel(load.entry),
    })
    return
  }

  for (const plugin of getLegacyPlugins(load.mod)) {
    register(await plugin.server(input, load.options), {
      kind: load.source,
      id: `legacy:${observedLabel(plugin.name)}`,
      entry: observedLabel(load.entry),
    })
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const registrations: State["registrations"] = []
        const register = (hook: Hooks, source: Omit<ContextTrace.Origin, "ordinal">) => {
          registrations.push({ hook, origin: Object.freeze({ ...source, ordinal: hooks.length }) })
          hooks.push(hook)
        }
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin.load(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.id, error })),
            Effect.option,
          )
          if (init._tag === "Some") register(init.value, { kind: "builtin", id: plugin.id })
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, register),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks, registrations }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output, observer?: Observer<Output>) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const [index, hook] of s.hooks.entries()) {
        const fn = hook[name] as any
        if (!fn) continue
        if (!observer) {
          yield* Effect.promise(async () => fn(input, output))
          continue
        }
        const finish = yield* Effect.sync(() => {
          try {
            const registration = s.registrations[index]
            return observer(
              registration?.hook === hook
                ? registration.origin
                : { kind: "runtime", id: "unattributed-plugin-registration", ordinal: index },
              output,
            )
          } catch {
            // Optional observation cannot change hook execution or its exit.
            return undefined
          }
        })
        yield* Effect.promise(async () => fn(input, output)).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              try {
                finish?.(
                  Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure",
                )
              } catch {
                // Preserve the original hook result even if observation fails.
              }
            }),
          ),
        )
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
