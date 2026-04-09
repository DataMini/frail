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

  // Env vars override config file
  const envOverrides: Record<string, unknown> = {};

  if (process.env.PROJECT_ROOT) {
    envOverrides.workDir = process.env.PROJECT_ROOT;
  }

  // Provider env overrides
  {
    const fileProv =
      (fileConfig.provider as Record<string, unknown> | undefined) ?? {};
    const provOverrides: Record<string, unknown> = { ...fileProv };
    let changed = false;

    if (process.env.ANTHROPIC_API_KEY) {
      provOverrides.apiKey = process.env.ANTHROPIC_API_KEY;
      changed = true;
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN && !provOverrides.apiKey) {
      provOverrides.apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
      changed = true;
    }
    if (process.env.ANTHROPIC_BASE_URL) {
      provOverrides.baseURL = process.env.ANTHROPIC_BASE_URL;
      changed = true;
    }
    if (process.env.ANTHROPIC_MODEL) {
      provOverrides.model = process.env.ANTHROPIC_MODEL;
      changed = true;
    }

    if (changed) {
      envOverrides.provider = provOverrides;
    }
  }

  // Feishu env overrides
  if (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) {
    const feishuFile =
      (fileConfig.feishu as Record<string, unknown> | undefined) ?? {};
    envOverrides.feishu = {
      ...feishuFile,
      ...(process.env.FEISHU_APP_ID && { appId: process.env.FEISHU_APP_ID }),
      ...(process.env.FEISHU_APP_SECRET && {
        appSecret: process.env.FEISHU_APP_SECRET,
      }),
      enabled:
        !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) ||
        (feishuFile as Record<string, unknown>).enabled === true,
    };
  }

  const merged = { ...fileConfig, ...envOverrides };
  // Backward compat: projectRoot → workDir
  if ("projectRoot" in merged && !("workDir" in merged)) {
    (merged as any).workDir = (merged as any).projectRoot;
  }
  currentConfig = frailConfigSchema.parse(merged);
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

  // Provider settings
  const prov: Record<string, string> = {};
  prov.model = config.provider.model;
  if (config.provider.apiKey) prov.apiKey = config.provider.apiKey;
  if (config.provider.baseURL) prov.baseURL = config.provider.baseURL;
  toSave.provider = prov;

  if (config.feishu.enabled) {
    const feishu: Record<string, unknown> = {
      enabled: config.feishu.enabled,
      domain: config.feishu.domain,
    };
    if (config.feishu.appId) feishu.appId = config.feishu.appId;
    if (config.feishu.appSecret) feishu.appSecret = config.feishu.appSecret;
    toSave.feishu = feishu;
  }

  toSave.conversation = config.conversation;
  toSave.agent = config.agent;

  if (Object.keys(config.mcpServers).length > 0) {
    toSave.mcpServers = config.mcpServers;
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.stringify(toSave), "utf-8");

  currentConfig = config;
}

export { CONFIG_DIR, CONFIG_PATH };
