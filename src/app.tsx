import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ChatView } from "./components/ChatView";
import { ThreadList } from "./components/ThreadList";
import { ConfigPanel } from "./components/ConfigPanel";
import { SetupWizard } from "./components/SetupWizard";
import { saveConfig } from "./config/loader";
import { useConfig } from "./hooks/useConfig";
import { useThreads } from "./hooks/useThreads";
import { useAgent } from "./hooks/useAgent";
import { matchCommand } from "./commands/index";
import type { ViewName } from "./commands/index";
import { commands } from "./commands/index";

interface AppProps {
  feishuStatus?: string;
}

export function App({ feishuStatus }: AppProps) {
  const { exit } = useApp();
  const { config, loading, replaceConfig } = useConfig();
  const {
    currentThread,
    threads,
    messages,
    switchThread,
    createThread,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    refreshThreads,
  } = useThreads();
  const { isLoading, streamingMessage, sendMessage } = useAgent();
  const [view, setView] = useState<ViewName>("chat");

  const handleSubmit = useCallback(
    (text: string) => {
      // Check for slash commands
      const cmd = matchCommand(text);
      if (cmd) {
        switch (cmd.name) {
          case "threads":
            refreshThreads();
            setView("threads");
            return;
          case "new":
            createThread();

            setView("chat");
            return;
          case "init":
            setView("init");
            return;
          case "config":
            setView("config");
            return;
          case "model":
            // Treat as /config for now
            setView("config");
            return;
          case "clear":
            clearMessages();

            return;
          case "help":
            setView("help");
            return;
          case "quit":
            exit();
            return;
        }
        return;
      }

      // Unknown slash command
      if (text.startsWith("/")) {
        const name = text.slice(1).split(/\s+/)[0];
        addAssistantMessage(`Unknown command: /${name}. Type /help for available commands.`);
        return;
      }

      // Regular chat message
      addUserMessage(text);
      sendMessage(text, (responseText, toolCalls) => {
        addAssistantMessage(responseText, toolCalls);
      });
    },
    [
      addUserMessage,
      addAssistantMessage,
      sendMessage,
      createThread,
      clearMessages,
      refreshThreads,
      exit,
    ]
  );

  if (loading || !config) {
    return (
      <Box padding={1}>
        <Text>Loading configuration...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {view === "chat" && (
        <ChatView
          messages={messages}
          streamingMessage={streamingMessage}
          isLoading={isLoading}
          onSubmit={handleSubmit}
          model={config.provider.model}
          threadTitle={currentThread?.title ?? "none"}
          feishuStatus={feishuStatus}
        />
      )}

      {view === "threads" && (
        <ThreadList
          threads={threads}
          currentThreadId={currentThread?.id ?? ""}
          onSelect={(id) => {
            switchThread(id);

            setView("chat");
          }}
          onBack={() => setView("chat")}
        />
      )}

      {view === "config" && (
        <ConfigPanel
          config={config}
          onSave={async (newConfig) => {
            await replaceConfig(newConfig);
          }}
          onBack={() => setView("chat")}
        />
      )}

      {view === "init" && (
        <SetupWizard
          initialConfig={config}
          onComplete={async (newConfig) => {
            await saveConfig(newConfig);
            await replaceConfig(newConfig);
            setView("chat");
          }}
        />
      )}

      {view === "help" && <HelpView onBack={() => setView("chat")} />}
    </Box>
  );
}

function HelpView({ onBack }: { onBack: () => void }) {
  useInput((_input, key) => {
    if (key.escape || _input === "q") {
      onBack();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        Available Commands <Text dimColor>(Escape to go back)</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {commands.map((cmd) => (
          <Text key={cmd.name}>
            <Text color="cyan">/{cmd.name}</Text>
            <Text dimColor> — {cmd.description}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape or q to go back to chat.</Text>
      </Box>
    </Box>
  );
}
