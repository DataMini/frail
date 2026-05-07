import { cosmiconfig } from "cosmiconfig";
import { frailConfigSchema, type FrailConfig } from "./schema";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config",
  "frail"
);

const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");

let currentConfig: FrailConfig | null = null;

export function configFileExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export async function loadConfig(): Promise<FrailConfig> {
  const explorer = cosmiconfig("frail", {
    searchPlaces: [
      "config.yaml",
      "config.yml",
      "config.json",
      ".frailrc.yaml",
      ".frailrc.json",
    ],
    searchStrategy: "global",
  });

  let fileConfig: Record<string, unknown> = {};

  try {
    const result = await explorer.search(CONFIG_DIR);
    if (result && !result.isEmpty) {
      fileConfig = result.config as Record<string, unknown>;
    }
  } catch {
    // No config file found, use defaults
  }

  currentConfig = frailConfigSchema.parse(fileConfig);
  return currentConfig;
}

export function getConfig(): FrailConfig {
  if (!currentConfig) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return currentConfig;
}

export function updateConfig(patch: Partial<FrailConfig>): FrailConfig {
  if (!currentConfig) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  currentConfig = frailConfigSchema.parse({ ...currentConfig, ...patch });
  return currentConfig;
}

export async function saveConfig(config: FrailConfig): Promise<void> {
  const toSave: Record<string, unknown> = {
    workDir: config.workDir,
  };

  if (config.systemPrompt) {
    toSave.systemPrompt = config.systemPrompt;
  }

  if (config.feishu.enabled || config.feishu.appId || config.feishu.appSecret) {
    const feishu: Record<string, unknown> = {
      enabled: config.feishu.enabled,
      domain: config.feishu.domain,
    };
    if (config.feishu.appId) feishu.appId = config.feishu.appId;
    if (config.feishu.appSecret) feishu.appSecret = config.feishu.appSecret;
    toSave.feishu = feishu;
  }

  if (config.linear?.apiKey) {
    toSave.linear = { apiKey: config.linear.apiKey };
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.stringify(toSave), "utf-8");

  currentConfig = config;
}

export { CONFIG_DIR, CONFIG_PATH };
