import type { SessionV1 } from "@opencode-ai/core/v1/session"

export function isGoalControl(message: SessionV1.WithParts): boolean {
  return message.parts.some((part) => part.type === "text" && part.metadata?.goalControl === true)
}

export function operationalMessages(messages: SessionV1.WithParts[]): SessionV1.WithParts[] {
  return messages.filter((message) => !isGoalControl(message))
}
