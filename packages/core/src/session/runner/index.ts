export * as SessionRunner from "./index"

import type { LLMError } from "@opencode-ai/llm"
import { Context, Effect } from "effect"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { ToolOutputStore } from "../../tool-output-store"
import type { SessionInput } from "../input"
import type { SessionCompaction } from "../compaction"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error

/** Process-local control state only; history and requests are rebuilt after a yield. */
export type Continuation = {
  readonly promotion: SessionInput.Delivery | undefined
  readonly step: number
}

export type CompactError = RunError | SessionCompaction.Error

export type RunInput = {
  readonly sessionID: SessionSchema.ID
  readonly force: boolean
  readonly shouldYield?: () => boolean
  readonly continuation?: Continuation
}

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: RunInput) => Effect.Effect<void | { readonly continuation: Continuation }, RunError>
  /** Summarizes a settled snapshot without promoting inbox inputs or generating a normal assistant turn. */
  readonly compact: (input: {
    readonly sessionID: SessionSchema.ID
    readonly focus?: string
  }) => Effect.Effect<void, CompactError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunner") {}
