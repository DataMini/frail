import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FrailConfig } from "../config/schema";
import {
  getDaemonState,
  setDaemonState,
  addSessionMessage,
  getSessionMessages,
  clearSessionMessages,
  getSessionMessageCount,
} from "../db/threads";
import { getLogger } from "./logger";
import type { ToolCallInfo } from "../components/MessageList";

export interface SessionDisplayMessage {
  role: "user" | "assistant";
  content: string;
  source?: "feishu" | "tui";
  toolCalls?: ToolCallInfo[];
}

export interface StreamEvent {
  type: "stream_delta" | "stream_tool" | "stream_end" | "stream_start";
  text?: string;
  name?: string;
  args?: string;
  status?: "running" | "done";
  fullText?: string;
  toolCalls?: ToolCallInfo[];
}

export type StreamCallback = (event: StreamEvent) => void;

function buildSystemPrompt(config: FrailConfig): string {
  const base = `You are an interactive coding assistant.

You have EXACTLY 3 tools: Read, Glob, Grep. You have NO other tools. Do NOT mention Bash, Edit, Write, Agent, Gmail, Google Calendar, or any tool not listed here.

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

function buildCommonOptions(config: FrailConfig) {
  return {
    model: config.provider.model,
    systemPrompt: buildSystemPrompt(config),
    env: buildEnv(config),
    cwd: config.workDir,
    maxTurns: config.agent.maxTurns,
    tools: ["Read", "Glob", "Grep"] as string[],
    allowedTools: ["Read", "Glob", "Grep"] as string[],
    permissionMode: "bypassPermissions" as const,
    disallowedTools: [
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "mcp__claude_ai_Gmail__authenticate",
      "mcp__claude_ai_Google_Calendar__authenticate",
    ],
    thinking: { type: "disabled" as const },
    mcpServers: Object.keys(config.mcpServers).length > 0 ? config.mcpServers : {},
  };
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const str = typeof v === "string" ? v : JSON.stringify(v);
    const truncated = str.length > 60 ? str.slice(0, 60) + "..." : str;
    parts.push(truncated);
    if (parts.length >= 2) break;
  }
  return parts.join(", ");
}

export class AgentSession {
  private config: FrailConfig;
  private sessionId: string;
  private messageCount: number;
  private history: SessionDisplayMessage[];
  private lock: Promise<void> = Promise.resolve();
  private busy = false;

  constructor(config: FrailConfig) {
    this.config = config;

    // Load session ID from DB or create new
    const savedId = getDaemonState("session_id");
    if (savedId) {
      this.sessionId = savedId;
      // Load history from DB
      const saved = getSessionMessages(savedId);
      this.history = saved.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        source: m.source as "feishu" | "tui",
        toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      }));
      this.messageCount = getSessionMessageCount(savedId);
      getLogger().info("Session", `Resumed session ${savedId} with ${this.messageCount} messages`);
    } else {
      this.sessionId = crypto.randomUUID();
      this.history = [];
      this.messageCount = 0;
      setDaemonState("session_id", this.sessionId);
      getLogger().info("Session", `Created new session ${this.sessionId}`);
    }
  }

  isBusy(): boolean {
    return this.busy;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  getHistory(): SessionDisplayMessage[] {
    return [...this.history];
  }

  getConfig(): FrailConfig {
    return this.config;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let resolve: (v: T) => void;
    let reject: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.lock = prev.then(() => fn().then(resolve!, reject!)).catch(() => {});
    return result;
  }

  async chat(
    text: string,
    source: "feishu" | "tui",
    onStream?: StreamCallback
  ): Promise<string> {
    return this.withLock(async () => {
      this.busy = true;
      const log = getLogger();
      const isResume = this.messageCount > 0;

      // Record user message
      const userMsg: SessionDisplayMessage = { role: "user", content: text, source };
      this.history.push(userMsg);
      addSessionMessage(this.sessionId, "user", text, source);

      log.info("Session", `[${source}] User: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

      onStream?.({ type: "stream_start" });

      let fullText = "";
      const toolCalls: ToolCallInfo[] = [];

      try {
        for await (const msg of query({
          prompt: text,
          options: {
            ...buildCommonOptions(this.config),
            persistSession: true,
            sessionId: isResume ? undefined : this.sessionId,
            resume: isResume ? this.sessionId : undefined,
            includePartialMessages: true,
          },
        })) {
          switch (msg.type) {
            case "stream_event": {
              const event = msg.event;

              if (event.type === "content_block_start") {
                const block = (event as any).content_block;
                if (block?.type === "tool_use") {
                  const tc: ToolCallInfo = {
                    name: block.name,
                    args: summarizeArgs(block.input),
                    status: "running",
                  };
                  toolCalls.push(tc);
                  onStream?.({
                    type: "stream_tool",
                    name: tc.name,
                    args: tc.args,
                    status: "running",
                  });
                }
              }

              if (event.type === "content_block_delta" && "delta" in event) {
                const delta = event.delta;
                if (delta.type === "text_delta") {
                  fullText += (delta as any).text;
                  onStream?.({ type: "stream_delta", text: (delta as any).text });
                }
              }

              if (event.type === "content_block_stop") {
                if (toolCalls.length > 0) {
                  const last = toolCalls[toolCalls.length - 1]!;
                  if (last.status === "running") {
                    last.status = "done";
                    onStream?.({
                      type: "stream_tool",
                      name: last.name,
                      args: last.args,
                      status: "done",
                    });
                  }
                }
              }
              break;
            }
            case "assistant": {
              const content = msg.message?.content;
              if (Array.isArray(content)) {
                let msgText = "";
                for (const block of content) {
                  if (block.type === "text") {
                    msgText = block.text;
                  } else if (block.type === "tool_use") {
                    const existing = toolCalls.find(
                      (tc) => tc.name === block.name && tc.status === "running"
                    );
                    if (existing) {
                      existing.args = summarizeArgs(block.input);
                      existing.status = "done";
                    } else {
                      toolCalls.push({
                        name: block.name,
                        args: summarizeArgs(block.input),
                        status: "done",
                      });
                    }
                  }
                }
                if (msgText) fullText = msgText;
              }
              break;
            }
            case "result": {
              if ("subtype" in msg && msg.subtype === "success") {
                fullText = (msg as any).result;
              } else if ("is_error" in msg && (msg as any).is_error) {
                fullText = `Error: ${(msg as any).error ?? "Unknown error"}`;
              }
              break;
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("API key")) {
          fullText = `Error: ${errMsg}\n\nRun 'frail init' to configure your API key.`;
        } else {
          fullText = fullText
            ? fullText + `\n\nError: ${errMsg}`
            : `Error: ${errMsg}`;
        }
        log.error("Session", `Error: ${errMsg}`);
      }

      // Mark remaining running tools as done
      for (const tc of toolCalls) {
        if (tc.status === "running") tc.status = "done";
      }

      // Record assistant message
      const assistantMsg: SessionDisplayMessage = {
        role: "assistant",
        content: fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      this.history.push(assistantMsg);
      this.messageCount++;

      addSessionMessage(
        this.sessionId,
        "assistant",
        fullText,
        source,
        toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined
      );

      onStream?.({ type: "stream_end", fullText, toolCalls });

      log.info("Session", `Assistant: ${fullText.slice(0, 100)}${fullText.length > 100 ? "..." : ""}`);

      this.busy = false;
      return fullText;
    });
  }

  resetSession(): void {
    const log = getLogger();
    clearSessionMessages(this.sessionId);
    this.sessionId = crypto.randomUUID();
    this.messageCount = 0;
    this.history = [];
    setDaemonState("session_id", this.sessionId);
    log.info("Session", `Reset to new session ${this.sessionId}`);
  }
}
