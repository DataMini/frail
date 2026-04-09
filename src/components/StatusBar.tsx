import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  model: string;
  threadTitle: string;
  feishuStatus?: string;
}

export function StatusBar({ model, threadTitle, feishuStatus }: StatusBarProps) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text bold color="cyan">
          frail
        </Text>
        <Text dimColor>{model}</Text>
        <Text dimColor>
          thread: <Text color="green">{threadTitle}</Text>
        </Text>
      </Box>
      <Box gap={2}>
        {feishuStatus && (
          <Text dimColor>
            Feishu: <Text color={feishuStatus === "connected" ? "green" : "yellow"}>{feishuStatus}</Text>
          </Text>
        )}
        <Text dimColor>/help</Text>
      </Box>
    </Box>
  );
}
