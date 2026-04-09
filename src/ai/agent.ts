import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config/loader";
import type { FrailConfig } from "../config/schema";

function buildSystemPrompt(config: FrailConfig): string {
  const hasMcp = Object.keys(config.mcpServers).length > 0;

  const toolSection = hasMcp
    ? `You have the following built-in tools: Read, Glob, Grep.
You also have access to tools provided by MCP servers. Use them when relevant to the user's request.
Do NOT mention Bash, Edit, Write, Agent, Gmail, Google Calendar, or any tool not explicitly available to you.`
    : `You have EXACTLY 3 tools: Read, Glob, Grep. You have NO other tools. Do NOT mention Bash, Edit, Write, Agent, Gmail, Google Calendar, or any tool not listed here.`;

  const base = `You are an interactive coding assistant.

${toolSection}

Responsibilities:
1. Answer coding, architecture, debugging questions.
2. Analyze code by reading files and searching the codebase.
3. Keep responses concise and readable.

Project root: ${config.workDir}

Respond in the same language the user uses.`;

  if (config.systemPrompt) {
    return `${base}\n\n--- User Custom Instructions ---\n${config.systemPrompt}`;
  }
  return base;
}

function buildEnv(config: FrailConfig): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(config.provider.baseURL && {
      ANTHROPIC_BASE_URL: config.provider.baseURL,
    }),
    ...(config.provider.apiKey && {
      ANTHROPIC_AUTH_TOKEN: config.provider.apiKey,
    }),
  };
}

function buildQueryOptions(config: FrailConfig) {
  const mcpServerNames = Object.keys(config.mcpServers);
  const mcpAllowedPatterns = mcpServerNames.map((name) => `mcp__${name}__*`);

  return {
    model: config.provider.model,
    systemPrompt: buildSystemPrompt(config),
    env: buildEnv(config),
    cwd: config.workDir,
    maxTurns: config.agent.maxTurns,
    tools: ["Read", "Glob", "Grep"] as string[],
    allowedTools: ["Read", "Glob", "Grep", ...mcpAllowedPatterns],
    permissionMode: "bypassPermissions" as const,
    disallowedTools: [
      "Bash", "Edit", "Write", "NotebookEdit",
      "WebFetch", "WebSearch",
      "mcp__claude_ai_Gmail__authenticate",
      "mcp__claude_ai_Google_Calendar__authenticate",
    ],
    thinking: { type: "disabled" as const },
    persistSession: false,
    mcpServers: config.mcpServers as Record<string, any>,
  };
}

/** Streaming chat for TUI — returns async generator of SDKMessage */
export function streamChat(prompt: string): AsyncGenerator<SDKMessage, void> {
  const config = getConfig();

  return query({
    prompt,
    options: {
      ...buildQueryOptions(config),
      includePartialMessages: true,
    },
  });
}

/** Non-streaming chat for Feishu — returns final text */
export async function generateChat(prompt: string): Promise<string> {
  const config = getConfig();

  let result = "";

  for await (const msg of query({
    prompt,
    options: buildQueryOptions(config),
  })) {
    if (msg.type === "result" && "subtype" in msg && msg.subtype === "success") {
      result = msg.result;
    }
  }

  return result;
}
