import * as net from "net";
import { EventEmitter } from "events";
import { SOCKET_PATH } from "./process";

export class IPCClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(SOCKET_PATH, () => {
        this.socket = socket;
        resolve();
      });

      socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.emit(msg.type, msg);
          } catch {}
        }
      });

      socket.on("close", () => {
        this.emit("disconnected");
      });

      socket.on("error", (err) => {
        if (!this.socket) {
          reject(err);
        } else {
          this.emit("error", err);
        }
      });
    });
  }

  private send(msg: object) {
    this.socket?.write(JSON.stringify(msg) + "\n");
  }

  attach() {
    this.send({ type: "attach" });
  }

  sendMessage(text: string) {
    this.send({ type: "message", text });
  }

  sendCommand(name: string) {
    this.send({ type: "command", name });
  }

  requestStatus() {
    this.send({ type: "status" });
  }

  close() {
    this.send({ type: "detach" });
    this.socket?.end();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
