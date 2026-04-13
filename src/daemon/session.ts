import * as path from "path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
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
import type { ToolCallInfo, ContentBlock } from "../components/MessageList";

export interface SessionDisplayMessage {
  role: "user" | "assistant";
  content: string;
  source?: "feishu" | "tui";
  toolCalls?: ToolCallInfo[];
  blocks?: ContentBlock[];
}

export interface StreamEvent {
  type: "stream_delta" | "stream_tool" | "stream_end" | "stream_start";
  text?: string;
  name?: string;
  args?: string;
  status?: "running" | "done";
  fullText?: string;
  toolCalls?: ToolCallInfo[];
  blocks?: ContentBlock[];
}

export type StreamCallback = (event: StreamEvent) => void;

function buildSystemPrompt(config: FrailConfig): string {
  const hasLinear = !!config.mcpServers?.linear;

  const base = `You are Frail, a technical assistant that receives user-reported problems, helps analyze and resolve them, and tracks confirmed issues.

## Response Rules

1. **Extremely brief** — Every reply must be as short as possible. State the key point directly. No code snippets, no file paths, no verbose explanations. If the answer is one sentence, don't write two.
2. **Research before responding** — You MUST thoroughly read and investigate the codebase before every reply. Read all relevant files, trace the full call chain, search broadly. Any reply not backed by actual code investigation is unacceptable. Think deeply and long enough to fully understand the problem before answering.
3. **Respond in the same language the user uses.**

## Core Workflow

Users will describe various problems: bugs, unexpected behavior, errors, feature requests, etc. Follow this workflow:

1. **Clarify** — If the problem description is vague or incomplete, ask targeted questions.
2. **Diagnose** — Extensively read code, search the codebase, trace logic. Never guess — always verify against the actual code first.
3. **Conclude** — State your finding in one or two sentences. Confirmed problem, misunderstanding, or needs more info.
4. **Record** — If the problem is confirmed or the user asks you to track it, create a Linear issue.

## Project Context

Project root: ${config.workDir}
${hasLinear ? `
## Linear — Issue Tracking

You have Linear MCP tools available. **Actively use them** — they are your primary way to record and manage work items.

### When to create an issue
- You confirmed a real bug or problem through investigation
- The user reports a feature request or enhancement
- The user explicitly asks to record/track/create a ticket
- The user describes a TODO, requirement, or task they want tracked

### When NOT to create an issue
- You're still diagnosing and haven't confirmed anything yet
- The problem turns out to be a misunderstanding or user error (explain instead)
- It's a simple question you can answer directly

### How to use Linear tools
- **Search first** — before creating, search existing issues to avoid duplicates
- **Create with context** — use a clear title describing the problem, include steps to reproduce, error messages, relevant code paths
- **Share the result** — after creating, tell the user the issue title and identifier
- **Update existing issues** — when new information is discovered during conversation, update the relevant issue
- **List issues** — when the user asks about backlog, current tasks, or priorities
` : ''}`;

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

function buildCanUseTool(workDir: string) {
  const resolved = path.resolve(workDir);

  return async (
    toolName: string,
    input: Record<string, unknown>,
    _options: {
      signal: AbortSignal;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
    // Check file_path (Read), path (Glob/Grep), command (Bash)
    const filePath = (input.file_path ?? input.path ?? "") as string;
    if (filePath) {
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(resolved, filePath);
      const resolvedPath = path.resolve(abs);
      if (!resolvedPath.startsWith(resolved + "/") && resolvedPath !== resolved) {
        return { behavior: "deny", message: `Access denied: ${filePath} is outside workDir` };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}

function buildCommonOptions(config: FrailConfig) {
  return {
    model: config.provider.model,
    systemPrompt: buildSystemPrompt(config),
    env: buildEnv(config),
    cwd: config.workDir,
    tools: ["Bash", "Read", "Glob", "Grep"] as string[],
    allowedTools: [] as string[],  // empty → all tools go through canUseTool
    permissionMode: "default" as const,
    canUseTool: buildCanUseTool(config.workDir),
    disallowedTools: [
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "mcp__claude_ai_Gmail__authenticate",
      "mcp__claude_ai_Google_Calendar__authenticate",
    ],
    thinking: { type: "enabled" as const },
    mcpServers: Object.keys(config.mcpServers).length > 0 ? config.mcpServers : {},
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyWrite: ["/**"],
      },
    },
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
  private lastMcpStatus: "connected" | "failed" | "unknown" = "unknown";
  private lastMcpError: string | null = null;
  private monitorQuery: Query | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

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
        blocks: m.blocks ? JSON.parse(m.blocks) : undefined,
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

  getMcpStatus(): { status: string; error: string | null } {
    return { status: this.lastMcpStatus, error: this.lastMcpError };
  }

  private async ensureMcpConnected(q: Query): Promise<boolean> {
    const log = getLogger();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const statuses = await q.mcpServerStatus();
        const linear = statuses.find((s) => s.name === "linear");
        if (linear?.status === "connected") {
          this.lastMcpStatus = "connected";
          this.lastMcpError = null;
          return true;
        }
        // Status is not connected — attempt reconnection
        log.warn("MCP", `Linear status: ${linear?.status ?? "not found"} (attempt ${attempt + 1}/3), reconnecting...`);
        await q.reconnectMcpServer("linear");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastMcpError = msg;
        log.error("MCP", `Reconnect attempt ${attempt + 1}/3 failed: ${msg}`);
      }
      if (attempt < 2) await Bun.sleep(1000 * (attempt + 1));
    }
    this.lastMcpStatus = "failed";
    return false;
  }

  private startMonitor(): void {
    this.stopMonitor();
    if (!this.config.mcpServers.linear || !this.monitorQuery) return;

    const log = getLogger();
    this.monitorTimer = setInterval(async () => {
      if (!this.monitorQuery) return;
      try {
        const statuses = await this.monitorQuery.mcpServerStatus();
        const linear = statuses.find((s) => s.name === "linear");
        const prev = this.lastMcpStatus;

        if (linear?.status === "connected") {
          this.lastMcpStatus = "connected";
          this.lastMcpError = null;
          if (prev !== "connected") {
            log.info("MCP", "Linear MCP reconnected");
          }
        } else {
          log.warn("MCP", `Linear MCP status: ${linear?.status ?? "not found"}, attempting reconnect...`);
          try {
            await this.monitorQuery.reconnectMcpServer("linear");
            this.lastMcpStatus = "connected";
            this.lastMcpError = null;
            log.info("MCP", "Linear MCP reconnected via monitor");
          } catch (err) {
            this.lastMcpStatus = "failed";
            this.lastMcpError = err instanceof Error ? err.message : String(err);
            log.error("MCP", `Monitor reconnect failed: ${this.lastMcpError}`);
          }
        }
      } catch {
        // Query object is no longer valid — clean up
        this.monitorQuery = null;
        this.stopMonitor();
      }
    }, 30_000);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  destroy(): void {
    this.stopMonitor();
    if (this.monitorQuery) {
      this.monitorQuery.close();
      this.monitorQuery = null;
    }
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

      const blocks: ContentBlock[] = [];

      // Close previous monitor query — new query takes over
      if (this.monitorQuery) {
        this.monitorQuery.close();
        this.monitorQuery = null;
      }
      this.stopMonitor();

      const q = query({
        prompt: text,
        options: {
          ...buildCommonOptions(this.config),
          persistSession: true,
          sessionId: isResume ? undefined : this.sessionId,
          resume: isResume ? this.sessionId : undefined,
          includePartialMessages: true,
        },
      });

      // Gate on MCP health — block if Linear is configured but not connected
      if (this.config.mcpServers.linear) {
        const ok = await this.ensureMcpConnected(q);
        if (!ok) {
          q.close();
          const errorMsg = `Linear MCP 连接失败: ${this.lastMcpError || "无法连接"}。正在自动重试，请稍后再发送消息。`;
          blocks.push({ type: "text", text: errorMsg });
          log.error("Session", `Chat blocked: Linear MCP unavailable`);

          // Don't record failed attempt to history — pop the user message we just added
          this.history.pop();

          onStream?.({ type: "stream_end", fullText: errorMsg, toolCalls: [], blocks });
          this.busy = false;
          return errorMsg;
        }
      }

      try {
        for await (const msg of q) {
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
                  blocks.push({ type: "tool", toolCall: tc });
                  onStream?.({
                    type: "stream_tool",
                    name: tc.name,
                    args: tc.args,
                    status: "running",
                  });
                } else if (block?.type === "text") {
                  blocks.push({ type: "text", text: "" });
                }
              }

              if (event.type === "content_block_delta" && "delta" in event) {
                const delta = event.delta;
                if (delta.type === "text_delta") {
                  const text = (delta as any).text;
                  const last = blocks[blocks.length - 1];
                  if (last && last.type === "text") {
                    last.text += text;
                  } else {
                    blocks.push({ type: "text", text });
                  }
                  onStream?.({ type: "stream_delta", text });
                }
              }

              if (event.type === "content_block_stop") {
                const last = blocks[blocks.length - 1];
                if (last?.type === "tool" && last.toolCall.status === "running") {
                  last.toolCall.status = "done";
                  onStream?.({
                    type: "stream_tool",
                    name: last.toolCall.name,
                    args: last.toolCall.args,
                    status: "done",
                  });
                }
              }
              break;
            }
            case "assistant": {
              const content = msg.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_use") {
                    const existing = blocks.find(
                      (b) => b.type === "tool" && b.toolCall.name === block.name && b.toolCall.status === "running"
                    );
                    if (existing && existing.type === "tool") {
                      existing.toolCall.args = summarizeArgs(block.input);
                      existing.toolCall.status = "done";
                    }
                  }
                }
              }
              break;
            }
            case "result": {
              if ("subtype" in msg && msg.subtype === "success") {
                const resultText = (msg as any).result;
                if (resultText) {
                  const lastText = [...blocks].reverse().find((b) => b.type === "text");
                  if (lastText && lastText.type === "text") {
                    lastText.text = resultText;
                  } else {
                    blocks.push({ type: "text", text: resultText });
                  }
                }
              } else if ("is_error" in msg && (msg as any).is_error) {
                blocks.push({ type: "text", text: `Error: ${(msg as any).error ?? "Unknown error"}` });
              }
              break;
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errorText = errMsg.includes("API key")
          ? `Error: ${errMsg}\n\nRun 'frail init' to configure your API key.`
          : `Error: ${errMsg}`;
        blocks.push({ type: "text", text: errorText });
        log.error("Session", `Error: ${errMsg}`);
      }

      // Keep query alive as MCP monitor
      this.monitorQuery = q;
      this.startMonitor();

      // Derive fullText and toolCalls from blocks for backward compat
      const fullText = blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      const toolCalls = blocks
        .filter((b): b is Extract<ContentBlock, { type: "tool" }> => b.type === "tool")
        .map((b) => b.toolCall);

      // Mark remaining running tools as done
      for (const tc of toolCalls) {
        if (tc.status === "running") tc.status = "done";
      }

      // Record assistant message
      const assistantMsg: SessionDisplayMessage = {
        role: "assistant",
        content: fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        blocks: blocks.length > 0 ? blocks : undefined,
      };
      this.history.push(assistantMsg);
      this.messageCount++;

      addSessionMessage(
        this.sessionId,
        "assistant",
        fullText,
        source,
        toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined,
        blocks.length > 0 ? JSON.stringify(blocks) : undefined
      );

      onStream?.({ type: "stream_end", fullText, toolCalls, blocks });

      log.info("Session", `Assistant: ${fullText.slice(0, 100)}${fullText.length > 100 ? "..." : ""}`);

      this.busy = false;
      return fullText;
    });
  }

  resetSession(): void {
    const log = getLogger();
    this.destroy();
    clearSessionMessages(this.sessionId);
    this.sessionId = crypto.randomUUID();
    this.messageCount = 0;
    this.history = [];
    this.lastMcpStatus = "unknown";
    this.lastMcpError = null;
    setDaemonState("session_id", this.sessionId);
    log.info("Session", `Reset to new session ${this.sessionId}`);
  }
}
