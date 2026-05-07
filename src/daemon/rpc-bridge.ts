import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { FrailSession } from "./session";
import { getLogger } from "./logger";
import { CONFIG_DIR } from "../config/loader";

export const SOCKET_PATH = path.join(CONFIG_DIR, "frail.sock");

/**
 * Frail-specific event broadcast alongside pi events.
 * `source` lets the TUI tag user prompts that originated from Feishu.
 */
export interface FrailSourceEvent {
  type: "frail_source";
  source: "tui" | "feishu";
  text: string;
  /** Number of inline image attachments on this prompt (Feishu only). */
  imageCount?: number;
}

export interface FrailStatusEvent {
  type: "frail_status";
  startedAt: number;
  feishu: { enabled: boolean; connected: boolean };
  linear: { configured: boolean };
}

/** Broadcast after `/new` rolls the session over so attached TUIs reset. */
export interface FrailSessionResetEvent {
  type: "frail_session_reset";
  sessionId: string;
}

export type BroadcastEvent =
  | FrailSourceEvent
  | FrailStatusEvent
  | FrailSessionResetEvent
  | object;

interface Client {
  socket: net.Socket;
  buf: string;
}

export interface BridgeStatusProvider {
  startedAt: number;
  feishu: () => { enabled: boolean; connected: boolean };
  linear: () => { configured: boolean };
}

export interface RpcBridge {
  /** Total connected clients (each TUI = 1). */
  clientCount(): number;
  /** Push an event to every connected client. */
  broadcast(event: BroadcastEvent): void;
  /** Stop the server and close all sockets. */
  close(): Promise<void>;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function rpcErr(id: string | undefined, command: string, message: string): RpcResponse {
  return { id, type: "response", command, success: false, error: message } as RpcResponse;
}

function rpcOk<T>(id: string | undefined, command: string, data?: T): RpcResponse {
  if (data === undefined) {
    return { id, type: "response", command, success: true } as unknown as RpcResponse;
  }
  return { id, type: "response", command, success: true, data } as unknown as RpcResponse;
}

export async function startRpcBridge(
  frail: FrailSession,
  status: BridgeStatusProvider,
): Promise<RpcBridge> {
  const log = getLogger();
  const session: AgentSession = frail.session;

  // Make sure the parent dir exists, and remove any stale socket.
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
  }

  const clients = new Set<Client>();

  const send = (client: Client, value: unknown) => {
    try {
      client.socket.write(jsonLine(value));
    } catch (err) {
      log.error("RPC", `write failed: ${err}`);
    }
  };

  const broadcast = (event: BroadcastEvent) => {
    const line = jsonLine(event);
    for (const c of clients) {
      try {
        c.socket.write(line);
      } catch {}
    }
  };

  // Mirror every pi AgentSessionEvent to all attached clients.
  const unsubscribe = session.subscribe((event) => {
    broadcast(event as BroadcastEvent);
  });

  const handleCommand = async (
    cmd: RpcCommand,
  ): Promise<RpcResponse | undefined> => {
    const id = cmd.id;
    try {
      switch (cmd.type) {
        case "prompt": {
          // Don't await — pi streams events while the prompt runs.
          // Reply immediately so the client unblocks; events follow.
          frail.prompt(cmd.message, "tui").catch((err) => {
            log.error("RPC", `prompt error: ${err}`);
          });
          return rpcOk(id, "prompt");
        }
        case "steer": {
          await session.steer(cmd.message, cmd.images);
          return rpcOk(id, "steer");
        }
        case "follow_up": {
          await session.followUp(cmd.message, cmd.images);
          return rpcOk(id, "follow_up");
        }
        case "abort": {
          await session.abort();
          return rpcOk(id, "abort");
        }
        case "get_state": {
          const state: RpcSessionState = {
            model: session.model,
            thinkingLevel: session.thinkingLevel,
            isStreaming: session.isStreaming,
            isCompacting: session.isCompacting,
            steeringMode: session.steeringMode,
            followUpMode: session.followUpMode,
            sessionFile: session.sessionFile,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            autoCompactionEnabled: session.autoCompactionEnabled,
            messageCount: session.messages.length,
            pendingMessageCount: session.pendingMessageCount,
          };
          return rpcOk(id, "get_state", state);
        }
        case "set_model": {
          const models = await session.modelRegistry.getAvailable();
          const model = models.find(
            (m) => m.provider === cmd.provider && m.id === cmd.modelId,
          );
          if (!model) {
            return rpcErr(id, "set_model", `Model not found: ${cmd.provider}/${cmd.modelId}`);
          }
          await session.setModel(model);
          return rpcOk(id, "set_model", model);
        }
        case "cycle_model": {
          const result = await session.cycleModel();
          return rpcOk(id, "cycle_model", result ?? null);
        }
        case "get_available_models": {
          const models = await session.modelRegistry.getAvailable();
          return rpcOk(id, "get_available_models", { models });
        }
        case "refresh_models" as RpcCommand["type"]: {
          // Re-read auth.json + models.json so newly-added credentials become
          // visible. If the session has no usable model yet, auto-pick one —
          // preferring the just-authenticated provider when the client passes
          // its id, otherwise the first available.
          session.modelRegistry.refresh();
          const available = session.modelRegistry.getAvailable();
          const current = session.model;
          const isUnknown =
            !current || (current as any).provider === "unknown" || current.id === "unknown";
          const preferProvider = (cmd as any).preferProvider as string | undefined;
          let picked: { provider: string; id: string } | null = null;
          if (available.length > 0) {
            const fromPreferred = preferProvider
              ? available.find((m) => m.provider === preferProvider)
              : undefined;
            const candidate = fromPreferred ?? (isUnknown ? available[0] : undefined);
            if (candidate) {
              try {
                await session.setModel(candidate);
                picked = { provider: candidate.provider, id: candidate.id };
              } catch (err) {
                log.error("RPC", `setModel after refresh failed: ${err}`);
              }
            }
          }
          return rpcOk(id, "refresh_models" as any, {
            availableCount: available.length,
            picked,
          });
        }
        case "set_thinking_level": {
          session.setThinkingLevel(cmd.level);
          return rpcOk(id, "set_thinking_level");
        }
        case "cycle_thinking_level": {
          const level = session.cycleThinkingLevel();
          if (!level) return rpcOk(id, "cycle_thinking_level", null);
          return rpcOk(id, "cycle_thinking_level", { level });
        }
        case "set_steering_mode": {
          session.setSteeringMode(cmd.mode);
          return rpcOk(id, "set_steering_mode");
        }
        case "set_follow_up_mode": {
          session.setFollowUpMode(cmd.mode);
          return rpcOk(id, "set_follow_up_mode");
        }
        case "compact": {
          const result = await session.compact(cmd.customInstructions);
          return rpcOk(id, "compact", result);
        }
        case "set_auto_compaction": {
          session.setAutoCompactionEnabled(cmd.enabled);
          return rpcOk(id, "set_auto_compaction");
        }
        case "set_auto_retry": {
          session.setAutoRetryEnabled(cmd.enabled);
          return rpcOk(id, "set_auto_retry");
        }
        case "abort_retry": {
          session.abortRetry();
          return rpcOk(id, "abort_retry");
        }
        case "bash": {
          // We deliberately do not expose bash to the model, but the user-driven
          // /bash slash command in pi's TUI uses this RPC. Allow it.
          const result = await session.executeBash(cmd.command);
          return rpcOk(id, "bash", result);
        }
        case "abort_bash": {
          session.abortBash();
          return rpcOk(id, "abort_bash");
        }
        case "get_session_stats": {
          return rpcOk(id, "get_session_stats", session.getSessionStats());
        }
        case "export_html": {
          const p = await session.exportToHtml(cmd.outputPath);
          return rpcOk(id, "export_html", { path: p });
        }
        case "get_last_assistant_text": {
          return rpcOk(id, "get_last_assistant_text", {
            text: session.getLastAssistantText() ?? null,
          });
        }
        case "set_session_name": {
          await session.setSessionName(cmd.name);
          return rpcOk(id, "set_session_name");
        }
        case "get_messages": {
          return rpcOk(id, "get_messages", { messages: session.messages });
        }
        case "get_commands": {
          const commands: Array<{
            name: string;
            description?: string;
            source: "extension" | "prompt" | "skill";
            sourceInfo: unknown;
          }> = [];
          for (const c of session.extensionRunner.getRegisteredCommands()) {
            commands.push({
              name: c.invocationName,
              description: c.description,
              source: "extension",
              sourceInfo: c.sourceInfo,
            });
          }
          for (const t of session.promptTemplates) {
            commands.push({
              name: t.name,
              description: t.description,
              source: "prompt",
              sourceInfo: t.sourceInfo,
            });
          }
          for (const s of session.resourceLoader.getSkills().skills) {
            commands.push({
              name: `skill:${s.name}`,
              description: s.description,
              source: "skill",
              sourceInfo: s.sourceInfo,
            });
          }
          return rpcOk(id, "get_commands", { commands });
        }
        case "get_fork_messages": {
          return rpcOk(id, "get_fork_messages", {
            messages: session.getUserMessagesForForking(),
          });
        }

        case "new_session": {
          const sessionId = await frail.newSession();
          log.info("RPC", `session reset → ${sessionId}`);
          broadcast({ type: "frail_session_reset", sessionId });
          return rpcOk(id, "new_session", { sessionId });
        }

        // The rest of the multi-session navigation suite needs the runtime
        // host — keep returning a clean error so the TUI can hide them.
        case "fork":
        case "clone":
        case "switch_session":
          return rpcErr(id, cmd.type, "Multi-session navigation not supported in frail.");

        default: {
          const t = (cmd as { type: string }).type;
          return rpcErr(id, t, `Unknown command: ${t}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const t = (cmd as { type: string }).type;
      log.error("RPC", `command ${t} failed: ${msg}`);
      return rpcErr(id, t, msg);
    }
  };

  const handleClient = (socket: net.Socket) => {
    const client: Client = { socket, buf: "" };
    clients.add(client);
    log.info("RPC", `client connected (${clients.size} total)`);

    // Send a frail_status snapshot right after connect.
    send(client, {
      type: "frail_status",
      startedAt: status.startedAt,
      feishu: status.feishu(),
      linear: status.linear(),
    });

    // And the current pi session state for fast cold-start.
    handleCommand({ type: "get_state", id: undefined } as RpcCommand)
      .then((resp) => {
        if (resp) send(client, resp);
      })
      .catch(() => undefined);

    socket.on("data", (chunk) => {
      client.buf += chunk.toString("utf8");
      while (true) {
        const newlineIdx = client.buf.indexOf("\n");
        if (newlineIdx === -1) break;
        const line = client.buf.slice(0, newlineIdx).trim();
        client.buf = client.buf.slice(newlineIdx + 1);
        if (!line) continue;
        let parsed: RpcCommand;
        try {
          parsed = JSON.parse(line) as RpcCommand;
        } catch (err) {
          send(client, {
            type: "response",
            command: "unknown",
            success: false,
            error: `Invalid JSON: ${err}`,
          });
          continue;
        }
        handleCommand(parsed)
          .then((resp) => {
            if (resp) send(client, resp);
          })
          .catch((err) => {
            send(
              client,
              rpcErr(parsed.id, (parsed as { type: string }).type, String(err)),
            );
          });
      }
    });

    socket.on("close", () => {
      clients.delete(client);
      log.info("RPC", `client disconnected (${clients.size} remaining)`);
    });

    socket.on("error", (err) => {
      log.error("RPC", `socket error: ${err}`);
    });
  };

  const server = net.createServer(handleClient);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => {
      try {
        fs.chmodSync(SOCKET_PATH, 0o600);
      } catch {}
      resolve();
    });
  });
  log.info("RPC", `listening on ${SOCKET_PATH}`);

  return {
    clientCount: () => clients.size,
    broadcast,
    close: async () => {
      unsubscribe();
      for (const c of clients) {
        try {
          c.socket.destroy();
        } catch {}
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
      } catch {}
    },
  };
}
