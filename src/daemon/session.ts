import * as path from "path";
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

## Linear — Issue Tracking

You have the \`linear\` CLI available via Bash. For advanced options, run \`linear <command> --help\`.

### Common commands

**Query & View**
- \`linear issue mine\` — list your assigned issues (\`-s started\`, \`--all-states\`, \`--team\`, \`--project\`, \`--label\`)
- \`linear issue query --search "keyword"\` — search issues (\`--team\`, \`--state\`, \`--label\`, \`--assignee\`, \`--all-teams\`)
- \`linear issue view <id>\` — view issue details (\`--json\` for structured output, \`--no-comments\` to skip comments)
- \`linear issue url <id>\` — get issue URL
- \`linear team list\` / \`linear project list\` — list teams / projects

**Create & Update**
- \`linear issue create -t "Title" -d "Desc"\` — create issue (\`-p 1-4\` priority, \`-l label\`, \`--project\`, \`--team\`, \`-a self\`)
- \`linear issue update <id>\` — update issue (\`-s state\`, \`-t title\`, \`-d desc\`, \`-a assignee\`, \`-p priority\`)
- \`linear issue delete <id>\` — delete issue

**Comments**
- \`linear issue comment add <id> -b "text"\` — add comment
- \`linear issue comment list <id>\` — list comments (\`--json\`)
- \`linear issue comment update <commentId> -b "text"\` — update comment
- \`linear issue comment delete <commentId>\` — delete comment

**Markdown content** — For multi-line descriptions or comments, write to a temp file and use \`--description-file\` / \`--body-file\` instead of inline flags, to avoid shell escaping issues.

### SOP: Managing Issues

1. **Search before creating** — Run \`linear issue query --search "keyword" --all-teams\` to check for duplicates before creating a new issue.
2. **Create when confirmed** — Only after you've confirmed a real problem, or the user explicitly asks.
3. **Provide context** — Clear title, steps to reproduce, error messages, relevant code paths. Use \`--description-file\` for rich markdown.
4. **Keep issues updated** — Use \`linear issue update\` or \`linear issue comment add\` to append findings rather than creating duplicates.
5. **Report back** — After any Linear operation, tell the user the issue identifier and what you did.

### When to create an issue
- You confirmed a real bug or problem through investigation
- The user reports a feature request or enhancement
- The user explicitly asks to record/track/create a ticket
- The user describes a TODO, requirement, or task they want tracked

### When NOT to create an issue
- You're still diagnosing and haven't confirmed anything yet
- The problem turns out to be a misunderstanding or user error (explain instead)
- It's a simple question you can answer directly`;

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
    ...(config.linear?.apiKey && {
      LINEAR_API_KEY: config.linear.apiKey,
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
    settingSources: [] as ("user" | "project" | "local")[],
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
    ],
    thinking: { type: "enabled" as const },
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
  private readonly commonOptions: ReturnType<typeof buildCommonOptions>;

  constructor(config: FrailConfig) {
    this.config = config;
    this.commonOptions = buildCommonOptions(config);

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

  destroy(): void {}

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

      const q = query({
        prompt: text,
        options: {
          ...this.commonOptions,
          persistSession: true,
          sessionId: isResume ? undefined : this.sessionId,
          resume: isResume ? this.sessionId : undefined,
          includePartialMessages: true,
        },
      });

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

      q.close();

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
    setDaemonState("session_id", this.sessionId);
    log.info("Session", `Reset to new session ${this.sessionId}`);
  }
}
