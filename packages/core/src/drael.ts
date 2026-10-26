import type { ModelsDev } from "./models-dev"

// Built-in fallback metadata for https://drael.sh/docs. The paid Pro plan
// publishes 131072 context tokens; users can override limits for their account.
export const drael: ModelsDev.Provider = {
  id: "drael",
  name: "Drael",
  api: "https://drael.sh/v1",
  npm: "@ai-sdk/openai-compatible",
  env: ["DRAEL_KEY", "DRAEL_API_KEY"],
  models: {
    "drael-v1": {
      id: "drael-v1",
      name: "Drael V1",
      release_date: "",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 131072, output: 8192 },
    },
  },
}
