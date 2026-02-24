import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import { NotesPane } from "../components/NotesPane.js";
import { TerminalPane } from "../components/TerminalPane.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { processChord } from "../utils/keyboard.js";
import { formatGitStatus, formatPrStatus, getGitStatus, getGitStatusWithPr } from "../services/git.js";
import { closeTask as dbCloseTask, updateTask, getTasksForProject } from "../services/db.js";
import { deleteWorktree } from "../services/worktree.js";
import { destroySession } from "../services/terminalManager.js";
import { StatusDots } from "../components/StatusDots.js";

export function TaskView() {
  const activeTask = useStore((s) => s.activeTask);
  const activeProject = useStore((s) => s.activeProject);
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const chordBuffer = useStore((s) => s.chordBuffer);
  const setChordBuffer = useStore((s) => s.setChordBuffer);
  const escCooldownRef = useRef(0);
  const gitIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const setGitStatus = useStore((s) => s.setGitStatus);
  const taskStatuses = useStore((s) => s.taskStatuses);
  const [fetching, setFetching] = useState(false);

  // Poll git status (fast) and PR status (slower, separate)
  const pollGit = () => {
    if (!activeTask?.worktree_path) return Promise.resolve();
    return getGitStatus(activeTask.worktree_path, activeTask.branch_name || undefined).then(
      (status) => {
        const existing = useStore.getState().gitStatuses[activeTask.id];
        if (existing?.pr) status.pr = existing.pr;
        setGitStatus(activeTask.id, status);
      }
    );
  };
  const pollPr = () => {
    if (!activeTask?.worktree_path) return Promise.resolve();
    return getGitStatusWithPr(activeTask.worktree_path, activeTask.branch_name || undefined).then(
      (status) => setGitStatus(activeTask.id, status)
    );
  };

  const startPolling = () => {
    if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
    if (prIntervalRef.current) clearInterval(prIntervalRef.current);
    pollGit();
    pollPr();
    gitIntervalRef.current = setInterval(pollGit, 5000);
    prIntervalRef.current = setInterval(pollPr, 30000);
  };

  useEffect(() => {
    if (!activeTask?.worktree_path) return;
    startPolling();
    return () => {
      if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
      if (prIntervalRef.current) clearInterval(prIntervalRef.current);
    };
  }, [activeTask?.id]);

  useInput((input, key) => {
    if (modal) return;

    // When a pane is focused, only Esc unfocuses
    if (focusPane !== "none") {
      if (key.escape) {
        setFocusPane("none");
        escCooldownRef.current = Date.now();
      }
      return;
    }

    // Esc when nothing is focused → go back to task list
    // Skip if we just unfocused a pane (Ink sees the same Esc event)
    if (key.escape) {
      if (Date.now() - escCooldownRef.current < 100) return;
      setView("tasks");
      return;
    }

    // Pane focus keys
    if (input === "i" && !key.super) {
      setFocusPane("notes");
      return;
    }

    if (input === "t" && !key.super) {
      setFocusPane("terminal");
      return;
    }

    if (input === "c" && !key.super && activeTask?.model) {
      setFocusPane("console");
      return;
    }

    // Refresh git + PR status and reset polling
    if (input === "r" && !key.super) {
      setFetching(true);
      if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
      if (prIntervalRef.current) clearInterval(prIntervalRef.current);
      const gitP = pollGit();
      const prP = pollPr();
      Promise.all([gitP, prP]).then(() => {
        setFetching(false);
        gitIntervalRef.current = setInterval(pollGit, 5000);
        prIntervalRef.current = setInterval(pollPr, 30000);
      });
      return;
    }

    // Close task
    if ((input === "d" || input === "x") && !key.super && activeTask) {
      setModal({
        type: "confirm",
        message: `Close task '${activeTask.label}'? This will delete the worktree.`,
        onConfirm: () => handleCloseTask(),
      });
      return;
    }

    // Chord handling for model selection
    if (!activeTask?.model) {
      const { newBuffer, chord } = processChord(chordBuffer, input, key);
      setChordBuffer(newBuffer);

      if (chord === "cl" || chord === "co") {
        const model = chord === "cl" ? "claude" : "codex";
        if (activeTask) {
          updateTask(activeTask.id, { model });
          setActiveTask({ ...activeTask, model });
          setFocusPane("console");
        }
      }
    }
  });

  const setTasks = useStore((s) => s.setTasks);

  const handleCloseTask = async () => {
    if (!activeTask || !activeProject) return;
    // Persist session_id if captured during this session
    if (activeTask.session_id) {
      updateTask(activeTask.id, { session_id: activeTask.session_id });
    }
    destroySession(`${activeTask.id}-terminal`);
    destroySession(`${activeTask.id}-console`);
    if (activeTask.worktree_path) {
      await deleteWorktree(activeProject.path, activeTask.worktree_path, activeTask.branch_name);
    }
    dbCloseTask(activeTask.id);
    setTasks(getTasksForProject(activeProject.id));
    setActiveTask(null);
    setModal(null);
    setView("tasks");
  };

  if (!activeTask) return null;

  const gitStatus = gitStatuses[activeTask.id];

  // Aggregate status dots for OTHER tasks
  const otherDots = { green: 0, red: 0, orange: 0 };
  for (const [taskId, color] of Object.entries(taskStatuses)) {
    if (taskId === activeTask.id) continue;
    if (color === "green") otherDots.green++;
    else if (color === "red") otherDots.red++;
    else if (color === "orange") otherDots.orange++;
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color="cyan">
            {activeTask.label}
          </Text>
          {fetching ? (
            <Text dimColor> Fetching...</Text>
          ) : (
            <>
              {gitStatus && (
                <Text dimColor> {formatGitStatus(gitStatus)}</Text>
              )}
              {gitStatus?.pr && (
                <Text color={
                  gitStatus.pr.ciFailed > 0 || gitStatus.pr.unresolvedThreads > 0 ? "red"
                    : gitStatus.pr.state === "merged" ? "magenta"
                    : "green"
                }>
                  {" "}{formatPrStatus(gitStatus.pr)}
                </Text>
              )}
            </>
          )}
        </Box>
        <Box gap={1}>
          <StatusDots {...otherDots} />
          {!activeTask.model && (
            <Text dimColor color="yellow">
              cl: Claude  co: Codex
            </Text>
          )}
        </Box>
      </Box>

      {/* Notes Pane (20%) */}
      <NotesPane />

      {/* Terminal Pane (15%) */}
      <TerminalPane type="terminal" label="Terminal" focusKey="t" />

      {/* Console Pane (65%) */}
      <TerminalPane type="console" label="Console" focusKey="c" />

      {/* Confirm Modal */}
      {modal?.type === "confirm" && (
        <ConfirmModal
          message={modal.message}
          onConfirm={modal.onConfirm}
          onCancel={() => setModal(null)}
        />
      )}
    </Box>
  );
}
