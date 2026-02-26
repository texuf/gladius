import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import {
  getTasksForProject,
  closeTask as dbCloseTask,
  swapTaskOrder,
  touchTask,
  createTask as dbCreateTask,
  reopenTask as dbReopenTask,
} from "../services/db.js";
import { formatGitStatus } from "../services/git.js";
import { generateLabel, deduplicateLabel } from "../utils/label.js";
import { createWorktree } from "../services/worktree.js";
import { deleteWorktree } from "../services/worktree.js";
import { BRANCH_PREFIX } from "../utils/constants.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { TextInputField } from "../components/TextInput.js";
import { StatusDots } from "../components/StatusDots.js";
import type { Task } from "../store/types.js";

export function TaskList() {
  const activeProject = useStore((s) => s.activeProject);
  const tasks = useStore((s) => s.tasks);
  const setTasks = useStore((s) => s.setTasks);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedIndex = useStore((s) => s.setSelectedIndex);
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const taskStatuses = useStore((s) => s.taskStatuses);

  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [creating, setCreating] = useState(false);

  const activeTasks = tasks.filter(
    (t) => t.status === "active" || t.status === "closing",
  );
  const closedTasks = tasks
    .filter((t) => t.status === "closed")
    .sort((a, b) =>
      (b.last_accessed_at || "").localeCompare(a.last_accessed_at || ""),
    );
  const allTasks = [...activeTasks, ...closedTasks];

  useInput((input, key) => {
    if (modal || creating) return;

    const selectedTask = allTasks[selectedIndex];

    if (key.upArrow && !key.shift) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow && !key.shift) {
      setSelectedIndex(Math.min(allTasks.length - 1, selectedIndex + 1));
    } else if (key.upArrow && key.shift) {
      // Reorder: swap with previous (active tasks only)
      if (
        selectedIndex > 0 &&
        selectedTask?.status === "active" &&
        activeTasks[selectedIndex - 1]
      ) {
        swapTaskOrder(
          activeTasks[selectedIndex].id,
          activeTasks[selectedIndex - 1].id,
        );
        reloadTasks();
        setSelectedIndex(selectedIndex - 1);
      }
    } else if (key.downArrow && key.shift) {
      // Reorder: swap with next (active tasks only)
      if (
        selectedIndex < activeTasks.length - 1 &&
        selectedTask?.status === "active" &&
        activeTasks[selectedIndex + 1]
      ) {
        swapTaskOrder(
          activeTasks[selectedIndex].id,
          activeTasks[selectedIndex + 1].id,
        );
        reloadTasks();
        setSelectedIndex(selectedIndex + 1);
      }
    } else if (key.return && selectedTask?.status === "active") {
      if (!activeProject) return;
      touchTask(selectedTask.id);
      const refreshedTasks = getTasksForProject(activeProject.id);
      setTasks(refreshedTasks);
      const refreshedTask =
        refreshedTasks.find((t) => t.id === selectedTask.id) ?? selectedTask;
      setActiveTask(refreshedTask);
      setView("taskView");
    } else if (key.return && selectedTask?.status === "closing") {
      // No-op — task is being closed
    } else if (key.return && selectedTask?.status === "closed") {
      handleReopenTask(selectedTask);
    } else if (input === "x" && selectedTask?.status === "active") {
      setModal({
        type: "confirm",
        message: `Close task '${selectedTask.label}'? This will delete the worktree.`,
        onConfirm: () => handleCloseTask(selectedTask),
      });
    }
  });

  const reloadTasks = useCallback(() => {
    if (activeProject) {
      const updated = getTasksForProject(activeProject.id);
      setTasks(updated);
    }
  }, [activeProject]);

  const handleCloseTask = (task: Task) => {
    // Mark as closing immediately
    setTasks(
      tasks.map((t) =>
        t.id === task.id ? { ...t, status: "closing" as const } : t,
      ),
    );
    setModal(null);

    // Run slow cleanup in background
    (async () => {
      if (task.worktree_path && activeProject) {
        await deleteWorktree(
          activeProject.path,
          task.worktree_path,
          task.branch_name,
        );
      }
      dbCloseTask(task.id);
      reloadTasks();
    })();
  };

  const handleReopenTask = async (task: Task) => {
    if (!activeProject) return;
    setCreating(true);
    try {
      const worktreePath = await createWorktree(activeProject.path, task.label);
      dbReopenTask(task.id, worktreePath);
      reloadTasks();
      const reopened = {
        ...task,
        status: "active" as const,
        worktree_path: worktreePath,
        closed_at: null,
      };
      setActiveTask(reopened);
      setView("taskView");
    } catch (e: any) {
      console.error("Failed to reopen task:", e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateTask = async (description: string) => {
    if (!description.trim() || !activeProject) return;

    setCreating(true);
    try {
      const existingLabels = tasks.map((t) => t.label);
      let label = generateLabel(description);
      label = deduplicateLabel(label, existingLabels);
      const branchName = `${BRANCH_PREFIX}/${label}`;

      const worktreePath = await createWorktree(activeProject.path, label);
      const task = dbCreateTask(
        activeProject.id,
        label,
        description,
        branchName,
        worktreePath,
      );

      reloadTasks();
      setModal(null);
      setNewTaskDesc("");

      // Open the new task
      setActiveTask(task);
      setView("taskView");
    } catch (e: any) {
      // TODO: show error
      console.error("Failed to create task:", e.message);
    } finally {
      setCreating(false);
    }
  };

  if (!activeProject) return null;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="cyan">
          {activeProject.name}
        </Text>
        {(() => {
          const dots = { green: 0, red: 0, orange: 0, yellow: 0, purple: 0 };
          for (const color of Object.values(taskStatuses)) {
            if (color === "green") dots.green++;
            else if (color === "red") dots.red++;
            else if (color === "orange") dots.orange++;
            else if (color === "yellow") dots.yellow++;
            else if (color === "purple") dots.purple++;
          }
          return <StatusDots {...dots} />;
        })()}
      </Box>

      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold>Tasks</Text>
        <Text dimColor>Ctrl+N: New</Text>
      </Box>

      {allTasks.length === 0 && (
        <Text dimColor>No tasks. Press Ctrl+N to create one.</Text>
      )}

      {allTasks.map((task, i) => {
        const isSelected = i === selectedIndex;
        const isClosed = task.status === "closed";
        const isClosing = task.status === "closing";
        const status = gitStatuses[task.id];
        const taskColor = taskStatuses[task.id];
        return (
          <Box
            key={task.id}
            flexDirection="column"
            paddingLeft={1}
            marginBottom={1}
          >
            <Box>
              {!isClosed && !isClosing && taskColor && taskColor !== "none" ? (
                <StatusDots
                  green={taskColor === "green" ? 1 : 0}
                  red={taskColor === "red" ? 1 : 0}
                  orange={taskColor === "orange" ? 1 : 0}
                  yellow={taskColor === "yellow" ? 1 : 0}
                  purple={taskColor === "purple" ? 1 : 0}
                />
              ) : (
                <Text> </Text>
              )}
              <Text
                color={isSelected && !isClosing ? "cyan" : undefined}
                bold={isSelected && !isClosing}
                dimColor={(isClosed || isClosing) && !isSelected}
              >
                {isSelected ? " ▸ " : "   "}
                {isClosing ? "[closing...] " : isClosed ? "[closed] " : ""}
                {task.label}
              </Text>
            </Box>
            <Box paddingLeft={4}>
              <Text dimColor>
                &quot;
                {task.description.length > 50
                  ? task.description.slice(0, 50) + "..."
                  : task.description}
                &quot;
              </Text>
            </Box>
            {status && !isClosed && (
              <Box paddingLeft={4}>
                <Text dimColor>{formatGitStatus(status)}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {modal?.type === "confirm" && (
        <ConfirmModal
          message={modal.message}
          onConfirm={modal.onConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.type === "newTask" && (
        <TextInputField
          label="Enter task description:"
          value={newTaskDesc}
          onChange={setNewTaskDesc}
          onSubmit={handleCreateTask}
          onCancel={() => {
            setModal(null);
            setNewTaskDesc("");
          }}
          placeholder="e.g., Fix authentication bug in login flow"
        />
      )}
    </Box>
  );
}
