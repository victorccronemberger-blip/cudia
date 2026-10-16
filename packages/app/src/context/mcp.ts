import { useMutation } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createComponent } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"
import { isNativeMcpAuthenticationRequired } from "@/utils/native-mcp"

export function useMcpToggle() {
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()

  return useMutation(() => ({
    mutationFn: async (name: string) => {
      const current = sync()
      if (current.data.mcp[name]?.nativeStatus === "authentication_required") {
        const view = await import("@/components/dialog-mcp-auth")
        const mcp = current.mcp
        dialog.show(() => createComponent(view.DialogMcpAuth, { name, mcp }))
        return
      }
      await current.mcp.toggle(name)
    },
    onError: (error, name) => {
      const authenticationRequired = isNativeMcpAuthenticationRequired(error)
      if (authenticationRequired && sync().data.mcp[name]?.nativeStatus === "authentication_required") return
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: authenticationRequired
          ? language.t("mcp.auth.clickToAuthenticate")
          : formatServerError(error, language.t),
      })
    },
  }))
}
