import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FrailConfig } from "../config/schema";
import { frailConfigSchema } from "../config/schema";

interface SetupWizardProps {
  initialConfig?: FrailConfig;
  onComplete: (config: FrailConfig) => void;
}

const MODEL_PRESETS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-20250515",
];

type TestStatus = "idle" | "testing" | "success" | "error";
type Step = "llm" | "feishu";
const STEPS: Step[] = ["llm", "feishu"];

function maskKey(val: string): string {
  if (!val) return "(empty)";
  if (val.length <= 8) return "****";
  return val.slice(0, 4) + "..." + val.slice(-4);
}

// ─── Step 1: LLM ────────────────────────────────────────

const LLM_FIELDS = ["apiKey", "baseURL", "model"] as const;
type LlmField = (typeof LLM_FIELDS)[number];

function LlmStep({
  apiKey, setApiKey,
  baseURL, setBaseURL,
  model, setModel,
  onNext,
}: {
  apiKey: string; setApiKey: (v: string) => void;
  baseURL: string; setBaseURL: (v: string) => void;
  model: string; setModel: (v: string) => void;
  onNext: () => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState("");

  const activeField = LLM_FIELDS[activeIdx]!;

  function toggleModel() {
    const idx = MODEL_PRESETS.indexOf(model);
    setModel(MODEL_PRESETS[(idx + 1) % MODEL_PRESETS.length]!);
    setTestStatus("idle");
  }

  function runTest() {
    setTestStatus("testing");
    setTestError("");
    const env: Record<string, string | undefined> = { ...process.env };
    if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
    if (baseURL) env.ANTHROPIC_BASE_URL = baseURL;

    (async () => {
      const origWrite = process.stderr.write;
      process.stderr.write = (() => true) as any;
      try {
        let gotResult = false;
        for await (const msg of query({
          prompt: "Say 'ok'",
          options: { model, env, maxTurns: 1, thinking: { type: "disabled" }, permissionMode: "bypassPermissions", persistSession: false },
        })) {
          if (msg.type === "result") {
            gotResult = true;
            if ("is_error" in msg && (msg as any).is_error) throw new Error((msg as any).error ?? "Unknown error");
            break;
          }
        }
        process.stderr.write = origWrite;
        setTestStatus(gotResult ? "success" : "error");
        if (!gotResult) setTestError("No response received");
      } catch (err: any) {
        process.stderr.write = origWrite;
        setTestStatus("error");
        const raw = err instanceof Error ? err.message : String(err);
        setTestError(`${raw.length > 200 ? raw.slice(0, 200) + "..." : raw}\n  [${baseURL || "api.anthropic.com"} model="${model}"]`);
      }
    })();
  }

  function handleEditSubmit(value: string) {
    if (activeField === "apiKey") setApiKey(value);
    else if (activeField === "baseURL") setBaseURL(value);
    else if (activeField === "model") setModel(value);
    setEditing(false);
    setTestStatus("idle");
  }

  useInput((input, key) => {
    if (editing) { if (key.escape) setEditing(false); return; }
    if (key.upArrow) setActiveIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setActiveIdx((i) => Math.min(LLM_FIELDS.length - 1, i + 1));
    else if (key.return) {
      if (activeField === "model") toggleModel();
      else { setEditing(true); setInputKey((k) => k + 1); }
    } else if (input === "e" && activeField === "model") { setEditing(true); setInputKey((k) => k + 1); }
    else if (input === "t") runTest();
    else if (input === "n") onNext();
  });

  const labels: Record<LlmField, string> = { apiKey: "API Key ", baseURL: "Base URL", model: "Model   " };
  const hints: Record<LlmField, string> = { apiKey: "Enter to edit, empty = env var", baseURL: "Enter to edit, empty = default", model: "Enter to cycle, e to type custom" };
  const displays: Record<LlmField, string> = { apiKey: apiKey ? maskKey(apiKey) : "(env var)", baseURL: baseURL || "(default)", model };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Step 1/2 — LLM Provider</Text>
      <Text dimColor>↑↓ navigate, Enter edit/toggle, t test, n next step</Text>

      <Box flexDirection="column" marginTop={1}>
        {LLM_FIELDS.map((field, idx) => {
          const isActive = idx === activeIdx;
          const marker = isActive ? "❯" : " ";
          if (editing && isActive) {
            return (
              <Box key={field}>
                <Text bold color="cyan">{marker} </Text>
                <Text bold>{labels[field]}: </Text>
                <TextInput key={inputKey} defaultValue={field === "apiKey" ? apiKey : field === "baseURL" ? baseURL : model} onSubmit={handleEditSubmit} />
              </Box>
            );
          }
          return (
            <Box key={field}>
              <Text color={isActive ? "cyan" : undefined} bold={isActive}>{marker} </Text>
              <Text dimColor={!isActive}>{labels[field]}: </Text>
              <Text>{displays[field]}</Text>
              {isActive && <Text dimColor> ({hints[field]})</Text>}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        {testStatus === "idle" && <Text dimColor>Press <Text bold>t</Text> to test, <Text bold>n</Text> to continue</Text>}
        {testStatus === "testing" && <Spinner label=" Testing connection..." />}
        {testStatus === "success" && <Text color="green">{"✓ "}Connection OK! Press <Text bold>n</Text> to continue.</Text>}
        {testStatus === "error" && (
          <Box flexDirection="column">
            <Text color="red">{"✗ "}{testError}</Text>
            <Text dimColor>Fix config, press <Text bold>t</Text> to retry.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ─── Step 2: Feishu ─────────────────────────────────────

const FEISHU_FIELDS = ["appId", "appSecret"] as const;
type FeishuField = (typeof FEISHU_FIELDS)[number];

function FeishuStep({
  appId, setAppId,
  appSecret, setAppSecret,
  onSave, onBack,
}: {
  appId: string; setAppId: (v: string) => void;
  appSecret: string; setAppSecret: (v: string) => void;
  onSave: () => void; onBack: () => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  const activeField = FEISHU_FIELDS[activeIdx]!;

  function handleEditSubmit(value: string) {
    if (activeField === "appId") setAppId(value);
    else if (activeField === "appSecret") setAppSecret(value);
    setEditing(false);
  }

  useInput((input, key) => {
    if (editing) { if (key.escape) setEditing(false); return; }
    if (key.upArrow) setActiveIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setActiveIdx((i) => Math.min(FEISHU_FIELDS.length - 1, i + 1));
    else if (key.return) { setEditing(true); setInputKey((k) => k + 1); }
    else if (input === "s") onSave();
    else if (input === "b" || key.escape) onBack();
  });

  const labels: Record<FeishuField, string> = { appId: "App ID    ", appSecret: "App Secret" };
  const displays: Record<FeishuField, string> = {
    appId: appId || "(empty)",
    appSecret: appSecret ? maskKey(appSecret) : "(empty)",
  };
  const hints: Record<FeishuField, string> = {
    appId: "Enter to edit",
    appSecret: "Enter to edit",
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Step 2/2 — Feishu</Text>
      <Text dimColor>↑↓ navigate, Enter edit/toggle, s save, b back</Text>

      <Box flexDirection="column" marginTop={1}>
        {FEISHU_FIELDS.map((field, idx) => {
          const isActive = idx === activeIdx;
          const marker = isActive ? "❯" : " ";
          if (editing && isActive) {
            return (
              <Box key={field}>
                <Text bold color="cyan">{marker} </Text>
                <Text bold>{labels[field]}: </Text>
                <TextInput key={inputKey} defaultValue={field === "appId" ? appId : appSecret} onSubmit={handleEditSubmit} />
              </Box>
            );
          }
          return (
            <Box key={field}>
              <Text color={isActive ? "cyan" : undefined} bold={isActive}>{marker} </Text>
              <Text dimColor={!isActive}>{labels[field]}: </Text>
              <Text>{displays[field]}</Text>
              {isActive && <Text dimColor> ({hints[field]})</Text>}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Press <Text bold>s</Text> to save all, <Text bold>b</Text> to go back</Text>
      </Box>
    </Box>
  );
}

// ─── Main Wizard ─────────────────────────────────────────

export function SetupWizard({ initialConfig, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("llm");

  // LLM state
  const [apiKey, setApiKey] = useState(initialConfig?.provider.apiKey ?? "");
  const [baseURL, setBaseURL] = useState(initialConfig?.provider.baseURL ?? "");
  const [model, setModel] = useState(initialConfig?.provider.model ?? "claude-sonnet-4-20250514");

  // Feishu state
  const [feishuAppId, setFeishuAppId] = useState(initialConfig?.feishu.appId ?? "");
  const [feishuAppSecret, setFeishuAppSecret] = useState(initialConfig?.feishu.appSecret ?? "");

  function handleSave() {
    const config = frailConfigSchema.parse({
      provider: {
        model,
        ...(apiKey && { apiKey }),
        ...(baseURL && { baseURL }),
      },
      feishu: {
        enabled: !!(feishuAppId && feishuAppSecret),
        appId: feishuAppId,
        appSecret: feishuAppSecret,
      },
      workDir: process.cwd(),
    });
    onComplete(config);
  }

  if (step === "llm") {
    return (
      <LlmStep
        apiKey={apiKey} setApiKey={setApiKey}
        baseURL={baseURL} setBaseURL={setBaseURL}
        model={model} setModel={setModel}
        onNext={() => setStep("feishu")}
      />
    );
  }

  return (
    <FeishuStep
      appId={feishuAppId} setAppId={setFeishuAppId}
      appSecret={feishuAppSecret} setAppSecret={setFeishuAppSecret}
      onSave={handleSave}
      onBack={() => setStep("llm")}
    />
  );
}
