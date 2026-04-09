import React, { useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import { getCommandCompletions } from "../commands/index";

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

const EMPTY: string[] = [];

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [completions, setCompletions] = useState<string[]>(EMPTY);
  const [inputKey, setInputKey] = useState(0);
  const completionsRef = useRef<string[]>(EMPTY);

  // Stable reference — critical for @inkjs/ui TextInput which puts onChange in useEffect deps
  const handleChange = useCallback((newValue: string) => {
    if (newValue.startsWith("/") && !newValue.includes(" ")) {
      const matches = getCommandCompletions(newValue);
      const next = matches.map((c) => `/${c.name}`);
      if (next.join() !== completionsRef.current.join()) {
        completionsRef.current = next;
        setCompletions(next);
      }
    } else {
      if (completionsRef.current.length > 0) {
        completionsRef.current = EMPTY;
        setCompletions(EMPTY);
      }
    }
  }, []);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      let toSubmit = text.trim();

      // If partial slash command with completions, auto-complete to first match
      if (
        toSubmit.startsWith("/") &&
        !toSubmit.includes(" ") &&
        completionsRef.current.length > 0
      ) {
        toSubmit = completionsRef.current[0]!;
      }

      completionsRef.current = EMPTY;
      setCompletions(EMPTY);
      setInputKey((k) => k + 1);
      onSubmit(toSubmit);
    },
    [onSubmit]
  );

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Text dimColor>{"─".repeat(process.stdout.columns || 80)}</Text>

      {/* Input area */}
      <Box paddingX={1}>
        <Text bold>{"❯ "}</Text>
        {disabled ? (
          <Text dimColor>waiting for response...</Text>
        ) : (
          <Box flexGrow={1}>
            <TextInput
              key={inputKey}
              onChange={handleChange}
              onSubmit={handleSubmit}
              placeholder=""
            />
          </Box>
        )}
      </Box>

      {/* Bottom divider */}
      <Text dimColor>{"─".repeat(process.stdout.columns || 80)}</Text>

      {/* Completions below divider */}
      {completions.length > 0 && (
        <Box paddingX={1} gap={2}>
          {completions.map((c) => (
            <Text key={c} dimColor>
              {c}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
