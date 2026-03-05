import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import {
  getProjectLinearTeam,
  getTasksForRepo,
  isProjectLinearEnabled,
  closeTask as dbCloseTask,
  swapTaskOrder,
  touchTask,
  createTask as dbCreateTask,
  reopenTask as dbReopenTask,
  updateTask as dbUpdateTask,
} from "../services/db.js";
import { formatGitStatus } from "../services/git.js";
import { listLinearIssuesForRepo } from "../services/linear.js";
import type { LinearIssue } from "../services/linear.js";
import { generateLabel, deduplicateLabel } from "../utils/label.js";
import { createWorktree } from "../services/worktree.js";
import { deleteWorktree } from "../services/worktree.js";
import { BRANCH_PREFIX } from "../utils/constants.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { TextInputField } from "../components/TextInput.js";
import { StatusDots } from "../components/StatusDots.js";
import type { Task } from "../store/types.js";

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type TaskListRow =
  | { kind: "linear"; issue: LinearIssue }
  | { kind: "task"; task: Task };

function getTaskListRowKey(row: TaskListRow | undefined): string | null {
  if (!row) return null;
  return row.kind === "linear" ? `linear:${row.issue.id}` : `task:${row.task.id}`;
}

function formatClosedDate(closedAt: string | null): string {
  if (!closedAt) return "";
  const d = new Date(closedAt);
  return `${SHORT_DAYS[d.getDay()]} ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function stripResumeSuffix(label: string): string {
  return label.replace(/-r\d+$/, "");
}

function buildReopenLabel(label: string, existingLabels: string[]): string {
  const baseLabel = stripResumeSuffix(label);
  let suffix = 2;
  let candidate = `${baseLabel}-r${suffix}`;
  while (existingLabels.includes(candidate)) {
    suffix += 1;
    candidate = `${baseLabel}-r${suffix}`;
  }
  return candidate;
}

export function TaskList() {
  const activeRepo = useStore((s) => s.activeRepo);
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
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([]);
  const [linearLoading, setLinearLoading] = useState(false);
  const activeTask = useStore((s) => s.activeTask);
  const userNavigatedRef = useRef(false);
  const selectedRowKeyRef = useRef<string | null>(null);

  const linearEnabled = !!activeRepo && isProjectLinearEnabled(activeRepo.project_id);
  const linearTeam = activeRepo ? getProjectLinearTeam(activeRepo.project_id) : "hnt-labs";

  const activeTasks = tasks.filter(
    (t) => t.status === "active" || t.status === "closing",
  );
  const closedTasks = tasks
    .filter((t) => t.status === "closed")
    .sort((a, b) =>
      (b.last_accessed_at || "").localeCompare(a.last_accessed_at || ""),
    );
  const allTasks = [...activeTasks, ...closedTasks];

  const inProgressLinearIds = useMemo(
    () =>
      new Set(
        tasks
          .filter((t) => (t.status === "active" || t.status === "closing") && t.linear_issue_id)
          .map((t) => t.linear_issue_id as string),
      ),
    [tasks],
  );

  const visibleLinearIssues = useMemo(
    () => linearIssues.filter((issue) => !inProgressLinearIds.has(issue.id)),
    [linearIssues, inProgressLinearIds],
  );
  const linearIdColumnWidth = useMemo(
    () =>
      Math.max(0, ...visibleLinearIssues.map((issue) => issue.id.length)),
    [visibleLinearIssues],
  );
  const linearStatusColumnWidth = useMemo(
    () =>
      Math.max(
        0,
        ...visibleLinearIssues.map((issue) =>
          `${issue.statusIcon ? `${issue.statusIcon} ` : ""}${issue.status}`.trim()
            .length,
        ),
      ),
    [visibleLinearIssues],
  );

  const rows: TaskListRow[] = useMemo(
    () => [
      ...visibleLinearIssues.map((issue) => ({ kind: "linear", issue }) as const),
      ...allTasks.map((task) => ({ kind: "task", task }) as const),
    ],
    [visibleLinearIssues, allTasks],
  );

  useEffect(() => {
    if (!activeRepo || !linearEnabled) {
      setLinearIssues([]);
      setLinearLoading(false);
      return;
    }

    let cancelled = false;
    setLinearLoading(true);
    listLinearIssuesForRepo(activeRepo.path, linearTeam)
      .then((issues) => {
        if (cancelled) return;
        setLinearIssues(issues);
      })
      .finally(() => {
        if (!cancelled) setLinearLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeRepo?.id, activeRepo?.path, linearEnabled, linearTeam]);

  // Keep selection in bounds when rows appear/disappear.
  useEffect(() => {
    const max = Math.max(0, rows.length - 1);
    if (selectedIndex > max) {
      setSelectedIndex(max);
    }
  }, [rows.length, selectedIndex, setSelectedIndex]);

  // Initial selection policy:
  // - backward nav: keep previously focused task
  // - forward nav: start on first task (not first linear issue)
  const initializedSelectionRef = useRef(false);
  useEffect(() => {
    initializedSelectionRef.current = false;
    userNavigatedRef.current = false;
    selectedRowKeyRef.current = null;
  }, [activeRepo?.id]);

  // Track the selected row identity based on explicit index moves.
  useEffect(() => {
    selectedRowKeyRef.current = getTaskListRowKey(rows[selectedIndex]);
  }, [selectedIndex]);

  // Keep selection anchored to the same row identity when linear/task rows shift.
  useEffect(() => {
    const selectedKey = selectedRowKeyRef.current;
    if (!selectedKey) return;

    const currentKey = getTaskListRowKey(rows[selectedIndex]);
    if (currentKey === selectedKey) return;

    const remappedIndex = rows.findIndex(
      (row) => getTaskListRowKey(row) === selectedKey,
    );
    if (remappedIndex >= 0 && remappedIndex !== selectedIndex) {
      setSelectedIndex(remappedIndex);
      return;
    }
    if (remappedIndex < 0) {
      selectedRowKeyRef.current = currentKey;
    }
  }, [rows, selectedIndex, setSelectedIndex]);

  useEffect(() => {
    if (initializedSelectionRef.current) return;
    if (linearEnabled && linearLoading) return;

    initializedSelectionRef.current = true;

    if (userNavigatedRef.current) {
      return;
    }

    if (activeTask) {
      const idx = rows.findIndex(
        (row) => row.kind === "task" && row.task.id === activeTask.id,
      );
      if (idx >= 0) {
        setSelectedIndex(idx);
        return;
      }
    }

    if (allTasks.length > 0) {
      setSelectedIndex(visibleLinearIssues.length);
      return;
    }

    if (visibleLinearIssues.length > 0) {
      setSelectedIndex(0);
    }
  }, [
    linearEnabled,
    linearLoading,
    rows,
    allTasks.length,
    visibleLinearIssues.length,
    activeTask?.id,
    setSelectedIndex,
  ]);

  useInput((input, key) => {
    if (modal || creating) return;

    const selectedRow = rows[selectedIndex];
    const selectedTask = selectedRow?.kind === "task" ? selectedRow.task : null;
    const maxRowIndex = Math.max(0, rows.length - 1);

    if (key.upArrow && !key.shift) {
      userNavigatedRef.current = true;
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow && !key.shift) {
      userNavigatedRef.current = true;
      setSelectedIndex(Math.min(maxRowIndex, selectedIndex + 1));
    } else if (key.upArrow && key.shift) {
      if (!selectedTask || selectedTask.status !== "active") return;
      const activeIdx = activeTasks.findIndex((t) => t.id === selectedTask.id);
      if (activeIdx <= 0) return;

      swapTaskOrder(
        activeTasks[activeIdx].id,
        activeTasks[activeIdx - 1].id,
      );
      userNavigatedRef.current = true;
      reloadTasks();
      setSelectedIndex(visibleLinearIssues.length + activeIdx - 1);
    } else if (key.downArrow && key.shift) {
      if (!selectedTask || selectedTask.status !== "active") return;
      const activeIdx = activeTasks.findIndex((t) => t.id === selectedTask.id);
      if (activeIdx < 0 || activeIdx >= activeTasks.length - 1) return;

      swapTaskOrder(
        activeTasks[activeIdx].id,
        activeTasks[activeIdx + 1].id,
      );
      userNavigatedRef.current = true;
      reloadTasks();
      setSelectedIndex(visibleLinearIssues.length + activeIdx + 1);
    } else if (key.return && selectedRow?.kind === "linear") {
      void handleCreateTaskFromIssue(selectedRow.issue);
    } else if (input === "p" && !key.super && selectedRow?.kind === "linear") {
      try {
        Bun.spawn(["open", selectedRow.issue.url], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {}
    } else if (key.return && selectedTask?.status === "active") {
      if (!activeRepo) return;
      touchTask(selectedTask.id);
      const refreshedTasks = getTasksForRepo(activeRepo.id);
      setTasks(refreshedTasks);
      const refreshedTask =
        refreshedTasks.find((t) => t.id === selectedTask.id) ?? selectedTask;
      setActiveTask(refreshedTask);
      setView("taskView");
    } else if (key.return && selectedTask?.status === "closing") {
      // No-op — task is being closed
    } else if (key.return && selectedTask?.status === "closed") {
      void handleReopenTask(selectedTask);
    } else if (input === "x" && selectedTask?.status === "active") {
      setModal({
        type: "confirm",
        message: `Close task '${selectedTask.label}'? This will delete the worktree.`,
        onConfirm: () => handleCloseTask(selectedTask),
      });
    }
  });

  const reloadTasks = useCallback(() => {
    if (activeRepo) {
      const updated = getTasksForRepo(activeRepo.id);
      setTasks(updated);
    }
  }, [activeRepo, setTasks]);

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
      if (task.worktree_path && activeRepo) {
        await deleteWorktree(
          activeRepo.path,
          task.worktree_path,
          task.branch_name,
        );
      }
      dbCloseTask(task.id);
      reloadTasks();
    })();
  };

  const handleReopenTask = async (task: Task) => {
    if (!activeRepo) return;
    setCreating(true);
    try {
      const existingLabels = tasks.map((t) => t.label);
      const reopenedLabel = buildReopenLabel(task.label, existingLabels);
      const reopenedBranch = `${BRANCH_PREFIX}/${reopenedLabel}`;
      const worktreePath = await createWorktree(activeRepo.path, reopenedLabel);
      dbReopenTask(task.id, worktreePath);
      dbUpdateTask(task.id, {
        label: reopenedLabel,
        branch_name: reopenedBranch,
      });
      reloadTasks();
      const reopened = {
        ...task,
        label: reopenedLabel,
        status: "active" as const,
        worktree_path: worktreePath,
        branch_name: reopenedBranch,
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

  const createTaskFromDescription = async (
    description: string,
    options?: { linearIssueId?: string | null },
  ) => {
    if (!description.trim() || !activeRepo) return;

    setCreating(true);
    try {
      const existingLabels = tasks.map((t) => t.label);
      let label = generateLabel(description);
      label = deduplicateLabel(label, existingLabels);
      const branchName = `${BRANCH_PREFIX}/${label}`;

      const worktreePath = await createWorktree(activeRepo.path, label);
      const task = dbCreateTask(
        activeRepo.id,
        label,
        description,
        branchName,
        worktreePath,
        options,
      );

      reloadTasks();
      setModal(null);
      setNewTaskDesc("");

      // Open the new task
      setActiveTask(task);
      setView("taskView");
    } catch (e: any) {
      console.error("Failed to create task:", e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateTaskFromIssue = async (issue: LinearIssue) => {
    const description = `[${issue.id}] ${issue.title}`;
    await createTaskFromDescription(description, { linearIssueId: issue.id });
  };

  const handleCreateTask = async (description: string) => {
    await createTaskFromDescription(description);
  };

  if (!activeRepo) return null;

  let rowIdx = 0;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="cyan">
          {activeRepo.name}
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

      {linearEnabled && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Linear</Text>
          {linearLoading && (
            <Box paddingLeft={1}>
              <Text dimColor>Loading assigned issues...</Text>
            </Box>
          )}
          {!linearLoading && visibleLinearIssues.length === 0 && (
            <Box paddingLeft={1}>
              <Text dimColor>No uncompleted assigned issues.</Text>
            </Box>
          )}
          {!linearLoading &&
            visibleLinearIssues.map((issue) => {
              const idx = rowIdx++;
              const isSelected = idx === selectedIndex;
              const status = `${issue.statusIcon ? `${issue.statusIcon} ` : ""}${issue.status}`.trim();
              const idCol = issue.id.padEnd(linearIdColumnWidth);
              const statusCol = status.padEnd(linearStatusColumnWidth);
              return (
                <Box key={issue.id} paddingLeft={1}>
                  <Text
                    color={isSelected ? "cyan" : undefined}
                    bold={isSelected}
                  >
                    {isSelected ? " ▸ " : "   "}
                    {idCol}
                    {"  "}
                    {statusCol}
                    {"  "}
                    {issue.title}
                  </Text>
                </Box>
              );
            })}
        </Box>
      )}

      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold>Tasks</Text>
        <Text dimColor>Ctrl+N: New</Text>
      </Box>

      {allTasks.length === 0 && (
        <Text dimColor>
          No tasks. Press Ctrl+N to create one.
          {linearEnabled ? " Press Enter on a Linear issue to create from ticket." : ""}
        </Text>
      )}

      {allTasks.map((task, i) => {
        const idx = rowIdx++;
        const isSelected = idx === selectedIndex;
        const isClosed = task.status === "closed";
        const isClosing = task.status === "closing";
        const status = gitStatuses[task.id];
        const taskColor = taskStatuses[task.id];
        const prevTask = allTasks[i - 1];
        const isFirstClosed = isClosed && prevTask && prevTask.status !== "closed";
        return (
          <Box
            key={task.id}
            flexDirection="column"
            paddingLeft={1}
            marginTop={isFirstClosed ? 1 : 0}
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
                {isClosing ? "[closing...] " : isClosed ? `${formatClosedDate(task.closed_at)} - ` : ""}
                {task.description.length > 50
                  ? task.description.slice(0, 50) + "..."
                  : task.description}
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
