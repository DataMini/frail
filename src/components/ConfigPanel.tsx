import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import type { FrailConfig } from "../config/schema";

interface ConfigPanelProps {
  config: FrailConfig;
  onSave: (config: FrailConfig) => void;
  onBack: () => void;
}

type EditField =
  | "model"
  | "apiKey"
  | "baseURL"
  | "workDir"
  | "systemPrompt"
  | "timeoutMinutes"
  | "feishuEnabled"
  | "feishuAppId"
  | "feishuAppSecret"
  | "feishuDomain"
  | null;

const FIELD_OPTIONS = [
  { label: "Model", value: "model" as const },
  { label: "API Key", value: "apiKey" as const },
  { label: "Base URL", value: "baseURL" as const },
  { label: "Work Dir", value: "workDir" as const },
  { label: "System Prompt", value: "systemPrompt" as const },
  { label: "Timeout (minutes)", value: "timeoutMinutes" as const },
  { label: "Feishu Enabled", value: "feishuEnabled" as const },
  { label: "Feishu App ID", value: "feishuAppId" as const },
  { label: "Feishu App Secret", value: "feishuAppSecret" as const },
  { label: "Feishu Domain", value: "feishuDomain" as const },
];

function maskSecret(value: string | undefined): string {
  if (!value) return "(env var)";
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

export function ConfigPanel({ config, onSave, onBack }: ConfigPanelProps) {
  const [editing, setEditing] = useState<EditField>(null);

  useInput((_input, key) => {
    if (key.escape) {
      if (editing) {
        setEditing(null);
      } else {
        onBack();
      }
    }
  });

  function getFieldValue(field: EditField): string {
    switch (field) {
      case "model": return config.provider.model;
      case "apiKey": return config.provider.apiKey ?? "";
      case "baseURL": return config.provider.baseURL ?? "";
      case "workDir": return config.workDir;
      case "systemPrompt": return config.systemPrompt;
      case "timeoutMinutes": return String(config.agent.timeoutMinutes);
      case "feishuEnabled": return config.feishu.enabled ? "true" : "false";
      case "feishuAppId": return config.feishu.appId;
      case "feishuAppSecret": return config.feishu.appSecret;
      case "feishuDomain": return config.feishu.domain;
      default: return "";
    }
  }

  function getDisplayValue(field: EditField): string {
    const val = getFieldValue(field);
    if (field === "apiKey" || field === "feishuAppSecret") return maskSecret(val || undefined);
    if (field === "baseURL") return val || "(default)";
    if (field === "feishuEnabled") return val;
    if (field === "feishuDomain") return val;
    return val || "(not set)";
  }

  function handleSelectField(field: string) {
    // Toggle fields — cycle value directly without entering edit mode
    if (field === "feishuEnabled") {
      const updated = { ...config };
      updated.feishu = { ...updated.feishu, enabled: !config.feishu.enabled };
      onSave(updated);
      return;
    }
    if (field === "feishuDomain") {
      const updated = { ...config };
      updated.feishu = {
        ...updated.feishu,
        domain: config.feishu.domain === "feishu" ? "lark" : "feishu",
      };
      onSave(updated);
      return;
    }
    setEditing(field as EditField);
  }

  function handleSaveField(value: string) {
    if (!editing) return;

    const updated = { ...config };
    switch (editing) {
      case "model":
        updated.provider = { ...updated.provider, model: value };
        break;
      case "apiKey":
        updated.provider = { ...updated.provider, apiKey: value || undefined };
        break;
      case "baseURL":
        updated.provider = { ...updated.provider, baseURL: value || undefined };
        break;
      case "workDir":
        updated.workDir = value;
        break;
      case "systemPrompt":
        updated.systemPrompt = value;
        break;
      case "timeoutMinutes":
        updated.agent = { ...updated.agent, timeoutMinutes: parseInt(value) || 5 };
        break;
      case "feishuEnabled":
        updated.feishu = { ...updated.feishu, enabled: value === "true" };
        break;
      case "feishuAppId":
        updated.feishu = { ...updated.feishu, appId: value };
        break;
      case "feishuAppSecret":
        updated.feishu = { ...updated.feishu, appSecret: value };
        break;
      case "feishuDomain":
        updated.feishu = { ...updated.feishu, domain: value === "lark" ? "lark" : "feishu" };
        break;
    }

    onSave(updated);
    setEditing(null);
  }

  if (editing) {
    const label = FIELD_OPTIONS.find((f) => f.value === editing)?.label;
    const isApiKey = editing === "apiKey";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Editing: {label}</Text>
        <Text dimColor>Press Enter to save, Escape to cancel</Text>
        {isApiKey && (
          <Text dimColor>Leave empty to use environment variable</Text>
        )}
        <Box marginTop={1}>
          <Text bold color="cyan">{">"} </Text>
          <TextInput
            defaultValue={getFieldValue(editing)}
            onSubmit={handleSaveField}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        Configuration <Text dimColor>(Escape to go back)</Text>
      </Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {FIELD_OPTIONS.map((f) => (
          <Text key={f.value}>
            <Text dimColor>{f.label}: </Text>
            <Text>{getDisplayValue(f.value)}</Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>Select a field to edit:</Text>
      <Select options={FIELD_OPTIONS} onChange={handleSelectField} />
    </Box>
  );
}
