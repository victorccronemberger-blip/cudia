import { Duration, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { callWebSearchMcp } from "@opencode-ai/core/tool/web-search-mcp"

export const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const ParallelSearchArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.optional(Schema.String),
  model_name: Schema.optional(Schema.String),
})

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
  headers?: Record<string, string>,
) => callWebSearchMcp({ http, url, tool, args, value, timeout, headers })
