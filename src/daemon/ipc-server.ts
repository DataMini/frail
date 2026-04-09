import * as net from "net";
import * as fs from "fs";
import { SOCKET_PATH } from "./process";
import { getLogger } from "./logger";
import type { AgentSession, StreamEvent, SessionDisplayMessage } from "./session";
import { getFeishuStatus } from "../feishu/client";

interface ClientState {
  socket: net.Socket;
  attached: boolean;
  buffer: string;
}

export interface IPCServer {
  listen: () => void;
  broadcast: (event: object) => void;
  close: () => void;
}

export function createIPCServer(session: AgentSession): IPCServer {
  const clients = new Map<net.Socket, ClientState>();
  const log = getLogger();

  function broadcast(event: object) {
    const line = JSON.stringify(event) + "\n";
    for (const [, state] of clients) {
      if (state.attached) {
        try {
          state.socket.write(line);
        } catch {}
      }
    }
  }

  function sendTo(socket: net.Socket, event: object) {
    try {
      socket.write(JSON.stringify(event) + "\n");
    } catch {}
  }

  function handleMessage(socket: net.Socket, msg: any) {
    const state = clients.get(socket);
    if (!state) return;

    switch (msg.type) {
      case "status": {
        sendTo(socket, {
          type: "status_reply",
          pid: process.pid,
          uptime: Math.floor(process.uptime()),
          messageCount: session.getMessageCount(),
          sessionId: session.getSessionId(),
          busy: session.isBusy(),
          model: session.getConfig().provider.model,
          feishu: getFeishuStatus(),
        });
        break;
      }

      case "attach": {
        state.attached = true;
        // Send history
        sendTo(socket, {
          type: "history",
          messages: session.getHistory(),
        });
        // Send current status
        sendTo(socket, {
          type: "status_update",
          model: session.getConfig().provider.model,
          busy: session.isBusy(),
        });
        log.info("IPC", "Client attached");
        break;
      }

      case "message": {
        if (!msg.text || typeof msg.text !== "string") break;
        const text = msg.text.trim();
        if (!text) break;

        // Broadcast user message to other attached clients
        broadcast({
          type: "user_message",
          content: text,
          source: "tui",
        });

        // Send to session
        session
          .chat(text, "tui", (event: StreamEvent) => broadcast(event))
          .catch((err) => {
            log.error("IPC", `Chat error: ${err}`);
            broadcast({ type: "error", message: String(err) });
          });
        break;
      }

      case "command": {
        const name = msg.name as string;
        switch (name) {
          case "new":
            session.resetSession();
            broadcast({ type: "session_reset" });
            break;
          case "status":
            sendTo(socket, {
              type: "status_reply",
              pid: process.pid,
              uptime: Math.floor(process.uptime()),
              messageCount: session.getMessageCount(),
              sessionId: session.getSessionId(),
              busy: session.isBusy(),
              model: session.getConfig().provider.model,
            });
            break;
          default:
            sendTo(socket, {
              type: "error",
              message: `Unknown command: /${name}`,
            });
        }
        break;
      }

      case "detach": {
        if (state.attached) {
          log.info("IPC", "Client detached");
        }
        state.attached = false;
        break;
      }
    }
  }

  const server = net.createServer((socket) => {
    const state: ClientState = { socket, attached: false, buffer: "" };
    clients.set(socket, state);

    socket.on("data", (data) => {
      state.buffer += data.toString();
      const lines = state.buffer.split("\n");
      state.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleMessage(socket, msg);
        } catch (err) {
          log.warn("IPC", `Invalid message: ${line}`);
        }
      }
    });

    socket.on("close", () => {
      if (state.attached) {
        log.info("IPC", "Client detached (disconnected)");
      }
      clients.delete(socket);
    });

    socket.on("error", (err) => {
      log.warn("IPC", `Socket error: ${err.message}`);
      clients.delete(socket);
    });
  });

  return {
    listen: () => {
      // Remove stale socket file
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch {}
      server.listen(SOCKET_PATH, () => {
        log.info("IPC", `Listening on ${SOCKET_PATH}`);
      });
    },
    broadcast,
    close: () => {
      for (const [socket] of clients) {
        socket.destroy();
      }
      clients.clear();
      server.close();
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch {}
    },
  };
}
