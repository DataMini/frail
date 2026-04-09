import { useState, useEffect, useCallback } from "react";
import {
  loadConfig,
  updateConfig,
  saveConfig,
} from "../config/loader";
import type { FrailConfig } from "../config/schema";

export function useConfig() {
  const [config, setConfig] = useState<FrailConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfig()
      .then((c) => {
        setConfig(c);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load config:", err);
        process.exit(1);
      });
  }, []);

  const update = useCallback(async (patch: Partial<FrailConfig>) => {
    const updated = updateConfig(patch);
    setConfig(updated);
    await saveConfig(updated);
    return updated;
  }, []);

  const replaceConfig = useCallback(async (newConfig: FrailConfig) => {
    setConfig(newConfig);
    await saveConfig(newConfig);
    return newConfig;
  }, []);

  return { config, loading, update, replaceConfig };
}
