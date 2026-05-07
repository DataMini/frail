import * as net from "node:net";
import * as fs from "node:fs";
import {
  TUI,
  Editor,
  Text,
  Container,
  Markdown,
  ProcessTerminal,
  matchesKey,
  CombinedAutocompleteProvider,
  type Component,
  type EditorTheme,
  type SlashCommand,
} from "@mariozechner/pi-tui";
import {
  AuthStorage,
  ModelRegistry,
  LoginDialogComponent,
  OAuthSelectorComponent,
  initTheme,
  getSelectListTheme,
  getMarkdownTheme,
  ToolExecutionComponent,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

// Not exported from the public index; mirror the shape from
// oauth-selector.d.ts.
type AuthSelectorProvider = {
  id: string;
  name: string;
  authType: "oauth" | "api_key";
};
import chalk from "chalk";
import { CONFIG_DIR } from "../config/loader";
import * as path from "node:path";

const SOCKET_PATH = path.join(CONFIG_DIR, "frail.sock");

interface RpcRequest {
  id: string;
  type: string;
  [k: string]: unknown;
}

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface FrailStatusEvent {
  type: "frail_status";
  startedAt: number;
  feishu: { enabled: boolean; connected: boolean };
  linear: { configured: boolean };
}

interface FrailSourceEvent {
  type: "frail_source";
  source: "tui" | "feishu";
  text: string;
  imageCount?: number;
}

interface FrailSessionResetEvent {
  type: "frail_session_reset";
  sessionId: string;
}

type AnyEvent =
  | FrailStatusEvent
  | FrailSourceEvent
  | FrailSessionResetEvent
  | { type: string; [k: string]: unknown };

type Listener = (event: AnyEvent) => void;

class SocketRpc {
  private sock: net.Socket;
  private buf = "";
  private nextId = 0;
  private pending = new Map<
    string,
    { resolve: (resp: RpcResponse) => void; reject: (err: Error) => void }
  >();
  private listeners: Listener[] = [];

  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      while (true) {
        const i = this.buf.indexOf("\n");
        if (i < 0) break;
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let parsed: AnyEvent;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.type === "response") {
          const resp = parsed as unknown as RpcResponse;
          if (resp.id && this.pending.has(resp.id)) {
            const p = this.pending.get(resp.id)!;
            this.pending.delete(resp.id);
            p.resolve(resp);
          }
          continue;
        }
        for (const l of this.listeners) l(parsed);
      }
    });
    sock.on("close", () => {
      for (const p of this.pending.values()) {
        p.reject(new Error("socket closed"));
      }
      this.pending.clear();
    });
  }

  onEvent(l: Listener): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async call<T = unknown>(
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<T> {
    const id = `req_${++this.nextId}`;
    const cmd: RpcRequest = { id, type, ...extra };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (!resp.success) {
            reject(new Error(resp.error ?? "RPC failed"));
            return;
          }
          resolve(resp.data as T);
        },
        reject,
      });
      this.sock.write(`${JSON.stringify(cmd)}\n`);
    });
  }

  destroy(): void {
    try {
      this.sock.destroy();
    } catch {}
  }
}

function connect(): Promise<SocketRpc> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      reject(
        new Error(
          `frail daemon socket not found at ${SOCKET_PATH}. Start it with 'frail daemon'.`,
        ),
      );
      return;
    }
    const sock = net.createConnection(SOCKET_PATH);
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      resolve(new SocketRpc(sock));
    });
  });
}

// Editor theme is sourced from pi after initTheme() runs in runAttach().

/**
 * Compact message stream. We render user / assistant text via the bare pi-tui
 * Markdown component (paddingX=1, paddingY=0) so messages stack without the
 * extra vertical padding pi's UserMessageComponent / AssistantMessageComponent
 * impose via their inner Box. Tool calls keep ToolExecutionComponent for the
 * status border + result folding.
 */
class UserBubble extends Container {
  constructor(text: string) {
    super();
    // First line gets a "› " caret in user color; subsequent lines align with it.
    const caret = chalk.bold(chalk.blue("› "));
    const lines = text.split("\n");
    const styled = lines
      .map((l, i) => (i === 0 ? caret + l : "  " + l))
      .join("\n");
    this.addChild(new Text(styled, 1, 0));
  }
}

class AssistantBubble extends Container {
  private md: Markdown;
  constructor() {
    super();
    this.md = new Markdown("", 1, 0, getMarkdownTheme());
    this.addChild(this.md);
  }
  updateText(text: string): void {
    this.md.setText(text);
    this.invalidate();
  }
}

class MessagesView extends Container {
  prependFeishuTag(imageCount: number = 0): void {
    const suffix =
      imageCount > 0
        ? ` +${imageCount} image${imageCount > 1 ? "s" : ""}`
        : "";
    this.children.push(new Text(chalk.cyan(` [Feishu${suffix}]`), 0, 0));
  }
  addUserMessage(text: string): void {
    this.children.push(new UserBubble(text));
  }
  addAssistantPlaceholder(): AssistantBubble {
    const c = new AssistantBubble();
    this.children.push(c);
    return c;
  }
  addToolExecution(c: ToolExecutionComponent): void {
    this.children.push(c);
  }
  resetMessages(): void {
    this.clear();
  }
}

/** Pull plain text out of an AssistantMessage for streaming updates. */
function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

interface State {
  /** Current streaming AssistantBubble, or null between turns. */
  streamingAssistant: AssistantBubble | null;
  toolByCallId: Map<string, ToolExecutionComponent>;
  pendingSource: "tui" | "feishu" | null;
  pendingImageCount: number;
  status: {
    busy: boolean;
    compacting: boolean;
    model?: string;
    feishu: { enabled: boolean; connected: boolean };
    linear: { configured: boolean };
  };
}

export async function runAttach(): Promise<void> {
  // pi components (OAuthSelectorComponent, LoginDialogComponent, the editor's
  // selectList theme) all read the global pi theme. Must be initialised before
  // any of them are constructed.
  initTheme();

  const rpc = await connect();
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const messagesView = new MessagesView();
  const editorTheme: EditorTheme = {
    borderColor: (s: string) => chalk.gray(s),
    selectList: getSelectListTheme(),
  };
  const editor = new Editor(tui, editorTheme);

  // Slash-command autocomplete. Only the local commands frail handles itself —
  // /login + /logout swap the input area for pi's auth dialogs; /new + /compact
  // talk to the daemon. File-attachment (`@path`) suggestions still work via
  // the same provider's basePath argument.
  const slashCommands: SlashCommand[] = [
    { name: "login", description: "Sign in to an LLM provider (OAuth or API key)" },
    { name: "logout", description: "Sign out of an LLM provider" },
    { name: "new", description: "Start a fresh session (clears history)" },
    { name: "compact", description: "Compact session history into a summary" },
  ];
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands, process.cwd()),
  );

  const footer = new Text("", 1, 0);
  const header = new Text(
    chalk.bold("frail · attach") + chalk.gray(" — type a message, Enter to send. Ctrl+C to quit."),
    1,
    0,
  );

  // Container that holds the active "input area" — usually the editor, but
  // /login and /logout temporarily swap it for pi's auth dialogs.
  const inputSlot = new Container();
  inputSlot.addChild(editor);

  tui.addChild(header);
  tui.addChild(messagesView);
  tui.addChild(inputSlot);
  tui.addChild(footer);
  tui.setFocus(editor);

  const showInput = (c: Component) => {
    inputSlot.clear();
    inputSlot.addChild(c);
    tui.setFocus(c);
    tui.requestRender();
  };
  const restoreEditor = () => {
    inputSlot.clear();
    inputSlot.addChild(editor);
    tui.setFocus(editor);
    tui.requestRender();
  };

  const state: State = {
    streamingAssistant: null,
    toolByCallId: new Map(),
    pendingSource: null,
    pendingImageCount: 0,
    status: {
      busy: false,
      compacting: false,
      feishu: { enabled: false, connected: false },
      linear: { configured: false },
    },
  };

  const dot = (kind: "ok" | "off" | "wait" | "err") => {
    if (kind === "ok") return chalk.green("●");
    if (kind === "wait") return chalk.yellow("●");
    if (kind === "err") return chalk.red("●");
    return chalk.gray("○");
  };

  const refresh = () => {
    const parts: string[] = [];

    // Model — green if known, dim if unknown
    const modelLabel = state.status.model && state.status.model !== "unknown"
      ? chalk.green(state.status.model)
      : chalk.gray("no model");
    parts.push(modelLabel);

    // Working indicator
    if (state.status.busy) parts.push(chalk.yellow("● working"));
    if (state.status.compacting) parts.push(chalk.yellow("● compacting"));

    // Feishu: ● connected (green), ● connecting (yellow), ○ not configured (gray)
    const fs = state.status.feishu;
    const fsDot = !fs.enabled ? dot("off") : fs.connected ? dot("ok") : dot("wait");
    parts.push(`${fsDot} ${chalk.cyan("feishu")}`);

    // Linear: ● configured (green), ○ not configured (gray)
    const ln = state.status.linear;
    parts.push(`${ln.configured ? dot("ok") : dot("off")} ${chalk.magenta("linear")}`);

    footer.setText(parts.join(chalk.gray("  ·  ")));
    tui.requestRender();
  };

  const note = (text: string) => {
    // Render frail-internal notes (auth status, errors) as a simple Text line.
    messagesView.children.push(new Text(chalk.gray(`· ${text}`), 1, 0));
    tui.requestRender();
  };

  rpc.onEvent((event) => {
    switch (event.type) {
      case "frail_status": {
        const e = event as FrailStatusEvent;
        state.status.feishu = {
          enabled: e.feishu.enabled,
          connected: e.feishu.connected,
        };
        state.status.linear = { configured: e.linear.configured };
        refresh();
        break;
      }
      case "frail_source": {
        const e = event as FrailSourceEvent;
        state.pendingSource = e.source;
        state.pendingImageCount = e.imageCount ?? 0;
        break;
      }
      case "frail_session_reset": {
        // Daemon rolled the session over (someone ran /new). Drop all rendered
        // messages so we don't keep stale history glued to the new session.
        messagesView.resetMessages();
        state.streamingAssistant = null;
        state.toolByCallId.clear();
        state.pendingSource = null;
        state.pendingImageCount = 0;
        state.status.busy = false;
        state.status.compacting = false;
        refresh();
        break;
      }
      case "compaction_start": {
        const e = event as unknown as {
          reason: "manual" | "threshold" | "overflow";
        };
        state.status.compacting = true;
        note(e.reason === "manual" ? "compacting…" : `auto-compacting (${e.reason})…`);
        refresh();
        break;
      }
      case "compaction_end": {
        const e = event as unknown as {
          reason: "manual" | "threshold" | "overflow";
          result?: { tokensBefore?: number } | null;
          aborted: boolean;
          errorMessage?: string;
        };
        state.status.compacting = false;
        if (e.aborted) {
          note("compaction aborted");
        } else if (e.errorMessage) {
          // Pi prepends "Compaction failed: " to errorMessage; strip it so the
          // note doesn't read "compaction failed: Compaction failed: …".
          const msg = e.errorMessage.replace(/^Compaction failed:\s*/, "");
          note(`compaction failed: ${msg}`);
        } else {
          const tokens = e.result?.tokensBefore;
          note(tokens ? `compacted (${tokens.toLocaleString()} tokens summarized)` : "compacted");
        }
        refresh();
        break;
      }
      case "agent_start": {
        state.streamingAssistant = null;
        state.status.busy = true;
        refresh();
        break;
      }
      case "agent_end": {
        state.streamingAssistant = null;
        state.status.busy = false;
        refresh();
        break;
      }
      case "message_start": {
        const e = event as unknown as { message: { role: string; content: any } };
        if (e.message.role === "user") {
          if (state.pendingSource === "feishu") {
            messagesView.prependFeishuTag(state.pendingImageCount);
          }
          state.pendingSource = null;
          state.pendingImageCount = 0;
          const text =
            typeof e.message.content === "string"
              ? e.message.content
              : (e.message.content as any[])
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("");
          messagesView.addUserMessage(text);
          tui.requestRender();
        } else if (e.message.role === "assistant") {
          // Pre-create the placeholder so streaming deltas have somewhere to go.
          state.streamingAssistant = messagesView.addAssistantPlaceholder();
          tui.requestRender();
        }
        break;
      }
      case "message_update": {
        const e = event as unknown as {
          message: AssistantMessage;
          assistantMessageEvent: { type: string };
        };
        if (e.message.role === "assistant" && state.streamingAssistant) {
          state.streamingAssistant.updateText(extractAssistantText(e.message));
          tui.requestRender();
        }
        break;
      }
      case "message_end": {
        const e = event as unknown as { message: AssistantMessage };
        if (e.message.role === "assistant" && state.streamingAssistant) {
          state.streamingAssistant.updateText(extractAssistantText(e.message));
          state.streamingAssistant = null;
          tui.requestRender();
        }
        break;
      }
      case "tool_execution_start": {
        const e = event as unknown as {
          toolCallId: string;
          toolName: string;
          args: unknown;
        };
        const comp = new ToolExecutionComponent(
          e.toolName,
          e.toolCallId,
          e.args,
          { showImages: false },
          undefined,
          tui,
          process.cwd(),
        );
        comp.markExecutionStarted();
        state.toolByCallId.set(e.toolCallId, comp);
        messagesView.addToolExecution(comp);
        tui.requestRender();
        break;
      }
      case "tool_execution_update": {
        const e = event as unknown as {
          toolCallId: string;
          args: unknown;
          partialResult?: unknown;
        };
        const comp = state.toolByCallId.get(e.toolCallId);
        if (comp) {
          comp.updateArgs(e.args);
          tui.requestRender();
        }
        break;
      }
      case "tool_execution_end": {
        const e = event as unknown as {
          toolCallId: string;
          result: { content: any[]; details?: any };
          isError: boolean;
        };
        const comp = state.toolByCallId.get(e.toolCallId);
        if (comp) {
          comp.setArgsComplete();
          comp.updateResult(
            { content: e.result?.content ?? [], details: e.result?.details, isError: e.isError },
            false,
          );
          tui.requestRender();
        }
        break;
      }
    }
  });

  // Initial state hydration: pull existing messages + state.
  try {
    const messages = await rpc.call<{ messages: any[] }>("get_messages");
    for (const m of messages.messages) {
      if (m.role === "user") {
        const text =
          typeof m.content === "string"
            ? m.content
            : (m.content as any[])
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("");
        messagesView.addUserMessage(text);
      } else if (m.role === "assistant") {
        const ac = messagesView.addAssistantPlaceholder();
        ac.updateText(extractAssistantText(m as AssistantMessage));
      }
      // toolResult messages are folded into the previous assistant turn by pi
      // — for hydration we skip standalone tool history entries.
    }
    const st = await rpc.call<{ model?: { id?: string }; isStreaming: boolean }>(
      "get_state",
    );
    state.status.model = st.model?.id ?? "unknown";
    state.status.busy = st.isStreaming;
  } catch (err) {
    note(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
  }
  refresh();

  const authPath = path.join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage);

  const buildLoginProviders = (): AuthSelectorProvider[] => {
    const oauth = authStorage.getOAuthProviders();
    const oauthIds = new Set(oauth.map((p) => p.id));
    const out: AuthSelectorProvider[] = oauth.map((p) => ({
      id: p.id,
      name: p.name,
      authType: "oauth",
    }));
    const seen = new Set<string>();
    for (const m of modelRegistry.getAll()) {
      if (oauthIds.has(m.provider)) continue;
      if (seen.has(m.provider)) continue;
      seen.add(m.provider);
      out.push({
        id: m.provider,
        name: modelRegistry.getProviderDisplayName(m.provider),
        authType: "api_key",
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const buildLogoutProviders = (): AuthSelectorProvider[] => {
    const out: AuthSelectorProvider[] = [];
    for (const id of authStorage.list()) {
      const cred = authStorage.get(id);
      if (!cred) continue;
      out.push({
        id,
        name: modelRegistry.getProviderDisplayName(id),
        authType: cred.type,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const refreshDaemonModels = async (preferProvider?: string): Promise<void> => {
    try {
      const result = await rpc.call<{
        availableCount: number;
        picked: { provider: string; id: string } | null;
      }>("refresh_models", preferProvider ? { preferProvider } : {});
      const st = await rpc.call<{ model?: { id?: string } }>("get_state");
      state.status.model = st.model?.id ?? "unknown";
      refresh();
      if (preferProvider && !result.picked && result.availableCount === 0) {
        note(
          `No models available for ${preferProvider} after login. Use /model to pick one manually, or check ~/.pi/agent/models.json.`,
        );
      }
    } catch (err) {
      note(`Daemon refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runApiKeyLogin = async (opt: AuthSelectorProvider): Promise<void> => {
    const dialog = new LoginDialogComponent(tui, opt.id, () => undefined, opt.name);
    showInput(dialog);
    try {
      const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
      if (!apiKey) throw new Error("API key cannot be empty.");
      authStorage.set(opt.id, { type: "api_key", key: apiKey });
      restoreEditor();
      note(`Saved API key for ${opt.name}.`);
      await refreshDaemonModels(opt.id);
    } catch (err) {
      restoreEditor();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Login cancelled") note(`Login failed: ${msg}`);
    }
  };

  const runOAuthLogin = async (opt: AuthSelectorProvider): Promise<void> => {
    const dialog = new LoginDialogComponent(tui, opt.id, () => undefined, opt.name);
    showInput(dialog);
    const providerInfo = authStorage
      .getOAuthProviders()
      .find((p) => p.id === opt.id);
    const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

    let manualResolve: ((v: string) => void) | undefined;
    let manualReject: ((e: Error) => void) | undefined;
    const manualPromise = new Promise<string>((res, rej) => {
      manualResolve = res;
      manualReject = rej;
    });

    try {
      await authStorage.login(opt.id as any, {
        onAuth: (info: { url: string; instructions?: string }) => {
          dialog.showAuth(info.url, info.instructions);
          if (usesCallbackServer) {
            dialog
              .showManualInput("Paste redirect URL below, or finish login in browser:")
              .then((value: string) => {
                if (value && manualResolve) {
                  manualResolve(value);
                  manualResolve = undefined;
                }
              })
              .catch(() => {
                if (manualReject) {
                  manualReject(new Error("Login cancelled"));
                  manualReject = undefined;
                }
              });
          } else if (opt.id === "github-copilot") {
            dialog.showWaiting("Waiting for browser authentication...");
          }
        },
        onPrompt: async (prompt: { message: string; placeholder?: string }) =>
          dialog.showPrompt(prompt.message, prompt.placeholder),
        onProgress: (msg: string) => dialog.showProgress(msg),
        onManualCodeInput: () => manualPromise,
        signal: dialog.signal,
      } as any);
      restoreEditor();
      note(`Logged in to ${opt.name}.`);
      await refreshDaemonModels(opt.id);
    } catch (err) {
      restoreEditor();
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Login cancelled") note(`Login failed: ${msg}`);
    }
  };

  const runAuthFlow = async (mode: "login" | "logout"): Promise<void> => {
    authStorage.reload();
    modelRegistry.refresh();
    const providers =
      mode === "login" ? buildLoginProviders() : buildLogoutProviders();
    if (providers.length === 0) {
      note(
        mode === "logout"
          ? "No stored credentials to remove."
          : "No providers available.",
      );
      return;
    }
    await new Promise<void>((resolve) => {
      const selector = new OAuthSelectorComponent(
        mode,
        authStorage,
        providers,
        async (providerId: string) => {
          const opt = providers.find((p) => p.id === providerId);
          if (!opt) {
            restoreEditor();
            resolve();
            return;
          }
          if (mode === "login") {
            if (opt.authType === "oauth") await runOAuthLogin(opt);
            else await runApiKeyLogin(opt);
          } else {
            try {
              authStorage.logout(providerId);
              note(`Logged out of ${opt.name}.`);
              restoreEditor();
              await refreshDaemonModels();
            } catch (err) {
              restoreEditor();
              note(`Logout failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          resolve();
        },
        () => {
          restoreEditor();
          resolve();
        },
        (providerId: string) => modelRegistry.getProviderAuthStatus(providerId),
      );
      showInput(selector);
    });
  };

  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.setText("");

    if (trimmed === "/login" || trimmed === "/logout") {
      runAuthFlow(trimmed === "/login" ? "login" : "logout").catch((err: Error) => {
        restoreEditor();
        note(`${trimmed} failed: ${err.message}`);
      });
      return;
    }

    if (trimmed === "/new") {
      rpc.call("new_session").catch((err: Error) => {
        note(`/new failed: ${err.message}`);
      });
      return;
    }

    if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
      const customInstructions =
        trimmed === "/compact" ? undefined : trimmed.slice("/compact ".length);
      // Errors and progress are surfaced via compaction_start / compaction_end
      // events — swallow the RPC reject here to avoid a duplicate error note.
      rpc.call("compact", customInstructions ? { customInstructions } : {}).catch(
        () => undefined,
      );
      return;
    }

    rpc.call("prompt", { message: trimmed }).catch((err: Error) => {
      note(`prompt failed: ${err.message}`);
    });
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      tui.stop();
      rpc.destroy();
      process.exit(0);
    }
    return undefined;
  });

  tui.start();

  // Keep the process alive until socket dies / user quits.
  await new Promise<void>(() => undefined);
}
