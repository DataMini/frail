import React from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import type { Thread } from "../db/threads";

interface ThreadListProps {
  threads: Thread[];
  currentThreadId: string;
  onSelect: (threadId: string) => void;
  onBack: () => void;
}

export function ThreadList({
  threads,
  currentThreadId,
  onSelect,
  onBack,
}: ThreadListProps) {
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
    }
  });

  const options = threads.map((t) => ({
    label: `${t.id === currentThreadId ? "● " : "  "}${t.title}  ${new Date(t.updatedAt).toLocaleString()}`,
    value: t.id,
  }));

  if (options.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>No threads yet. Press Escape to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>
          Threads <Text dimColor>(Escape to go back)</Text>
        </Text>
      </Box>
      <Select options={options} onChange={(value) => onSelect(value)} />
    </Box>
  );
}
