import { createMemo, createSignal, onMount, onCleanup } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useKV } from "../context/kv"
import { useSDK } from "../context/sdk"
import { errorMessage } from "../util/error"

export type CompactionModel = {
  providerID: string
  modelID: string
  variant?: string
}

export function DialogCompact(props: { onConfirm: (model: CompactionModel) => void }) {
  const dialog = useDialog()
  const sync = useSync()
  const local = useLocal()
  const kv = useKV()
  const sdk = useSDK()
  const [settings, setSettings] = createSignal<CompactionModel>()
  const [ready, setReady] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let submitted = false
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  async function load() {
    setReady(false)
    setError(undefined)
    try {
      const result = await sdk.client.compaction.settings()
      if (disposed) return
      if (result.error) throw result.error
      setSettings(result.data.model)
      setReady(true)
    } catch (error: unknown) {
      if (!disposed) setError(errorMessage(error))
    }
  }
  onMount(() => void load())

  const models = createMemo(() =>
    sync.data.provider
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .flatMap((provider) =>
        Object.values(provider.models)
          .filter((model) => model.status !== "deprecated" && model.capabilities.input.text)
          .toSorted((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))
          .map((model) => ({ provider, model })),
      ),
  )

  const preferred = createMemo<CompactionModel | undefined>(() => {
    if (settings()) return settings()
    const cached: unknown = kv.get("compaction_model")
    if (
      typeof cached === "object" &&
      cached !== null &&
      "providerID" in cached &&
      typeof cached.providerID === "string" &&
      "modelID" in cached &&
      typeof cached.modelID === "string" &&
      models().some((item) => item.provider.id === cached.providerID && item.model.id === cached.modelID)
    )
      return {
        providerID: cached.providerID,
        modelID: cached.modelID,
        variant: "variant" in cached && typeof cached.variant === "string" ? cached.variant : undefined,
      }
    const agent = sync.data.agent.find((item) => item.name === "compaction")
    const configured = agent?.model
    if (
      configured &&
      models().some((item) => item.provider.id === configured.providerID && item.model.id === configured.modelID)
    )
      return { ...configured, variant: agent.variant }
    return local.model.current()
  })

  function confirm(model: CompactionModel) {
    if (submitted) return
    submitted = true
    dialog.clear()
    props.onConfirm(model)
  }

  function choose(item: ReturnType<typeof models>[number]) {
    const selected = { providerID: item.provider.id, modelID: item.model.id }
    const variants = Object.keys(item.model.variants ?? {})
    if (!variants.length) {
      confirm(selected)
      return
    }
    const previous = preferred()
    const current =
      previous?.providerID === selected.providerID && previous.modelID === selected.modelID
        ? previous.variant
        : undefined
    dialog.replace(() => (
      <DialogSelect
        title="Compact session · select effort"
        placeholder={`Reasoning effort · ${item.model.name ?? item.model.id}`}
        options={[
          { value: "", title: "Default", onSelect: () => confirm(selected) },
          ...variants.map((variant) => ({
            value: variant,
            title: variant,
            onSelect: () => confirm({ ...selected, variant }),
          })),
        ]}
        current={current && variants.includes(current) ? current : ""}
        flat={true}
      />
    ))
  }

  return (
    <DialogSelect
      title="Compact session · select model"
      placeholder="Search compaction models"
      options={
        ready()
          ? models().map((item) => ({
              value: `${item.provider.id}/${item.model.id}`,
              title: item.model.name ?? item.model.id,
              description: item.provider.name,
              onSelect: () => choose(item),
            }))
          : error()
            ? [
                {
                  value: "retry",
                  title: "Retry loading compaction preference",
                  description: error(),
                  onSelect: () => void load(),
                },
              ]
            : []
      }
      current={preferred() ? `${preferred()!.providerID}/${preferred()!.modelID}` : undefined}
      emptyView={<text>{ready() ? "No connected text models available" : "Loading compaction preference…"}</text>}
      footer={<text>Selected model applies to manual and automatic compaction, including Duo agents.</text>}
      flat={true}
    />
  )
}
