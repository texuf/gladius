import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { useStore } from "../store/index.js";
import { EmbeddedTerminal } from "./EmbeddedTerminal.js";
import { buildLlmCommand, watchForClaudeSessionId, watchForCodexSessionId } from "../services/sessionCapture.js";
import { getSession } from "../services/terminalManager.js";
import { updateTask } from "../services/db.js";

interface TerminalPaneProps {
  type: "terminal" | "console";
  label: string;
  focusKey: string;
  paused?: boolean;
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

function getConsoleDimensions() {
  const totalRows = process.stdout.rows || 24;
  const totalCols = process.stdout.columns || 80;
  // Total minus: header(2) + notes(4) + terminal pane(13) + console chrome(3) + outer padding(2)
  const ptyRows = Math.max(6, totalRows - 2 - 4 - 13 - PANE_CHROME_ROWS - 2);
  const ptyCols = Math.max(40, totalCols - PANE_CHROME_COLS - 2);
  return { ptyRows, ptyCols };
}

export function TerminalPane({ type, label, focusKey, paused = false }: TerminalPaneProps) {
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const activeTask = useStore((s) => s.activeTask);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const isFocused = focusPane === type;
  const [termError, setTermError] = useState("");
  const captureCleanupRef = useRef<(() => void) | null>(null);

  const modelLabel =
    type === "console" && activeTask?.model
      ? ` (${activeTask.model})`
      : "";

  const canEmbed = type === "terminal"
    ? !!activeTask?.worktree_path
    : !!(activeTask?.model && activeTask?.worktree_path);

  const dims = canEmbed
    ? (type === "terminal" ? getTerminalDimensions() : null)
    : null;
  const consoleDims = canEmbed && type === "console" ? getConsoleDimensions() : null;

  const command = type === "console" && activeTask?.model
    ? buildLlmCommand(
        activeTask.model,
        activeTask.model === "claude"
          ? (activeTask.claude_session_id ?? activeTask.session_id)
          : (activeTask.codex_session_id ?? activeTask.session_id),
        activeTask.worktree_path ?? undefined
      )
    : undefined;

  // Session ID capture for console pane
  useEffect(() => {
    if (type !== "console" || !canEmbed || !activeTask) return;

    // Check if this is a new session that needs capture
    const sessionKey = `${activeTask.id}-console`;
    const session = getSession(sessionKey);
    if (!session?.isNew) return;
    // Already have a provider-specific session_id, no need to capture
    if (
      (activeTask.model === "claude" && activeTask.claude_session_id) ||
      (activeTask.model === "codex" && activeTask.codex_session_id)
    ) return;

    const onCapture = (sessionId: string) => {
      if (activeTask.model === "claude") {
        const updates = { claude_session_id: sessionId, session_id: sessionId };
        updateTask(activeTask.id, updates);
        setActiveTask({ ...activeTask, ...updates });
      } else {
        const updates = { codex_session_id: sessionId, session_id: sessionId };
        updateTask(activeTask.id, updates);
        setActiveTask({ ...activeTask, ...updates });
      }
    };

    if (activeTask.model === "claude") {
      captureCleanupRef.current = watchForClaudeSessionId(activeTask.worktree_path!, onCapture);
    } else if (activeTask.model === "codex") {
      captureCleanupRef.current = watchForCodexSessionId(onCapture);
    }

    return () => {
      captureCleanupRef.current?.();
      captureCleanupRef.current = null;
    };
  }, [activeTask?.id, activeTask?.model, canEmbed]);

  const placeholderText = type === "console"
    ? (activeTask?.model
      ? "[No worktree — create one first]"
      : "Press cl (Claude) or co (Codex) to start")
    : "[No worktree — create one first]";

  const embeddedTaskId = activeTask ? `${activeTask.id}-${type}` : "";
  const embeddedKey = type === "console" ? `${embeddedTaskId}-${activeTask?.model ?? "none"}` : embeddedTaskId;

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? "double" : "single"}
      borderColor={isFocused ? "green" : "gray"}
      paddingX={1}
      width="100%"
      flexGrow={type === "console" ? 1 : 0}
      height={canEmbed && type === "terminal" ? dims!.paneRows : type === "terminal" ? 5 : undefined}
    >
      <Box justifyContent="space-between">
        <Text bold color={isFocused ? "green" : undefined}>
          {label}{modelLabel}
        </Text>
        <Text dimColor>{focusKey}: focus</Text>
      </Box>

      {canEmbed && !termError ? (
        <EmbeddedTerminal
          key={embeddedKey}
          taskId={embeddedTaskId}
          cwd={activeTask!.worktree_path!}
          command={command}
          focused={isFocused}
          paused={paused}
          singleEsc={type === "console"}
          rows={type === "terminal" ? dims!.ptyRows : consoleDims!.ptyRows}
          cols={type === "terminal" ? dims!.ptyCols : consoleDims!.ptyCols}
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
              {placeholderText}
              {"\n"}Press {type === "console" ? "Esc" : "Esc×2"} to unfocus
            </Text>
          ) : (
            <Text dimColor>
              {type === "console"
                ? (activeTask?.model ? "Press c to focus  (l/o: switch model)" : "cl: claude / co: codex")
                : `Press ${focusKey} to focus`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
