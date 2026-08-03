import { spawn } from "node:child_process";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "claude-collab";
const SERVER_VERSION = "0.1.0";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const cliPath = process.env.CLAUDE_CLI_PATH || "claude";

function subscriptionEnvironment() {
  const env = { ...process.env };

  // This bridge is intentionally tied to the user's Claude subscription.
  // Removing provider/API overrides prevents an accidental PAYG invocation.
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    delete env[name];
  }

  return env;
}

function commonArgs({ model, effort, maxTurns }) {
  return [
    "--safe-mode",
    "--strict-mcp-config",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
    "--effort",
    effort,
  ];
}

function runClaude(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: process.cwd(),
      env: subscriptionEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(reject, new Error("Claude output exceeded the 2 MiB bridge limit."));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });

    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();

      if (code !== 0) {
        finish(
          reject,
          new Error(`Claude Code exited with ${code}.${err ? ` ${err}` : ""}`),
        );
        return;
      }

      try {
        finish(resolve, JSON.parse(out));
      } catch {
        finish(reject, new Error(`Claude Code returned invalid JSON: ${out.slice(0, 500)}`));
      }
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Claude Code timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
}

function asToolResult(payload) {
  const result = payload.result ?? payload.structured_output ?? "";
  const sessionId = payload.session_id ?? payload.sessionId ?? "";
  const usage = payload.usage ? `\nusage: ${JSON.stringify(payload.usage)}` : "";

  return {
    content: [
      {
        type: "text",
        text: `session_id: ${sessionId}\n\n${String(result)}${usage}`,
      },
    ],
    structuredContent: {
      sessionId,
      result,
      usage: payload.usage ?? null,
    },
  };
}

function asErrorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

const consultationShape = {
  prompt: z.string().min(1).describe("Question or review task for Claude."),
  model: z.enum(["sonnet", "opus", "haiku"]).default("sonnet"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  max_turns: z.number().int().min(1).max(24).default(8),
};

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Consult Claude as a read-only peer for independent analysis or review. " +
      "Do not send secrets. Claude may read the current workspace but cannot edit or run shell commands.",
  },
);

server.registerTool(
  "ask_claude",
  {
    title: "Ask Claude",
    description: "Start a read-only Claude Code consultation and return its session_id.",
    inputSchema: consultationShape,
  },
  async ({ prompt, model, effort, max_turns: maxTurns }) => {
    try {
      const payload = await runClaude([
        ...commonArgs({ model, effort, maxTurns }),
        "-p",
        prompt,
      ]);
      return asToolResult(payload);
    } catch (error) {
      return asErrorResult(error);
    }
  },
);

server.registerTool(
  "reply_claude",
  {
    title: "Reply to Claude",
    description: "Continue a prior read-only Claude consultation by session_id.",
    inputSchema: {
      session_id: z.string().uuid(),
      ...consultationShape,
    },
  },
  async ({ session_id: sessionId, prompt, model, effort, max_turns: maxTurns }) => {
    try {
      const payload = await runClaude([
        ...commonArgs({ model, effort, maxTurns }),
        "--resume",
        sessionId,
        "-p",
        prompt,
      ]);
      return asToolResult(payload);
    } catch (error) {
      return asErrorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
