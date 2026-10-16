export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { MCPTool } from "./mcp"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { LSPTool } from "./lsp"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { ToolResultTool } from "./tool-result"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP tools use separate Session-scoped canonical registrations, while
 * plugin registration remains a separate integration. Current
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep dynamic MCP
 * registrations and plugin transforms separate from this static built-in list.
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    LSPTool.node,
    MCPTool.node,
    QuestionTool.node,
    ReadTool.node,
    SkillTool.node,
    TodoWriteTool.node,
    ToolResultTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
  ],
})
