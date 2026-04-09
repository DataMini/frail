import React from "react";
import { Box } from "ink";
import { MessageList, type DisplayMessage } from "./MessageList";
import { InputBar } from "./InputBar";
import { StatusBar } from "./StatusBar";

interface ChatViewProps {
  messages: DisplayMessage[];
  streamingMessage: DisplayMessage | null;
  isLoading: boolean;
  onSubmit: (text: string) => void;
  model: string;
  threadTitle: string;
  feishuStatus?: string;
}

export function ChatView({
  messages,
  streamingMessage,
  isLoading,
  onSubmit,
  model,
  threadTitle,
  feishuStatus,
}: ChatViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <MessageList
        messages={messages}
        streamingMessage={streamingMessage}
        isLoading={isLoading}
      />
      <InputBar onSubmit={onSubmit} disabled={isLoading} />
      <StatusBar
        model={model}
        threadTitle={threadTitle}
        feishuStatus={feishuStatus}
      />
    </Box>
  );
}
