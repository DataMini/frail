import * as fs from "fs";
import * as path from "path";

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config",
  "frail"
);
const LOG_PATH = path.join(CONFIG_DIR, "frail.log");

export interface Logger {
  info: (tag: string, msg: string) => void;
  warn: (tag: string, msg: string) => void;
  error: (tag: string, msg: string) => void;
}

let logger: Logger | null = null;

export function createLogger(): Logger {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const stream = fs.createWriteStream(LOG_PATH, { flags: "a" });

  function log(level: "info" | "warn" | "error", tag: string, message: string) {
    const ts = new Date().toISOString();
    stream.write(`${ts} [${level.toUpperCase()}] [${tag}] ${message}\n`);
  }

  logger = {
    info: (tag, msg) => log("info", tag, msg),
    warn: (tag, msg) => log("warn", tag, msg),
    error: (tag, msg) => log("error", tag, msg),
  };
  return logger;
}

export function getLogger(): Logger {
  if (!logger) {
    return createLogger();
  }
  return logger;
}

export { LOG_PATH };
