import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { FrailConfig } from "../config/schema";
import { createLinearTools } from "../tools/linear";
import { pathSandboxExtension } from "./extensions/path-sandbox";
import { getLogger } from "./logger";

const FRAIL_PERSONA = `You are Frail, a technical assistant that receives user-reported problems, helps analyze and resolve them, and tracks confirmed issues in Linear.

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

## Available tools

You have read-only file tools (read, grep, find, ls) and a small set of native Linear tools — no shell access. File tools are scoped to the configured workspace, and any path that is git-ignored (e.g. .env, build outputs, node_modules) is rejected by design.

## Linear — Issue Tracking

You have native tools for Linear:
- linear_list_my_issues({ state?, teamId? })
- linear_search_issues({ query, teamId?, teamKey?, state?, label? })
- linear_view_issue({ id, includeComments? })  // id can be a uuid or "ENG-123" identifier
- linear_create_issue({ title, description?, teamId | teamKey, priority?, labels?, projectId?, assigneeSelf? })
- linear_update_issue({ id, title?, description?, state?, priority?, assigneeSelf?, assigneeId?, addLabels?, removeLabels?, projectId? })
- linear_create_comment({ issueId, body })
- linear_list_comments({ issueId, limit? })

SOP:
1. Search before creating — call linear_search_issues first; if a likely match exists, view it via linear_view_issue and ask the user whether to reuse it.
2. Create when confirmed — only after investigation or explicit user request.
3. Provide context — clear title, repro steps, error messages, relevant code paths.
4. Report back the issue identifier and URL after create / update / comment actions.
5. State changes and comments — call linear_update_issue / linear_create_comment directly; do not punt to the Linear UI.

Issue deletion is not exposed — if the user asks to delete an issue, return the URL and ask them to finish in the Linear UI.

When NOT to create an issue:
- You're still diagnosing and haven't confirmed anything yet.
- The problem turns out to be a misunderstanding or user error (explain instead).
- It's a simple question you can answer directly.`;

function buildSystemPromptOverride(config: FrailConfig): string {
  if (config.systemPrompt && config.systemPrompt.trim()) {
    return config.systemPrompt;
  }
  return FRAIL_PERSONA;
}

export interface FrailSession {
  /** Pi's AgentSession — drives the agent loop, tools, and persistence. */
  session: AgentSession;
  /** Run a prompt, serialized so concurrent callers (TUI + Feishu) don't race. */
  prompt(
    text: string,
    source: "tui" | "feishu",
    images?: ImageContent[],
  ): Promise<void>;
  /** Last assistant text emitted by the session (for Feishu replies). */
  getLastAssistantText(): string | undefined;
  /** True while a prompt is being processed. */
  isBusy(): boolean;
  /** True while pi is auto-compacting context. */
  isCompacting(): boolean;
  /** True once the persisted branch contains at least one user/assistant message. */
  hasMessages(): boolean;
  /** Abort the in-flight turn. */
  abort(): Promise<void>;
  /** Epoch ms of the most recent prompt (or boot/load). Used by idle auto-new-session. */
  getLastActivityAt(): number;
  /** Reset the idle clock — used to back off after a failure. */
  touchActivity(): void;
  /** Roll the session onto a fresh JSONL file. Aborts any in-flight turn. Returns new sessionId. */
  newSession(): Promise<string>;
}

export async function bootSession(config: FrailConfig): Promise<FrailSession> {
  const log = getLogger();
  const cwd = config.workDir;
  const allowedRoots =
    config.allowedRoots && config.allowedRoots.length > 0
      ? config.allowedRoots
      : [config.workDir];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    systemPrompt: buildSystemPromptOverride(config),
    // No project context files / skills / extensions discovery for now —
    // frail injects its own slash-command extension elsewhere.
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [pathSandboxExtension(allowedRoots)],
  });
  await resourceLoader.reload();

  const customTools = createLinearTools(config.linear?.apiKey);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    resourceLoader,
    customTools,
    // Allowlist applies to BOTH built-ins and customTools — must include
    // every Linear tool name or the LLM never sees them.
    tools: ["read", "grep", "find", "ls", ...customTools.map((t) => t.name)],
  });

  if (modelFallbackMessage) {
    log.info("Session", modelFallbackMessage);
  }
  log.info(
    "Session",
    `pi AgentSession ready (cwd=${cwd}, customTools=${customTools.length}, sessionId=${session.sessionId}, allowedRoots=${allowedRoots.join("|")})`,
  );

  let lock: Promise<void> = Promise.resolve();
  let busy = false;

  // Seed from the most recent persisted entry's timestamp so a daemon restart
  // doesn't pretend a stale session is "fresh activity". Falls back to now.
  const branch = session.sessionManager.getBranch();
  const latestEntry = branch[branch.length - 1];
  let lastActivityAt = latestEntry?.timestamp
    ? new Date(latestEntry.timestamp).getTime()
    : Date.now();

  const prompt: FrailSession["prompt"] = (text, source, images) => {
    lastActivityAt = Date.now();
    const next = lock.then(async () => {
      busy = true;
      const imageNote = images?.length ? ` (+${images.length} image)` : "";
      log.info(
        "Session",
        `[${source}] User: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}${imageNote}`,
      );
      try {
        await session.prompt(text, images?.length ? { images } : undefined);
      } finally {
        busy = false;
        lastActivityAt = Date.now();
      }
    });
    lock = next.catch(() => undefined);
    return next;
  };

  const newSession: FrailSession["newSession"] = async () => {
    await session.abort();
    session.agent.reset();
    session.sessionManager.newSession();
    lastActivityAt = Date.now();
    return session.sessionManager.getSessionId();
  };

  return {
    session,
    prompt,
    getLastAssistantText: () => session.getLastAssistantText(),
    isBusy: () => busy,
    isCompacting: () => session.isCompacting,
    hasMessages: () =>
      session.sessionManager.getBranch().some((e) => e.type === "message"),
    abort: () => session.abort(),
    getLastActivityAt: () => lastActivityAt,
    touchActivity: () => {
      lastActivityAt = Date.now();
    },
    newSession,
  };
}
