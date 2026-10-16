import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import type { IntegrationsConnectOauthOutput } from "@opencode-ai/runtime-client"
import { ExternalLink } from "@/components/external-link"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { DirectorySync } from "@/context/sync"
import { createStore } from "solid-js/store"
import { onCleanup, onMount, Show } from "solid-js"

export function DialogMcpAuth(props: { name: string; mcp: DirectorySync["mcp"] }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [state, setState] = createStore({
    attempt: undefined as IntegrationsConnectOauthOutput["data"] | undefined,
    code: "",
    error: undefined as string | undefined,
  })
  const dialog = useDialog()
  let alive = true
  let complete = false
  let attemptID: string | undefined

  onMount(() => {
    void (async () => {
      try {
        const attempt = await props.mcp.beginOAuth(props.name)
        if (!attempt) {
          setState("error", language.t("common.requestFailed"))
          return
        }
        if (!alive) {
          await props.mcp.cancelOAuth(attempt.attemptID)
          return
        }
        attemptID = attempt.attemptID
        setState("attempt", attempt)
        platform.openExternal(attempt.url)
        if (attempt.mode === "code") return

        for (let count = 0; count < 120 && alive; count++) {
          const result = await props.mcp.attemptStatus(attempt.attemptID)
          if (!alive) return
          if (result.data.status === "complete") {
            complete = true
            dialog.close()
            return
          }
          if (result.data.status === "failed") {
            setState("error", result.data.message)
            return
          }
          if (result.data.status === "expired") {
            setState("error", language.t("common.requestFailed"))
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        if (alive) setState("error", language.t("common.requestFailed"))
      } catch {
        if (alive) setState("error", language.t("common.requestFailed"))
      }
    })()
  })

  onCleanup(() => {
    alive = false
    if (attemptID && !complete) void props.mcp.cancelOAuth(attemptID).catch(() => undefined)
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!attemptID || !state.code.trim()) return
    try {
      await props.mcp.completeOAuth(attemptID, state.code.trim())
      if (!alive) return
      complete = true
      dialog.close()
    } catch {
      if (alive) setState("error", language.t("provider.connect.oauth.code.invalid"))
    }
  }

  return (
    <Dialog title={language.t("dialog.mcp.title")} description={language.t("mcp.auth.clickToAuthenticate")}>
      <div class="flex flex-col gap-5 px-3 pb-3">
        <Show when={state.attempt}>
          {(attempt) => (
            <>
              <div class="text-14-regular text-text-base">
                {attempt().mode === "auto"
                  ? language.t("provider.connect.oauth.auto.visit.prefix")
                  : language.t("provider.connect.oauth.code.visit.prefix")}
                <ExternalLink href={attempt().url}>{language.t("provider.connect.oauth.code.visit.link")}</ExternalLink>
                {attempt().mode === "auto"
                  ? language.t("provider.connect.oauth.auto.visit.suffix", { provider: props.name })
                  : language.t("provider.connect.oauth.code.visit.suffix", { provider: props.name })}
              </div>
              <Show when={attempt().mode === "code"}>
                <form onSubmit={submit} class="flex flex-col items-start gap-4">
                  <TextField
                    type="text"
                    label={language.t("provider.connect.oauth.code.label", { method: props.name })}
                    placeholder={language.t("provider.connect.oauth.code.placeholder")}
                    value={state.code}
                    onChange={(value) => setState("code", value)}
                    validationState={state.error ? "invalid" : undefined}
                    error={state.error}
                  />
                  <Button type="submit" size="large" variant="primary">
                    {language.t("common.continue")}
                  </Button>
                </form>
              </Show>
            </>
          )}
        </Show>
        <Show when={state.error && state.attempt?.mode !== "code"}>
          <div role="alert" class="text-11-regular text-icon-critical-base">
            {state.error}
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
