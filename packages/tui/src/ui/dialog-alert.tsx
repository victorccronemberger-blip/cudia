import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { useBindings } from "../keymap"

export type DialogAlertProps = {
  title: string
  message: string
  scrollable?: boolean
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Confirm alert",
        group: "Dialog",
        cmd: () => {
          props.onConfirm?.()
          dialog.clear()
        },
      },
    ],
  }))
  useBindings(() => ({
    enabled: props.scrollable === true,
    bindings: [
      { key: "up", desc: "Scroll error up", group: "Dialog", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll error down", group: "Dialog", cmd: () => scroll?.scrollBy(1) },
      { key: "pageup", desc: "Scroll error up one page", group: "Dialog", cmd: () => scroll?.scrollBy(-scroll.height) },
      {
        key: "pagedown",
        desc: "Scroll error down one page",
        group: "Dialog",
        cmd: () => scroll?.scrollBy(scroll.height),
      },
      { key: "home", desc: "Show error start", group: "Dialog", cmd: () => scroll?.scrollTo(0) },
      { key: "end", desc: "Show error end", group: "Dialog", cmd: () => scroll?.scrollTo(scroll.scrollHeight) },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {props.scrollable ? "↑↓ esc" : "esc"}
        </text>
      </box>
      <box paddingBottom={1}>
        <Show when={props.scrollable} fallback={<text fg={theme.textMuted}>{props.message}</text>}>
          <scrollbox
            ref={(value: ScrollBoxRenderable) => (scroll = value)}
            // The modal's quarter-screen offset and seven chrome rows leave this viewport.
            height={Math.max(1, Math.floor(dimensions().height * 0.75) - 7)}
          >
            <text fg={theme.textMuted} wrapMode="word">
              {props.message}
            </text>
          </scrollbox>
        </Show>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.primary}
          onMouseUp={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        >
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

DialogAlert.show = (
  dialog: DialogContext,
  title: string,
  message: string,
  options: Pick<DialogAlertProps, "scrollable"> = {},
) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} {...options} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
