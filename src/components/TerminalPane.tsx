import React, { useState } from "react";
import { Box, Text } from "ink";
import { useStore } from "../store/index.js";
import { EmbeddedTerminal } from "./EmbeddedTerminal.js";

interface TerminalPaneProps {
  type: "terminal" | "console";
  label: string;
  focusKey: string;
}

// Layout overhead for the terminal pane:
// 2 rows for border (top + bottom), 1 row for header label
const PANE_CHROME_ROWS = 3;
// 2 cols for border, 2 cols for paddingX
const PANE_CHROME_COLS = 4;

// Rows consumed by other TaskView elements:
// header (1) + marginBottom (1) + NotesPane (~4) + ConsolPane border+header (~3)
const TASKVIEW_OTHER_ROWS = 9;
const DEFAULT_PTY_ROWS = 10;

function getTerminalDimensions() {
  const totalCols = process.stdout.columns || 80;
  const paneRows = DEFAULT_PTY_ROWS + PANE_CHROME_ROWS;
  const ptyRows = DEFAULT_PTY_ROWS;
  const ptyCols = Math.max(40, totalCols - PANE_CHROME_COLS - 2); // 2 for outer paddingX
  return { paneRows, ptyRows, ptyCols };
}

export function TerminalPane({ type, label, focusKey }: TerminalPaneProps) {
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const activeTask = useStore((s) => s.activeTask);
  const isFocused = focusPane === type;
  const [termError, setTermError] = useState("");

  const modelLabel =
    type === "console" && activeTask?.model
      ? ` (${activeTask.model})`
      : "";

  const hasWorktree = type === "terminal" && activeTask?.worktree_path;
  const dims = hasWorktree ? getTerminalDimensions() : null;

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? "double" : "single"}
      borderColor={isFocused ? "green" : "gray"}
      paddingX={1}
      width="100%"
      flexGrow={type === "console" ? 1 : 0}
      height={hasWorktree ? dims!.paneRows : type === "terminal" ? 5 : undefined}
    >
      <Box justifyContent="space-between">
        <Text bold color={isFocused ? "green" : undefined}>
          {label}{modelLabel}
        </Text>
        <Text dimColor>{focusKey}: focus</Text>
      </Box>

      {hasWorktree && !termError ? (
        <EmbeddedTerminal
          cwd={activeTask.worktree_path!}
          focused={isFocused}
          rows={dims!.ptyRows}
          cols={dims!.ptyCols}
          onEsc={() => setFocusPane("none")}
          onError={(msg) => setTermError(msg)}
        />
      ) : termError ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text color="red">{termError}</Text>
        </Box>
      ) : (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          {isFocused ? (
            <Text dimColor>
              {type === "terminal"
                ? "[No worktree — create one first]"
                : "[Console placeholder — LLM integration in Phase 2]"}
              {"\n"}Press Esc to unfocus
            </Text>
          ) : (
            <Text dimColor>Press {focusKey} to focus</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
