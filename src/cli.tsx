#!/usr/bin/env bun
import React, { useState, useCallback } from "react";
import { render, Box, Text } from "ink";
import { AttachView } from "./components/AttachView";
import { SetupWizard } from "./components/SetupWizard";
import { loadConfig, saveConfig, configFileExists } from "./config/loader";
import { closeDb } from "./db/threads";
import {
  ensureDaemonRunning,
  stopDaemon,
  isDaemonRunning,
  waitForSocket,
} from "./daemon/process";
import { LOG_PATH } from "./daemon/logger";
import { runDaemon } from "./daemon/index";
import { uninstallLaunchAgent, isLaunchAgentInstalled } from "./daemon/launchd";
import type { FrailConfig } from "./config/schema";

// --- Subcommand handlers ---

async function cmdInit() {
  // Load existing config BEFORE rendering so useState picks it up
  let initialConfig: FrailConfig | undefined;
  if (configFileExists()) {
    initialConfig = await loadConfig();
  }

  function InitApp() {
    const handleComplete = useCallback(async (cfg: FrailConfig) => {
      await saveConfig(cfg);
      console.log("Configuration saved. Run 'frail' to start.");
      process.exit(0);
    }, []);

    return <SetupWizard initialConfig={initialConfig} onComplete={handleComplete} />;
  }

  const { waitUntilExit } = render(<InitApp />);
  await waitUntilExit();
}

function cmdStop() {
  stopDaemon();
  if (isLaunchAgentInstalled()) {
    console.log("LaunchAgent is still installed. Daemon will start on next login.");
    console.log("Use 'frail uninstall' to remove permanently.");
  }
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

async function cmdStatus() {
  const { IPCClient } = await import("./daemon/ipc-client");
  const launchAgent = isLaunchAgentInstalled() ? "installed" : "not installed";

  const MAX_CONTENT_LINES = 11;
  let linesWritten = 0; // how many lines we've output total (header + content)

  function render(lines: string[]) {
    if (linesWritten > 0) {
      // Move cursor up to overwrite previous content (skip header)
      process.stdout.write(`\x1b[${linesWritten}A`);
    } else {
      // First render: hide cursor, print header
      process.stdout.write("\x1b[?25l");
      process.stdout.write("frail daemon status  (Ctrl+C to exit)\n\n");
    }

    // Write content lines, clearing each line first
    const padded = MAX_CONTENT_LINES;
    for (let i = 0; i < padded; i++) {
      process.stdout.write(`\x1b[2K${lines[i] ?? ""}\n`);
    }
    linesWritten = padded;
  }

  function renderStatus(data: any) {
    const fs = data.feishu ?? "not configured";
    const feishuColor = fs === "connected" ? "\x1b[32m"
      : fs === "connecting" ? "\x1b[33m"
      : fs === "error" ? "\x1b[31m"
      : "\x1b[90m";
    const mcp = data.mcp;
    const mcpLabel = !mcp ? "not configured"
      : mcp.status === "connected" ? "connected"
      : mcp.status === "failed" ? `failed (${mcp.error || "unknown"})`
      : "unknown";
    const mcpColor = !mcp ? "\x1b[90m"
      : mcp.status === "connected" ? "\x1b[32m"
      : mcp.status === "failed" ? "\x1b[31m"
      : "\x1b[33m";
    render([
      `  Daemon:      \x1b[32mrunning\x1b[0m`,
      `  PID:         ${data.pid}`,
      `  Uptime:      ${formatUptime(data.uptime)}`,
      `  Model:       ${data.model}`,
      `  Session:     ${data.sessionId?.slice(0, 8)}...`,
      `  Messages:    ${data.messageCount}`,
      `  Busy:        ${data.busy ? "yes" : "no"}`,
      `  Feishu WS:   ${feishuColor}${fs}\x1b[0m`,
      `  MCP Linear:  ${mcpColor}${mcpLabel}\x1b[0m`,
      `  LaunchAgent: ${launchAgent}`,
    ]);
  }

  // Try to connect once and keep the connection for polling
  if (!isDaemonRunning()) {
    render([`  Daemon:      \x1b[31mnot running\x1b[0m`, `  LaunchAgent: ${launchAgent}`]);
  }

  await new Promise<void>((resolve) => {
    let client: InstanceType<typeof IPCClient> | null = null;
    let connected = false;

    async function ensureConnected(): Promise<boolean> {
      if (client?.isConnected()) return true;
      // Reconnect
      client = new IPCClient();
      try {
        await client.connect();
        connected = true;
        client.on("status_reply", (data: any) => renderStatus(data));
        client.on("disconnected", () => { connected = false; });
        return true;
      } catch {
        connected = false;
        return false;
      }
    }

    const interval = setInterval(async () => {
      if (!isDaemonRunning()) {
        render([`  Daemon:      \x1b[31mnot running\x1b[0m`, `  LaunchAgent: ${launchAgent}`]);
        return;
      }
      if (await ensureConnected()) {
        client!.requestStatus();
      } else {
        render([`  Daemon:      \x1b[33mrunning (IPC failed)\x1b[0m`, `  LaunchAgent: ${launchAgent}`]);
      }
    }, 2000);

    // Initial poll
    (async () => {
      if (isDaemonRunning() && await ensureConnected()) {
        client!.requestStatus();
      }
    })();

    process.on("SIGINT", () => {
      clearInterval(interval);
      if (client?.isConnected()) client.close();
      process.stdout.write("\x1b[?25h\n"); // show cursor
      resolve();
    });
  });
}

async function cmdLogs() {
  const { existsSync } = await import("fs");
  if (!existsSync(LOG_PATH)) {
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

// --- Config command ---

const CONFIG_KEYS: Record<string, { get: (c: any) => string; set: (c: any, v: string) => void; secret?: boolean }> = {
  "provider.model":     { get: c => c.provider.model,     set: (c, v) => { c.provider = { ...c.provider, model: v }; } },
  "provider.apiKey":    { get: c => c.provider.apiKey ?? "", set: (c, v) => { c.provider = { ...c.provider, apiKey: v || undefined }; }, secret: true },
  "provider.baseURL":   { get: c => c.provider.baseURL ?? "", set: (c, v) => { c.provider = { ...c.provider, baseURL: v || undefined }; } },
  "workDir":            { get: c => c.workDir,             set: (c, v) => { c.workDir = v; } },
  "systemPrompt":       { get: c => c.systemPrompt,       set: (c, v) => { c.systemPrompt = v; } },
  "feishu.appId":       { get: c => c.feishu.appId,       set: (c, v) => { c.feishu = { ...c.feishu, appId: v }; } },
  "feishu.appSecret":   { get: c => c.feishu.appSecret,   set: (c, v) => { c.feishu = { ...c.feishu, appSecret: v }; }, secret: true },
  "agent.maxTurns":     { get: c => String(c.agent.maxTurns), set: (c, v) => { c.agent = { ...c.agent, maxTurns: parseInt(v) || 10 }; } },
  "agent.timeoutMinutes": { get: c => String(c.agent.timeoutMinutes), set: (c, v) => { c.agent = { ...c.agent, timeoutMinutes: parseInt(v) || 5 }; } },
  "conversation.maxMessages": { get: c => String(c.conversation.maxMessages), set: (c, v) => { c.conversation = { ...c.conversation, maxMessages: parseInt(v) || 50 }; } },
  "conversation.ttlMinutes":  { get: c => String(c.conversation.ttlMinutes), set: (c, v) => { c.conversation = { ...c.conversation, ttlMinutes: parseInt(v) || 30 }; } },
};

function maskSecret(val: string): string {
  if (!val) return "(empty)";
  if (val.length <= 8) return "****";
  return val.slice(0, 4) + "..." + val.slice(-4);
}

async function cmdConfig() {
  const key = process.argv[3];
  const value = process.argv[4];

  if (!configFileExists()) {
    console.log("No configuration found. Run 'frail init' first.");
    return;
  }

  const config = await loadConfig() as any;

  // frail config — show all
  if (!key) {
    console.log(`\x1b[1mConfiguration\x1b[0m (${(await import("./config/loader")).CONFIG_PATH})\n`);
    for (const [k, def] of Object.entries(CONFIG_KEYS)) {
      const val = def.get(config);
      const display = def.secret && val ? maskSecret(val) : (val || "(empty)");
      console.log(`  ${k.padEnd(28)} ${display}`);
    }
    return;
  }

  const def = CONFIG_KEYS[key];
  if (!def) {
    console.log(`Unknown config key: ${key}`);
    console.log(`\nAvailable keys:`);
    for (const k of Object.keys(CONFIG_KEYS)) {
      console.log(`  ${k}`);
    }
    return;
  }

  // frail config <key> — get value
  if (value === undefined) {
    const val = def.get(config);
    console.log(val || "(empty)");
    return;
  }

  // frail config <key> <value> — set value
  def.set(config, value);

  // Auto-set feishu.enabled based on credentials
  if (key.startsWith("feishu.")) {
    config.feishu.enabled = !!(config.feishu.appId && config.feishu.appSecret);
  }

  await saveConfig(config);
  console.log(`${key} = ${def.secret ? maskSecret(value) : value}`);
}

function cmdUninstall() {
  // Stop daemon first if running
  if (isDaemonRunning()) {
    stopDaemon();
  }
  uninstallLaunchAgent();
}

async function cmdDefault() {
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

  const { waitUntilExit } = render(<AttachView />);
  await waitUntilExit();
}

function cmdHelp() {
  console.log(`
\x1b[36m\x1b[1m  frail\x1b[0m — AI chat daemon with Feishu integration

\x1b[1m  Usage:\x1b[0m frail <command>

\x1b[1m  Commands:\x1b[0m
    attach      Connect to daemon TUI
    daemon      Run daemon in foreground (for dev)
    status      Live daemon status (Ctrl+C to exit)
    stop        Stop the daemon
    logs        Tail daemon logs
    config      View/set config (config <key> [value])
    init        Setup wizard (LLM / Linear / Feishu)
    uninstall   Remove LaunchAgent

\x1b[1m  Examples:\x1b[0m
    frail init                          Setup wizard
    frail attach                        Start chatting
    frail config                        Show all config
    frail config workDir /path/to/dir   Set working directory
    frail status                        Check daemon health
`);
}

// --- Main ---

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
      await cmdDefault();
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

  closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
