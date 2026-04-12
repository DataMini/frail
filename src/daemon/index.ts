import { loadConfig } from "../config/loader";
import { closeDb } from "../db/threads";
import { createLogger, getLogger } from "./logger";
import { writePidFile, removePidFile, removeSocketFile } from "./process";
import { AgentSession } from "./session";
import { createIPCServer, type IPCServer } from "./ipc-server";
import { startFeishuClient, stopFeishuClient } from "../feishu/client";

let ipc: IPCServer | null = null;
let session: AgentSession | null = null;

function cleanup() {
  const log = getLogger();
  log.info("Daemon", "Shutting down...");

  if (ipc) {
    ipc.close();
    ipc = null;
  }
  if (session) {
    session.destroy();
    session = null;
  }
  stopFeishuClient();
  closeDb();
  removePidFile();
  removeSocketFile();

  log.info("Daemon", "Shutdown complete.");
  process.exit(0);
}

export async function runDaemon() {
  const log = createLogger();

  // Redirect stray stdout/stderr (from third-party SDKs) into our log file
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const trimmed = str.trim();
    if (trimmed) log.info("stdout", trimmed);
    return true;
  }) as any;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const trimmed = str.trim();
    if (trimmed) log.warn("stderr", trimmed);
    return true;
  }) as any;

  log.info("Daemon", "Starting...");

  const config = await loadConfig();
  session = new AgentSession(config);
  ipc = createIPCServer(session);

  // Start Feishu if configured
  if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
    try {
      startFeishuClient(config, session, ipc.broadcast);
      log.info("Daemon", "Feishu client started");
    } catch (err) {
      log.error("Daemon", `Feishu start failed: ${err}`);
    }
  }

  // Write PID file
  writePidFile();
  log.info("Daemon", `PID: ${process.pid}`);

  // Start IPC server
  ipc.listen();

  // Signal handlers
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  log.info("Daemon", "Ready.");
}
