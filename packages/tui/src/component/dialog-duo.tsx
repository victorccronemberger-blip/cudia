import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useKV } from "../context/kv"

export type DuoParticipant = {
  name: string
  model: string
  variant?: string
  agent?: string
}

export type DuoPair = {
  participants: [DuoParticipant, DuoParticipant]
  review: boolean
  peerChars: number
}

const preferenceKey = "duo_participants"

export function DialogDuo(props: {
  hasObjective: boolean
  onConfirm: (pair: DuoPair) => void
  onSaveOnly: () => void
  initialPair?: DuoPair
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const kv = useKV()
  const [pair, setPair] = createSignal<DuoPair>()
  const [error, setError] = createSignal<string>()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  onMount(async () => {
    if (props.initialPair) {
      setPair(props.initialPair)
      return
    }
    try {
      const result = await sdk.client.duo.settings()
      if (disposed) return
      if (result.error) {
        setError("Could not load Duo settings")
        return
      }
      const settings = result.data
      const saved = kv.get(preferenceKey) as unknown
      const cached =
        Array.isArray(saved) && saved.length === 2 && saved.every(isParticipant)
          ? (saved as DuoParticipant[])
          : undefined
      const participant = (value: (typeof settings.participants)[number]): DuoParticipant => ({
        ...value,
        variant: value.variant ?? undefined,
        agent: value.agent ?? undefined,
      })
      setPair({
        ...settings,
        peerChars: Number(settings.peerChars),
        participants: [
          participant(cached?.[0] ?? settings.participants[0]),
          participant(cached?.[1] ?? settings.participants[1]),
        ],
      })
    } catch {
      if (!disposed) setError("Could not load Duo settings")
    }
  })

  const agents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))

  function modelInfo(model: string) {
    const [providerID, ...modelID] = model.split("/")
    const provider = sync.data.provider.find((item) => item.id === providerID)
    const id = modelID.join("/")
    const info = provider?.models[id]
    if (!provider || !info) return
    return { provider, id, info }
  }

  function valid(participant: DuoParticipant) {
    const model = modelInfo(participant.model)
    if (!model) return false
    if (participant.agent && !agents().some((agent) => agent.name === participant.agent)) return false
    if (participant.variant && !model.info.variants?.[participant.variant]) return false
    return true
  }

  function withParticipant(index: 0 | 1, value: Partial<DuoParticipant>) {
    const current = pair()
    if (!current) return
    const next = [...current.participants] as [DuoParticipant, DuoParticipant]
    next[index] = { ...next[index], ...value }
    return { ...current, participants: next }
  }

  function reopen(next: DuoPair) {
    dialog.replace(() => <DialogDuo {...props} initialPair={next} />)
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const current = pair()
    if (!current) return []
    const firstAgent = agents().find((agent) => agent.name === current.participants[0].agent)
    const coordinator =
      firstAgent && ["all", "primary"].includes(firstAgent.mode)
        ? firstAgent.name
        : (local.agent.current()?.name ?? "current chat agent")
    const options: DialogSelectOption<string>[] = current.participants.flatMap((participant, index) => {
      const model = modelInfo(participant.model)
      const number = index + 1
      const title = `${number === 1 ? "Coordinator candidate" : "Participant 2"} · ${participant.name}`
      return [
        {
          value: `model:${index}`,
          title: `${title} model`,
          description: model ? `${model.provider.name} / ${model.info.name ?? model.id}` : "Needs selection",
          onSelect: () => chooseModel(index as 0 | 1),
        },
        {
          value: `variant:${index}`,
          title: `${title} variant`,
          description:
            model && (!participant.variant || model.info.variants?.[participant.variant])
              ? (participant.variant ?? "Default")
              : `Needs selection${participant.variant ? ` (${participant.variant} is unavailable)` : ""}`,
          onSelect: () => chooseVariant(index as 0 | 1),
        },
        {
          value: `agent:${index}`,
          title: `${title} agent`,
          description:
            !participant.agent || agents().some((agent) => agent.name === participant.agent)
              ? (participant.agent ?? "Configured default")
              : `Needs selection (${participant.agent} is unavailable)`,
          onSelect: () => chooseAgent(index as 0 | 1),
        },
      ]
    })
    options.push({
      value: "confirm",
      title: props.hasObjective ? "Start Duo with these participants" : "Save Duo choices",
      description: `Coordinator: ${coordinator}`,
      disabled: !current.participants.every(valid),
      onSelect: () => {
        kv.set(preferenceKey, current.participants)
        dialog.clear()
        if (props.hasObjective) props.onConfirm(current)
        else props.onSaveOnly()
      },
    })
    return options
  })

  function chooseModel(index: 0 | 1) {
    const current = pair()
    if (!current) return
    const options = sync.data.provider.flatMap((provider) =>
      Object.entries(provider.models)
        .filter(([, model]) => model.status !== "deprecated")
        .map(([id, model]) => ({
          value: `${provider.id}/${id}`,
          title: model.name ?? id,
          description: provider.name,
          category: provider.name,
        })),
    )
    dialog.replace(() => (
      <DialogSelect
        options={options.map((option) => ({
          ...option,
          onSelect: () => {
            const variant = current.participants[index].variant
            const next = withParticipant(index, {
              model: option.value,
              name: option.title,
              variant: variant && modelInfo(option.value)?.info.variants?.[variant] ? variant : undefined,
            })
            if (next) reopen(next)
          },
        }))}
        title={`Select model · participant ${index + 1}`}
        current={current.participants[index].model}
        flat={true}
      />
    ))
  }

  function chooseVariant(index: 0 | 1) {
    const current = pair()
    if (!current) return
    const participant = current.participants[index]
    const model = modelInfo(participant.model)
    const variants = Object.keys(model?.info.variants ?? {})
    const options = [
      { value: "", title: "Default" },
      ...variants.map((variant) => ({ value: variant, title: variant })),
    ]
    dialog.replace(() => (
      <DialogSelect
        options={options.map((option) => ({
          ...option,
          onSelect: () => {
            const next = withParticipant(index, { variant: option.value || undefined })
            if (next) reopen(next)
          },
        }))}
        title={`Select variant · participant ${index + 1}`}
        current={participant.variant ?? ""}
        flat={true}
      />
    ))
  }

  function chooseAgent(index: 0 | 1) {
    const current = pair()
    if (!current) return
    const options = [
      { value: "", title: "Configured default" },
      ...agents().map((agent) => ({
        value: agent.name,
        title: agent.name,
        description: agent.mode,
      })),
    ]
    dialog.replace(() => (
      <DialogSelect
        options={options.map((option) => ({
          ...option,
          onSelect: () => {
            const next = withParticipant(index, { agent: option.value || undefined })
            if (next) reopen(next)
          },
        }))}
        title={`Select agent · participant ${index + 1}`}
        current={current.participants[index].agent ?? ""}
        flat={true}
      />
    ))
  }

  // Keep a renderable at the root: nested Show accessors make the dialog
  // factory subscribe to pair(), remounting this component when settings load.
  return (
    <DialogSelect
      options={options()}
      title="Configure Duo"
      flat={true}
      emptyView={<text>{error() ?? "Loading Duo settings…"}</text>}
    />
  )
}

function isParticipant(value: unknown): value is DuoParticipant {
  if (typeof value !== "object" || value === null) return false
  return (
    "name" in value &&
    typeof value.name === "string" &&
    "model" in value &&
    typeof value.model === "string" &&
    (!("variant" in value) || typeof value.variant === "string" || value.variant === null) &&
    (!("agent" in value) || typeof value.agent === "string" || value.agent === null)
  )
}
