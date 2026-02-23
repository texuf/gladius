import React from "react";
import { Box, Text } from "ink";
import { useStore } from "../store/index.js";

interface TerminalPaneProps {
  type: "terminal" | "console";
  label: string;
  focusKey: string;
}

/**
 * Phase 1 placeholder for terminal panes.
 * Full PTY + xterm-headless integration is Phase 2.
 */
export function TerminalPane({ type, label, focusKey }: TerminalPaneProps) {
  const focusPane = useStore((s) => s.focusPane);
  const activeTask = useStore((s) => s.activeTask);
  const isFocused = focusPane === type;

  const modelLabel =
    type === "console" && activeTask?.model
      ? ` (${activeTask.model})`
      : "";

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? "double" : "single"}
      borderColor={isFocused ? "green" : "gray"}
      paddingX={1}
      width="100%"
      flexGrow={type === "console" ? 1 : 0}
      height={type === "terminal" ? 8 : undefined}
    >
      <Box justifyContent="space-between">
        <Text bold color={isFocused ? "green" : undefined}>
          {label}{modelLabel}
        </Text>
        <Text dimColor>{focusKey}: focus</Text>
      </Box>
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        {isFocused ? (
          <Text dimColor>
            [Terminal placeholder — PTY integration in Phase 2]
            {"\n"}Press Esc to unfocus
          </Text>
        ) : (
          <Text dimColor>Press {focusKey} to focus</Text>
        )}
      </Box>
    </Box>
  );
}
