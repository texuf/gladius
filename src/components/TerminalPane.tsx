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
  workspaceId?: string;
  cwd?: string | null;
  model?: "claude" | "codex" | null;
  captureSessionIds?: boolean;
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

export function TerminalPane({
  type,
  label,
  focusKey,
  paused = false,
  workspaceId,
  cwd,
  model,
  captureSessionIds,
}: TerminalPaneProps) {
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const activeTask = useStore((s) => s.activeTask);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setTasks = useStore((s) => s.setTasks);
  const isFocused = focusPane === type;
  const [termError, setTermError] = useState("");
  const captureCleanupRef = useRef<(() => void) | null>(null);

  const isTaskScoped =
    workspaceId === undefined &&
    cwd === undefined &&
    model === undefined;
  const effectiveWorkspaceId = workspaceId ?? activeTask?.id ?? "";
  const effectiveCwd = cwd ?? activeTask?.worktree_path ?? null;
  const effectiveModel = model ?? activeTask?.model ?? null;
  const shouldCaptureSessionIds = captureSessionIds ?? isTaskScoped;

  const modelLabel = type === "console" && effectiveModel ? ` (${effectiveModel})` : "";

  const canEmbed = type === "terminal"
    ? !!effectiveCwd
    : !!(effectiveModel && effectiveCwd);

  const dims = canEmbed
    ? (type === "terminal" ? getTerminalDimensions() : null)
    : null;
  const consoleDims = canEmbed && type === "console" ? getConsoleDimensions() : null;

  const command = type === "console" && effectiveModel
    ? buildLlmCommand(
        effectiveModel,
        isTaskScoped && activeTask
          ? effectiveModel === "claude"
            ? (activeTask.claude_session_id ?? activeTask.session_id)
            : (activeTask.codex_session_id ?? activeTask.session_id)
          : undefined,
        effectiveCwd ?? undefined,
      )
    : undefined;

  // Session ID capture for console pane — runs whenever session ID is missing
  useEffect(() => {
    if (
      type !== "console" ||
      !canEmbed ||
      !activeTask ||
      !isTaskScoped ||
      !shouldCaptureSessionIds
    ) {
      return;
    }

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
        setTasks(useStore.getState().tasks.map((t) => t.id === activeTask.id ? { ...t, ...updates } : t));
      } else {
        const updates = { codex_session_id: sessionId, session_id: sessionId };
        updateTask(activeTask.id, updates);
        setActiveTask({ ...activeTask, ...updates });
        setTasks(useStore.getState().tasks.map((t) => t.id === activeTask.id ? { ...t, ...updates } : t));
      }
    };

    // If session already exists but ID was never captured, backfill from disk
    const sessionKey = `${activeTask.id}-console`;
    const session = getSession(sessionKey);
    const backfill = !!session && !session.isNew;

    if (activeTask.model === "claude") {
      captureCleanupRef.current = watchForClaudeSessionId(activeTask.worktree_path!, onCapture, backfill);
    } else if (activeTask.model === "codex") {
      captureCleanupRef.current = watchForCodexSessionId(onCapture);
    }

    return () => {
      captureCleanupRef.current?.();
      captureCleanupRef.current = null;
    };
  }, [
    activeTask?.id,
    activeTask?.model,
    activeTask?.claude_session_id,
    activeTask?.codex_session_id,
    canEmbed,
    shouldCaptureSessionIds,
    isTaskScoped,
    type,
  ]);

  const placeholderText = type === "console"
    ? (effectiveModel
      ? "[No worktree — create one first]"
      : "Press cl (Claude) or co (Codex) to start")
    : "[No worktree — create one first]";

  const embeddedTaskId = effectiveWorkspaceId
    ? `${effectiveWorkspaceId}-${type}`
    : "";
  const embeddedKey = type === "console"
    ? `${embeddedTaskId}-${effectiveModel ?? "none"}`
    : embeddedTaskId;

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
          cwd={effectiveCwd!}
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
                ? (effectiveModel ? "Press c to focus  (l/o: switch model)" : "cl: claude / co: codex")
                : `Press ${focusKey} to focus`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
