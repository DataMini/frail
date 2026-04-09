import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { installLaunchAgent, isLaunchAgentInstalled, LABEL } from "./launchd";

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config",
  "frail"
);

export const PID_PATH = path.join(CONFIG_DIR, "frail.pid");
export const SOCKET_PATH = path.join(CONFIG_DIR, "frail.sock");

export function writePidFile(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid));
}

export function readPidFile(): number | null {
  try {
    const content = fs.readFileSync(PID_PATH, "utf-8").trim();
    return parseInt(content, 10) || null;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(PID_PATH);
  } catch {}
}

export function removeSocketFile(): void {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
}

export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    removePidFile();
    return false;
  }
}

/** Ensure daemon is running via launchd. Installs LaunchAgent if needed. */
export function ensureDaemonRunning(): void {
  if (isDaemonRunning()) return;

  // Install LaunchAgent plist if not present
  if (!isLaunchAgentInstalled()) {
    installLaunchAgent(); // writes plist + launchctl load → RunAtLoad starts it
  } else {
    // Plist exists but daemon not running — kick it
    removeSocketFile();
    Bun.spawnSync(["launchctl", "start", LABEL]);
  }
}

/** Stop daemon. SIGTERM → exit(0) → launchd won't restart (KeepAlive.SuccessfulExit: false). */
export function stopDaemon(): void {
  const pid = readPidFile();
  if (!pid) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log("Daemon process not found. Cleaning up.");
    removePidFile();
    removeSocketFile();
    return;
  }

  // Wait for daemon to actually exit (up to 5s)
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0); // check if still alive
      Bun.sleepSync(100);
    } catch {
      break; // process gone
    }
  }
  // Clean up any leftover files
  removePidFile();
  removeSocketFile();
  console.log("Daemon stopped.");
}

export async function waitForSocket(timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(SOCKET_PATH)) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = net.connect(SOCKET_PATH, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on("error", () => resolve(false));
      });
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
