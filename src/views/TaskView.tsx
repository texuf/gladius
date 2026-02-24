import React, { useEffect } from "react";
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
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const setGitStatus = useStore((s) => s.setGitStatus);
  const taskStatuses = useStore((s) => s.taskStatuses);

  // Poll git status (fast) and PR status (slower, separate)
  useEffect(() => {
    if (!activeTask?.worktree_path) return;
    const pollGit = () => {
      getGitStatus(activeTask.worktree_path!, activeTask.branch_name || undefined).then(
        (status) => {
          // Preserve existing PR data from the slower PR poll
          const existing = useStore.getState().gitStatuses[activeTask.id];
          if (existing?.pr) status.pr = existing.pr;
          setGitStatus(activeTask.id, status);
        }
      );
    };
    const pollPr = () => {
      getGitStatusWithPr(activeTask.worktree_path!, activeTask.branch_name || undefined).then(
        (status) => setGitStatus(activeTask.id, status)
      );
    };
    pollGit();
    pollPr();
    const gitInterval = setInterval(pollGit, 5000);
    const prInterval = setInterval(pollPr, 30000);
    return () => { clearInterval(gitInterval); clearInterval(prInterval); };
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
          {gitStatus && (
            <Text dimColor> {formatGitStatus(gitStatus)}</Text>
          )}
          {gitStatus?.pr && (
            <Text color={gitStatus.pr.state === "open" ? "green" : gitStatus.pr.state === "merged" ? "magenta" : "red"}>
              {" "}{formatPrStatus(gitStatus.pr)}
            </Text>
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
