#!/usr/bin/env bun
import * as fs from "node:fs";
import * as net from "node:net";
import * as readline from "node:readline/promises";
import { CONFIG_DIR, CONFIG_PATH, configFileExists, loadConfig, saveConfig } from "./config/loader";
import type { FrailConfig } from "./config/schema";
import {
  ensureDaemonRunning,
  isDaemonRunning,
  stopDaemon,
  waitForSocket,
} from "./daemon/process";
import { LOG_PATH } from "./daemon/logger";
import { runDaemon } from "./daemon/index";
import { uninstallLaunchAgent, isLaunchAgentInstalled } from "./daemon/launchd";
import { runAttach } from "./tui/attach";
import { SOCKET_PATH as RPC_SOCKET } from "./daemon/rpc-bridge";
import { pingLinear } from "./tools/linear";

// ---------------------------------------------------------------------------
// frail init
// ---------------------------------------------------------------------------

async function cmdInit() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, fallback?: string): Promise<string> => {
    const tail = fallback ? ` [${fallback}]` : "";
    const ans = (await rl.question(`${prompt}${tail}: `)).trim();
    return ans || fallback || "";
  };
  const askBool = async (prompt: string, fallback: boolean): Promise<boolean> => {
    const def = fallback ? "Y/n" : "y/N";
    const ans = (await rl.question(`${prompt} [${def}]: `)).trim().toLowerCase();
    if (!ans) return fallback;
    return ans === "y" || ans === "yes";
  };

  let config: FrailConfig;
  if (configFileExists()) {
    config = await loadConfig();
    console.log(`Existing config at ${CONFIG_PATH} — keeping unset values.\n`);
  } else {
    config = (await import("./config/schema")).frailConfigSchema.parse({});
  }

  console.log("frail · setup\n");

  config.workDir = await ask("Working directory", config.workDir);

  console.log("\nFeishu integration (optional):");
  config.feishu.enabled = await askBool("Enable Feishu", config.feishu.enabled);
  if (config.feishu.enabled) {
    config.feishu.appId = await ask("  App ID", config.feishu.appId);
    config.feishu.appSecret = await ask("  App Secret", config.feishu.appSecret);
    const dom = await ask("  Domain (feishu/lark)", config.feishu.domain);
    config.feishu.domain = dom === "lark" ? "lark" : "feishu";
  }

  console.log("\nLinear integration (optional):");
  const linearKey = await ask("  API key", config.linear?.apiKey ?? "");
  if (linearKey) {
    const ping = await pingLinear(linearKey);
    if (!ping.ok) {
      console.log(`  warn: linear ping failed (${ping.error}). Saved anyway.`);
    } else {
      console.log(`  ok — authenticated as ${ping.user}`);
    }
    config.linear = { apiKey: linearKey };
  }

  rl.close();

  await saveConfig(config);
  console.log(`\nSaved ${CONFIG_PATH}\n`);

  console.log(
    "LLM credentials are managed by pi (the underlying agent SDK).\n" +
      "After the daemon starts, run `/login` inside `frail attach` to sign into\n" +
      "Anthropic / OpenAI / Google / etc., or set ANTHROPIC_API_KEY in your env.\n",
  );
}

// ---------------------------------------------------------------------------
// frail status (one-shot snapshot via RPC)
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const launchAgent = isLaunchAgentInstalled() ? "installed" : "not installed";
  if (!isDaemonRunning()) {
    console.log(`  Daemon:      \x1b[31mnot running\x1b[0m`);
    console.log(`  LaunchAgent: ${launchAgent}`);
    return;
  }

  const result = await rpcCall("get_state").catch((err: Error) => err);
  if (result instanceof Error) {
    console.log(`  Daemon:      \x1b[33mrunning (RPC failed: ${result.message})\x1b[0m`);
    console.log(`  LaunchAgent: ${launchAgent}`);
    return;
  }
  const st = result as Record<string, any>;
  const status = await rpcCallEvent<{
    type: "frail_status";
    startedAt: number;
    feishu: { enabled: boolean; connected: boolean };
    linear: { configured: boolean };
  }>("frail_status").catch(() => undefined);

  console.log(`  Daemon:      \x1b[32mrunning\x1b[0m`);
  if (status?.startedAt) {
    const uptimeSec = Math.floor((Date.now() - status.startedAt) / 1000);
    console.log(`  Uptime:      ${formatUptime(uptimeSec)}`);
  }
  console.log(`  Model:       ${st.model?.id ?? "unknown"}`);
  console.log(`  Session:     ${(st.sessionId ?? "?").slice(0, 8)}...`);
  console.log(`  Messages:    ${st.messageCount}`);
  console.log(`  Streaming:   ${st.isStreaming ? "yes" : "no"}`);
  if (status) {
    const fs = !status.feishu.enabled
      ? "not configured"
      : status.feishu.connected
        ? "connected"
        : "connecting";
    const fsColor = fs === "connected" ? "\x1b[32m" : fs === "connecting" ? "\x1b[33m" : "\x1b[90m";
    console.log(`  Feishu WS:   ${fsColor}${fs}\x1b[0m`);
    console.log(`  Linear:      ${status.linear.configured ? "configured" : "not configured"}`);
  }
  console.log(`  LaunchAgent: ${launchAgent}`);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface RpcRequestOptions<T> {
  /** JSON line to send after connect. Omit to just listen. */
  send?: Record<string, unknown>;
  /** Resolve on the first parsed line that returns a value (or rejects). */
  match: (parsed: any) => { resolve: T } | { reject: Error } | undefined;
  /** Error message used when the timeout fires. */
  timeoutMessage: string;
}

async function rpcRequest<T = unknown>(opts: RpcRequestOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!fs.existsSync(RPC_SOCKET)) {
      reject(new Error(`socket not found at ${RPC_SOCKET}`));
      return;
    }
    const sock = net.createConnection(RPC_SOCKET);
    let buf = "";
    sock.once("error", reject);
    if (opts.send) {
      const payload = opts.send;
      sock.once("connect", () => {
        sock.write(`${JSON.stringify(payload)}\n`);
      });
    }
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      while (true) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const result = opts.match(parsed);
        if (!result) continue;
        sock.destroy();
        if ("resolve" in result) resolve(result.resolve);
        else reject(result.reject);
        return;
      }
    });
    setTimeout(() => {
      sock.destroy();
      reject(new Error(opts.timeoutMessage));
    }, 5000);
  });
}

async function rpcCall<T = unknown>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
  const id = `cli_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  return rpcRequest<T>({
    send: { id, type, ...extra },
    match: (parsed) => {
      if (parsed.type !== "response" || parsed.id !== id) return undefined;
      if (parsed.success) return { resolve: parsed.data as T };
      return { reject: new Error(parsed.error ?? "RPC failed") };
    },
    timeoutMessage: "RPC timeout",
  });
}

async function rpcCallEvent<T = unknown>(eventType: string): Promise<T> {
  return rpcRequest<T>({
    match: (parsed) =>
      parsed.type === eventType ? { resolve: parsed as T } : undefined,
    timeoutMessage: `event ${eventType} not received`,
  });
}

// ---------------------------------------------------------------------------
// frail logs
// ---------------------------------------------------------------------------

async function cmdLogs() {
  if (!fs.existsSync(LOG_PATH)) {
    console.log(`No log file found at ${LOG_PATH}`);
    process.exit(1);
  }

  const proc = Bun.spawn(["tail", "-f", LOG_PATH], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.on("SIGINT", () => {
    proc.kill();
    process.exit(0);
  });
  await proc.exited;
}

// ---------------------------------------------------------------------------
// frail config
// ---------------------------------------------------------------------------

interface ConfigKeyDef {
  get: (c: FrailConfig) => string;
  set: (c: FrailConfig, v: string) => void;
  secret?: boolean;
}

const CONFIG_KEYS: Record<string, ConfigKeyDef> = {
  workDir: { get: (c) => c.workDir, set: (c, v) => { c.workDir = v; } },
  systemPrompt: { get: (c) => c.systemPrompt, set: (c, v) => { c.systemPrompt = v; } },
  "feishu.enabled": {
    get: (c) => String(c.feishu.enabled),
    set: (c, v) => { c.feishu.enabled = v === "true" || v === "1" || v === "yes"; },
  },
  "feishu.appId": { get: (c) => c.feishu.appId, set: (c, v) => { c.feishu.appId = v; } },
  "feishu.appSecret": {
    get: (c) => c.feishu.appSecret,
    set: (c, v) => { c.feishu.appSecret = v; },
    secret: true,
  },
  "feishu.domain": {
    get: (c) => c.feishu.domain,
    set: (c, v) => { c.feishu.domain = v === "lark" ? "lark" : "feishu"; },
  },
  "linear.apiKey": {
    get: (c) => c.linear?.apiKey ?? "",
    set: (c, v) => { c.linear = { apiKey: v || undefined }; },
    secret: true,
  },
};

function maskSecret(val: string): string {
  if (!val) return "(empty)";
  if (val.length <= 8) return "****";
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

async function cmdConfig() {
  const key = process.argv[3];
  const value = process.argv[4];

  if (!configFileExists()) {
    console.log("No configuration found. Run 'frail init' first.");
    return;
  }

  const config = await loadConfig();

  if (!key) {
    console.log(`\x1b[1mConfiguration\x1b[0m (${CONFIG_PATH})\n`);
    for (const [k, def] of Object.entries(CONFIG_KEYS)) {
      const val = def.get(config);
      const display = def.secret && val ? maskSecret(val) : val || "(empty)";
      console.log(`  ${k.padEnd(22)} ${display}`);
    }
    console.log(
      "\nLLM credentials (Anthropic/OpenAI/etc.) live in pi's auth store at ~/.pi/agent/auth.json.\n" +
        "Use the /login slash command inside `frail attach` to manage them.",
    );
    return;
  }

  const def = CONFIG_KEYS[key];
  if (!def) {
    console.log(`Unknown config key: ${key}`);
    console.log("\nAvailable keys:");
    for (const k of Object.keys(CONFIG_KEYS)) console.log(`  ${k}`);
    return;
  }

  if (value === undefined) {
    const val = def.get(config);
    console.log(val || "(empty)");
    return;
  }

  def.set(config, value);

  if (key.startsWith("feishu.")) {
    config.feishu.enabled =
      config.feishu.enabled || !!(config.feishu.appId && config.feishu.appSecret);
  }

  await saveConfig(config);
  console.log(`${key} = ${def.secret ? maskSecret(value) : value}`);
}

// ---------------------------------------------------------------------------
// frail attach (default)
// ---------------------------------------------------------------------------

function cmdStop() {
  stopDaemon();
  if (isLaunchAgentInstalled()) {
    console.log("LaunchAgent is still installed. Daemon will start on next login.");
    console.log("Use 'frail uninstall' to remove permanently.");
  }
}

async function cmdAttach() {
  if (!configFileExists()) {
    await cmdInit();
    return;
  }

  ensureDaemonRunning();
  console.log("Waiting for daemon...");
  const ready = await waitForSocket();
  if (!ready) {
    console.log("Daemon failed to start. Check 'frail logs'.");
    process.exit(1);
  }

  await runAttach();
}

function cmdUninstall() {
  if (isDaemonRunning()) stopDaemon();
  uninstallLaunchAgent();
}

function cmdHelp() {
  console.log(`
\x1b[36m\x1b[1m  frail\x1b[0m — AI chat daemon with Feishu integration

\x1b[1m  Usage:\x1b[0m frail <command>

\x1b[1m  Commands:\x1b[0m
    attach      Connect to daemon TUI
    daemon      Run daemon in foreground (for dev)
    status      Daemon status snapshot
    stop        Stop the daemon
    logs        Tail daemon logs
    config      View/set frail-only config keys
    init        Set workDir / Feishu / Linear credentials
    uninstall   Remove macOS LaunchAgent

  LLM credentials live in pi's auth store. After connecting, run
  /login inside attach mode to authenticate.

\x1b[1m  Examples:\x1b[0m
    frail init
    frail attach
    frail config workDir /path/to/dir
    frail status
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "daemon":
      await runDaemon();
      return;
    case "stop":
      cmdStop();
      break;
    case "status":
      await cmdStatus();
      break;
    case "logs":
      await cmdLogs();
      break;
    case "init":
      await cmdInit();
      break;
    case "attach":
      await cmdAttach();
      break;
    case "config":
      await cmdConfig();
      break;
    case "uninstall":
      cmdUninstall();
      break;
    default:
      cmdHelp();
      break;
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Touch to avoid unused-import warnings for CONFIG_DIR re-export.
void CONFIG_DIR;
