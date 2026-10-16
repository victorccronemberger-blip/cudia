export * as AgentPlugin from "./agent"

import { define } from "./internal"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { HarnessPolicy } from "../harness/policy"

const BUILD_SYSTEM = HarnessPolicy.BASE

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_COMPACTION = `You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary matching the format specified so another coding agent can continue the work.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not continue the conversation. Do not respond to any questions in the conversation. Only output the structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation.`

const PROMPT_TITLE =
  "Generate one concise title for finding this conversation later, in the operator's language. Preserve relevant names and technical identifiers. Return the title on one line."

const PROMPT_SUMMARY =
  "Summarize the work completed in this conversation in two or three concise sentences. Include concrete changes, relevant verification, unresolved work, and pending requests needed for continuity. Use the conversation's language."

export const Plugin = define({
  id: "agent",
  effect: Effect.fn(function* (ctx) {
    const defaults: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]

    yield* ctx.agent.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.description = "The default agent. Follows the operator's instructions using available tools."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(...defaults)
      })

      draft.update(AgentV2.ID.make("plan"), (item) => {
        item.description = "Planning agent for the operator's requested work."
        item.mode = "primary"
        item.permissions.push(...defaults)
      })

      draft.update(AgentV2.ID.make("general"), (item) => {
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        item.mode = "subagent"
        item.permissions.push(...defaults)
      })

      draft.update(AgentV2.ID.make("explore"), (item) => {
        item.description = "Explore code and report findings for the operator's objective."
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(...defaults)
      })

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
        item.permissions.push(...defaults)
      })

      draft.update(AgentV2.ID.make("title"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...defaults)
      })

      draft.update(AgentV2.ID.make("summary"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...defaults)
      })
    })
  }),
})
