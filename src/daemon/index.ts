import { loadConfig } from "../config/loader";
import { createLogger, getLogger } from "./logger";
import { writePidFile, removePidFile, removeSocketFile } from "./process";
import { bootSession, type FrailSession } from "./session";
import { startRpcBridge, type RpcBridge } from "./rpc-bridge";
import {
  startFeishuClient,
  stopFeishuClient,
  getFeishuStatus,
} from "../feishu/client";

let bridge: RpcBridge | null = null;
let frail: FrailSession | null = null;
let autoNewSessionTimer: ReturnType<typeof setInterval> | null = null;

function cleanup() {
  const log = getLogger();
  log.info("Daemon", "Shutting down...");

  if (autoNewSessionTimer) {
    clearInterval(autoNewSessionTimer);
    autoNewSessionTimer = null;
  }
  bridge?.close().catch(() => undefined);
  bridge = null;
  stopFeishuClient();
  removePidFile();
  removeSocketFile();

  log.info("Daemon", "Shutdown complete.");
  process.exit(0);
}

/**
 * Poll every minute; once the session has been idle long enough, roll it onto
 * a fresh JSONL file (same effect as `/new`). Pi handles context-overflow
 * compaction itself, so we no longer run a timed compact.
 */
function startAutoNewSession(
  frail: FrailSession,
  broadcast: (event: object) => void,
  idleMinutes: number,
): void {
  const log = getLogger();
  if (idleMinutes <= 0) {
    log.info("AutoNewSession", "disabled (autoNewSessionIdleMinutes=0)");
    return;
  }
  const idleMs = idleMinutes * 60 * 1000;
  log.info("AutoNewSession", `enabled — idle threshold ${idleMinutes}min`);

  autoNewSessionTimer = setInterval(async () => {
    if (frail.isBusy()) return;
    if (frail.isCompacting()) return;
    if (Date.now() - frail.getLastActivityAt() < idleMs) return;

    // Skip if no real conversation entries exist yet — rolling over an unused
    // session just churns files without a behavioral benefit.
    if (!frail.hasMessages()) return;

    log.info("AutoNewSession", `idle ${idleMinutes}min — resetting session`);
    try {
      const sessionId = await frail.newSession();
      broadcast({ type: "frail_session_reset", sessionId });
      log.info("AutoNewSession", `session reset → ${sessionId}`);
    } catch (err) {
      log.warn("AutoNewSession", `reset failed: ${err}`);
      // Back off so we don't retry every minute on persistent errors.
      frail.touchActivity();
    }
  }, 60 * 1000);
}

export async function runDaemon() {
  const log = createLogger();
  const startedAt = Date.now();

  // Redirect stray stdout/stderr (from third-party SDKs) into our log file.
  process.stdout.write = ((chunk: any) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const trimmed = str.trim();
    if (trimmed) log.info("stdout", trimmed);
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const trimmed = str.trim();
    if (trimmed) log.warn("stderr", trimmed);
    return true;
  }) as any;

  log.info("Daemon", "Starting...");

  const config = await loadConfig();
  frail = await bootSession(config);

  bridge = await startRpcBridge(frail, {
    startedAt,
    feishu: () => ({
      enabled: config.feishu.enabled,
      connected: getFeishuStatus() === "connected",
    }),
    linear: () => ({ configured: !!config.linear?.apiKey }),
  });

  if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
    try {
      startFeishuClient(config, frail, bridge.broadcast);
      log.info("Daemon", "Feishu client started");
    } catch (err) {
      log.error("Daemon", `Feishu start failed: ${err}`);
    }
  }

  startAutoNewSession(frail, bridge.broadcast, config.autoNewSessionIdleMinutes);

  writePidFile();
  log.info("Daemon", `PID: ${process.pid}`);

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  log.info("Daemon", "Ready.");
}
