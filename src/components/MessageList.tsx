import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";

export interface ToolCallInfo {
  name: string;
  args?: string;
  status?: "running" | "done";
}

export interface DisplayMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCallInfo[];
  source?: "feishu" | "tui";
}

interface MessageListProps {
  messages: DisplayMessage[];
  streamingMessage: DisplayMessage | null;
  isLoading: boolean;
}

function formatToolName(name: string): string {
  const match = name.match(/^mcp__([^_]+)__(.+)$/);
  if (match) return `${match[1]}/${match[2]}`;
  return name;
}

function formatToolCall(tc: ToolCallInfo): string {
  const name = formatToolName(tc.name);
  if (tc.args) return `${name}(${tc.args})`;
  return name;
}

function ToolCallLine({ tc }: { tc: ToolCallInfo }) {
  if (tc.status === "running") {
    return (
      <Box>
        <Spinner />
        <Text color="yellow">
          {" "}<Text bold>{formatToolCall(tc)}</Text>
        </Text>
      </Box>
    );
  }
  return (
    <Text color="green">
      {"● "}<Text bold>{formatToolCall(tc)}</Text>
    </Text>
  );
}

function MessageBubble({
  message,
  streaming,
}: {
  message: DisplayMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    const sourceTag = message.source === "feishu" ? "[Feishu] " : "";
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text backgroundColor="#333333" wrap="wrap">
          {" ❯ "}{sourceTag}{message.content}{" "}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.toolCalls?.map((tc, i) => (
        <ToolCallLine key={i} tc={tc} />
      ))}
      {message.content ? (
        <Box marginLeft={2}>
          <Text wrap="wrap">
            {message.content}
            {streaming && <Text dimColor>▌</Text>}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function MessageList({
  messages,
  streamingMessage,
  isLoading,
}: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}
      {streamingMessage && (
        <MessageBubble message={streamingMessage} streaming />
      )}
      {isLoading && !streamingMessage && (
        <Box marginBottom={1}>
          <Spinner label=" Thinking..." />
        </Box>
      )}
    </Box>
  );
}
