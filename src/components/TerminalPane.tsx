import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import { useStore } from "../store/index.js";
import { EmbeddedTerminal } from "./EmbeddedTerminal.js";
import {
  buildLlmCommand,
  watchForClaudeSessionId,
  watchForCodexSessionId,
} from "../services/sessionCapture.js";
import { getSession, writeToSession } from "../services/terminalManager.js";
import { getProjectLinearTeam, updateTask } from "../services/db.js";
import { getLinearIssueContext } from "../services/linear.js";

interface TerminalPaneProps {
  type: "terminal" | "console";
  label: string;
  focusKey: string;
  layout?: "task" | "project";
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

const DEFAULT_PTY_ROWS = 10;

function getTerminalDimensions() {
  const totalCols = process.stdout.columns || 80;
  const paneRows = DEFAULT_PTY_ROWS + PANE_CHROME_ROWS;
  const ptyRows = DEFAULT_PTY_ROWS;
  const ptyCols = Math.max(40, totalCols - PANE_CHROME_COLS - 2); // 2 for outer paddingX
  return { paneRows, ptyRows, ptyCols };
}

function getConsoleDimensions(layout: "task" | "project") {
  const totalRows = process.stdout.rows || 24;
  const totalCols = process.stdout.columns || 80;
  const taskReservedRows = 2 + 4 + 4 + 13 + PANE_CHROME_ROWS + 2;
  const projectReservedRows = 2 + 5 + 13 + PANE_CHROME_ROWS + 2;
  const reservedRows =
    layout === "task" ? taskReservedRows : projectReservedRows;
  const ptyRows = Math.max(6, totalRows - reservedRows);
  const ptyCols = Math.max(40, totalCols - PANE_CHROME_COLS - 2);
  return { ptyRows, ptyCols };
}

export function TerminalPane({
  type,
  label,
  focusKey,
  layout = "task",
  paused = false,
  workspaceId,
  cwd,
  model,
  captureSessionIds,
}: TerminalPaneProps) {
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const activeTask = useStore((s) => s.activeTask);
  const activeRepo = useStore((s) => s.activeRepo);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setTasks = useStore((s) => s.setTasks);
  const isFocused = focusPane === type;
  const [termError, setTermError] = useState("");
  const [linearStartupPrompt, setLinearStartupPrompt] = useState<string | null>(
    null,
  );
  const [linearPromptLoading, setLinearPromptLoading] = useState(false);
  const captureCleanupRef = useRef<(() => void) | null>(null);
  const seededLinearTaskIdsRef = useRef<Set<string>>(new Set());

  const isTaskScoped =
    workspaceId === undefined && cwd === undefined && model === undefined;
  const effectiveWorkspaceId = workspaceId ?? activeTask?.id ?? "";
  const effectiveCwd = cwd ?? activeTask?.worktree_path ?? null;
  const effectiveModel = model ?? activeTask?.model ?? null;
  const shouldCaptureSessionIds = captureSessionIds ?? isTaskScoped;
  const effectiveSessionId =
    type === "console" && effectiveModel && isTaskScoped && activeTask
      ? effectiveModel === "claude"
        ? activeTask.claude_session_id
        : activeTask.codex_session_id
      : undefined;

  const needsLinearStartupPrompt =
    type === "console" &&
    isTaskScoped &&
    !!activeTask &&
    !!effectiveCwd &&
    !!effectiveModel &&
    !effectiveSessionId &&
    !!activeTask.linear_issue_id &&
    !activeTask.linear_issue_started_at;

  useEffect(() => {
    if (!needsLinearStartupPrompt || !activeTask || !effectiveCwd) {
      setLinearStartupPrompt(null);
      setLinearPromptLoading(false);
      return;
    }

    let cancelled = false;
    setLinearPromptLoading(true);
    setLinearStartupPrompt(null);

    const issueId = activeTask.linear_issue_id!;
    const team = activeRepo
      ? getProjectLinearTeam(activeRepo.project_id)
      : "hnt-labs";

    getLinearIssueContext(effectiveCwd, issueId, team)
      .then((context) => {
        if (cancelled) return;
        const prompt = context
          ? [
              "Use this Linear issue as initial context for this task.",
              "",
              context,
            ].join("\n")
          : "";
        setLinearStartupPrompt(prompt);
      })
      .finally(() => {
        if (!cancelled) setLinearPromptLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    needsLinearStartupPrompt,
    activeTask?.id,
    effectiveCwd,
    activeRepo?.project_id,
  ]);

  const modelLabel =
    type === "console" && effectiveModel ? ` (${effectiveModel})` : "";

  const canEmbed =
    type === "terminal"
      ? !!effectiveCwd
      : !!(effectiveModel && effectiveCwd) &&
        (!needsLinearStartupPrompt || !linearPromptLoading);

  const dims = canEmbed
    ? type === "terminal"
      ? getTerminalDimensions()
      : null
    : null;
  const consoleDims =
    canEmbed && type === "console" ? getConsoleDimensions(layout) : null;

  const command =
    type === "console" && effectiveModel
      ? buildLlmCommand(
          effectiveModel,
          effectiveSessionId,
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
    )
      return;

    const onCapture = (sessionId: string) => {
      if (activeTask.model === "claude") {
        const updates = { claude_session_id: sessionId };
        updateTask(activeTask.id, updates);
        setActiveTask({ ...activeTask, ...updates });
        setTasks(
          useStore
            .getState()
            .tasks.map((t) =>
              t.id === activeTask.id ? { ...t, ...updates } : t,
            ),
        );
      } else {
        const updates = { codex_session_id: sessionId };
        updateTask(activeTask.id, updates);
        setActiveTask({ ...activeTask, ...updates });
        setTasks(
          useStore
            .getState()
            .tasks.map((t) =>
              t.id === activeTask.id ? { ...t, ...updates } : t,
            ),
        );
      }
    };

    // If session already exists but ID was never captured, backfill from disk
    const sessionKey = `${activeTask.id}-console`;
    const session = getSession(sessionKey);
    const backfill = !!session && !session.isNew;

    if (activeTask.model === "claude") {
      captureCleanupRef.current = watchForClaudeSessionId(
        activeTask.worktree_path!,
        onCapture,
        backfill,
      );
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

  const placeholderText =
    type === "console"
      ? effectiveModel
        ? needsLinearStartupPrompt && linearPromptLoading
          ? "Loading Linear issue context..."
          : "[No worktree — create one first]"
        : "Press cl (Claude) or co (Codex) to start"
      : "[No worktree — create one first]";

  const embeddedTaskId = effectiveWorkspaceId
    ? `${effectiveWorkspaceId}-${type}`
    : "";
  const embeddedKey =
    type === "console"
      ? `${embeddedTaskId}-${effectiveModel ?? "none"}`
      : embeddedTaskId;

  const handleSessionReady = useCallback(
    async (isNewSession: boolean) => {
      if (
        type !== "console" ||
        !isTaskScoped ||
        !activeTask ||
        !activeTask.linear_issue_id ||
        activeTask.linear_issue_started_at ||
        !isNewSession
      ) {
        return;
      }

      if (seededLinearTaskIdsRef.current.has(activeTask.id)) return;
      seededLinearTaskIdsRef.current.add(activeTask.id);

      const prompt = linearStartupPrompt?.trim();
      if (prompt) {
        const sessionKey = `${activeTask.id}-console`;
        const promptText = `${prompt}\n`;
        // Send prompt shortly after process startup to avoid shell/argv edge cases.
        setTimeout(() => {
          writeToSession(sessionKey, promptText);
        }, 1200);
      }

      const startedAt = new Date().toISOString();
      const updates = { linear_issue_started_at: startedAt };

      updateTask(activeTask.id, updates);
      setActiveTask({ ...activeTask, ...updates });
      setTasks(
        useStore
          .getState()
          .tasks.map((t) =>
            t.id === activeTask.id ? { ...t, ...updates } : t,
          ),
      );
    },
    [
      activeTask,
      isTaskScoped,
      linearStartupPrompt,
      setActiveTask,
      setTasks,
      type,
    ],
  );

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? "double" : "single"}
      borderColor={isFocused ? "green" : "gray"}
      paddingX={1}
      width="100%"
      flexGrow={type === "console" ? 1 : 0}
      height={
        canEmbed && type === "terminal"
          ? dims!.paneRows
          : type === "terminal"
            ? 5
            : undefined
      }
    >
      <Box justifyContent="space-between">
        <Text bold color={isFocused ? "green" : undefined}>
          {label}
          {modelLabel}
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
          onSessionReady={handleSessionReady}
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
                ? effectiveModel
                  ? "Press c to focus  (l/o: switch model)"
                  : "cl: claude / co: codex"
                : `Press ${focusKey} to focus`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
