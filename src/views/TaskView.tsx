import React, { useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import { NotesPane } from "../components/NotesPane.js";
import { TerminalPane } from "../components/TerminalPane.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { processChord } from "../utils/keyboard.js";
import { formatGitStatus, getGitStatus } from "../services/git.js";
import { closeTask as dbCloseTask, updateTask } from "../services/db.js";
import { deleteWorktree } from "../services/worktree.js";

export function TaskView() {
  const activeTask = useStore((s) => s.activeTask);
  const activeProject = useStore((s) => s.activeProject);
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const chordBuffer = useStore((s) => s.chordBuffer);
  const setChordBuffer = useStore((s) => s.setChordBuffer);
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const setGitStatus = useStore((s) => s.setGitStatus);

  // Poll git status
  useEffect(() => {
    if (!activeTask?.worktree_path) return;
    const poll = () => {
      getGitStatus(activeTask.worktree_path!, activeTask.branch_name || undefined).then(
        (status) => setGitStatus(activeTask.id, status)
      );
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [activeTask?.id]);

  useInput((input, key) => {
    if (modal) return;

    // When a pane is focused, only Esc unfocuses
    if (focusPane !== "none") {
      if (key.escape) {
        setFocusPane("none");
      }
      return;
    }

    // Esc when nothing is focused → go back to task list
    if (key.escape) {
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

    // Close task
    if (input === "x" && !key.super && activeTask) {
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

  const handleCloseTask = async () => {
    if (!activeTask || !activeProject) return;
    if (activeTask.worktree_path) {
      await deleteWorktree(activeProject.path, activeTask.worktree_path);
    }
    dbCloseTask(activeTask.id);
    setActiveTask(null);
    setModal(null);
    setView("tasks");
  };

  if (!activeTask) return null;

  const gitStatus = gitStatuses[activeTask.id];

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color="cyan">
            {activeTask.label}
          </Text>
          {gitStatus && (
            <Text dimColor> {formatGitStatus(gitStatus)}</Text>
          )}
        </Box>
        {!activeTask.model && (
          <Text dimColor color="yellow">
            cl: Claude  co: Codex
          </Text>
        )}
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
