import * as fs from "fs";
import * as path from "path";
import { LOG_PATH } from "./logger";

const LABEL = "com.frail.daemon";
const PLIST_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  "Library",
  "LaunchAgents"
);
const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config",
  "frail"
);

function getBunPath(): string {
  return process.argv[0] || "bun";
}

function getCliPath(): string {
  // Resolve the absolute path to cli.ts
  return path.resolve(__dirname, "../cli.ts");
}

const WRAPPER_PATH = path.join(CONFIG_DIR, "frail-daemon");

function writeWrapper(): void {
  const bunPath = getBunPath();
  const cliPath = getCliPath();
  const script = `#!/bin/sh
"${bunPath}" run "${cliPath}" daemon
exit 0
`;
  fs.writeFileSync(WRAPPER_PATH, script, { mode: 0o755 });
}

function generatePlist(): string {
  const stdoutLog = path.join(CONFIG_DIR, "daemon.stdout.log");
  const stderrLog = path.join(CONFIG_DIR, "daemon.stderr.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>Program</key>
    <string>${WRAPPER_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${stdoutLog}</string>
    <key>StandardErrorPath</key>
    <string>${stderrLog}</string>
    <key>WorkingDirectory</key>
    <string>${process.env.HOME || "/"}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>
    </dict>
</dict>
</plist>`;
}

export function installLaunchAgent(): void {
  fs.mkdirSync(PLIST_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Write wrapper script so macOS shows "frail-daemon" instead of bun's signer
  writeWrapper();

  const plist = generatePlist();
  fs.writeFileSync(PLIST_PATH, plist, "utf-8");

  // Unload first if already loaded (ignore errors)
  try {
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
  } catch {}

  const result = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    console.error(`Failed to load LaunchAgent: ${stderr}`);
    return;
  }

  console.log(`LaunchAgent installed: ${PLIST_PATH}`);
  console.log("Daemon will auto-start on login and restart on crash.");
  console.log("Use 'frail uninstall' to remove.");
}

export function uninstallLaunchAgent(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log("LaunchAgent not installed.");
    return;
  }

  // Unload (this also stops the daemon)
  Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);

  // Remove plist
  try {
    fs.unlinkSync(PLIST_PATH);
  } catch {}
  console.log("LaunchAgent uninstalled.");
}

export function isLaunchAgentInstalled(): boolean {
  return fs.existsSync(PLIST_PATH);
}

export { PLIST_PATH, LABEL };
