import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";

export interface ToolCallInfo {
  name: string;
  args?: string;
  status?: "running" | "done";
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool"; toolCall: ToolCallInfo };

export interface DisplayMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCallInfo[];
  blocks?: ContentBlock[];
  source?: "feishu" | "tui";
}

interface MessageListProps {
  messages: DisplayMessage[];
  streamingMessage: DisplayMessage | null;
  isLoading: boolean;
}

function formatToolCall(tc: ToolCallInfo): string {
  if (tc.args) return `${tc.name}(${tc.args})`;
  return tc.name;
}

function ToolCallLine({ tc }: { tc: ToolCallInfo }) {
  if (tc.status === "running") {
    return (
      <Box flexDirection="row">
        <Box marginRight={1}><Spinner /></Box>
        <Box flexGrow={1}>
          <Text color="yellow" bold wrap="wrap">{formatToolCall(tc)}</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Text color="green" wrap="wrap">
      {"● "}<Text bold>{formatToolCall(tc)}</Text>
    </Text>
  );
}

function legacyToBlocks(message: DisplayMessage): ContentBlock[] {
  const result: ContentBlock[] = [];
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      result.push({ type: "tool", toolCall: tc });
    }
  }
  if (message.content) {
    result.push({ type: "text", text: message.content });
  }
  return result;
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

  const blocks = message.blocks ?? legacyToBlocks(message);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {blocks.map((block, i) => {
        if (block.type === "tool") {
          return <ToolCallLine key={i} tc={block.toolCall} />;
        }
        return block.text ? (
          <Box key={i} marginLeft={2}>
            <Text wrap="wrap">
              {block.text}
              {streaming && i === blocks.length - 1 && <Text dimColor>▌</Text>}
            </Text>
          </Box>
        ) : streaming && i === blocks.length - 1 ? (
          <Box key={i} marginLeft={2}>
            <Text dimColor>▌</Text>
          </Box>
        ) : null;
      })}
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
