import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Match, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { useTerminalDimensions } from "@opentui/solid"

const id = "internal:home-footer"
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function fit(value: string, width: number, tail = false) {
  if (width <= 0) return ""
  if (Bun.stringWidth(value) <= width) return value
  const parts = Array.from(segments.segment(value), (part) => part.segment)
  let result = ""
  for (const part of tail ? parts.reverse() : parts) {
    const next = tail ? part + result : result + part
    if (Bun.stringWidth(next) + 1 > width) break
    result = next
  }
  return tail ? "…" + result : result + "…"
}

function Directory(props: { api: TuiPluginApi; width: number }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const dir = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const out = abbreviateHome(selected.directory, paths.home)
    const branch =
      selected.directory === (props.api.state.path.directory || paths.cwd) ? props.api.state.vcs?.branch : undefined
    if (branch) return out + ":" + branch
    return out
  })

  return (
    <box width={props.width} flexShrink={0} height={1} overflow="hidden">
      <Show when={dir()}>
        {(value) => (
          <text width={props.width} fg={theme().textMuted} wrapMode="none">
            {fit(value(), props.width, true)}
          </text>
        )}
      </Show>
    </box>
  )
}

function Mcp(props: { api: TuiPluginApi; width: number }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box width={props.width} height={1} overflow="hidden" gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi; width: number }) {
  const theme = () => props.api.theme.current

  return (
    <box width={props.width} flexShrink={0} height={1} overflow="hidden">
      <text width={props.width} fg={theme().textMuted} wrapMode="none">
        {fit(props.api.app.version, props.width)}
      </text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => Math.max(0, dimensions().width - 4))
  const versionWidth = createMemo(() => Math.min(Bun.stringWidth(props.api.app.version), Math.floor(width() * 0.45)))
  const statusWidth = createMemo(() => {
    const list = props.api.state.mcp()
    if (!list.length) return 0
    const count = list.filter((item) => item.status === "connected").length
    return Math.min(Bun.stringWidth(`⊙ ${count} MCP /status`), Math.max(0, width() - versionWidth() - 4))
  })
  const directoryWidth = createMemo(() =>
    Math.max(0, width() - versionWidth() - statusWidth() - (props.api.state.mcp().length ? 4 : 2)),
  )
  return (
    <box
      width="100%"
      height={3}
      overflow="hidden"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} width={directoryWidth()} />
      <Mcp api={props.api} width={statusWidth()} />
      <Version api={props.api} width={versionWidth()} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
