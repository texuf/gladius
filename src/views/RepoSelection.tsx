import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { useStore } from "../store/index.js";
import {
  createProject,
  deleteRepo,
  getAllRepos,
  getProjectById,
  getTasksForRepo,
  touchProject,
  touchRepo,
} from "../services/db.js";
import { StatusDots } from "../components/StatusDots.js";
import { destroySession } from "../services/terminalManager.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import type { Repo } from "../store/types.js";
import { deleteWorktree } from "../services/worktree.js";

export function RepoSelection() {
  const repos = useStore((s) => s.repos);
  const setRepos = useStore((s) => s.setRepos);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedIndex = useStore((s) => s.setSelectedIndex);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveRepo = useStore((s) => s.setActiveRepo);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setView = useStore((s) => s.setView);
  const addingRepo = useStore((s) => s.addingRepo);
  const setAddingRepo = useStore((s) => s.setAddingRepo);
  const setTasks = useStore((s) => s.setTasks);
  const taskStatuses = useStore((s) => s.taskStatuses);

  const [error, setError] = useState("");
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [repoTaskIds, setRepoTaskIds] = useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState<Repo | null>(null);
  const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null);
  const [createProjectName, setCreateProjectName] = useState("");
  const [createProjectError, setCreateProjectError] = useState("");

  function reloadRepos(): Repo[] {
    const updated = getAllRepos();
    setRepos(updated);
    const counts: Record<string, number> = {};
    const taskIds: Record<string, string[]> = {};
    for (const repo of updated) {
      const active = getTasksForRepo(repo.id).filter((t) => t.status === "active");
      counts[repo.id] = active.length;
      taskIds[repo.id] = active.map((t) => t.id);
    }
    setTaskCounts(counts);
    setRepoTaskIds(taskIds);
    return updated;
  }

  useEffect(() => {
    reloadRepos();
  }, []);

  useEffect(() => {
    if (addingRepo) {
      setCreateProjectName("");
      setCreateProjectError("");
      setError("");
    }
  }, [addingRepo]);

  const handleCreateProject = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setCreateProjectError("Project name cannot be empty.");
      return;
    }
    if (/[\\/]/.test(trimmed)) {
      setCreateProjectError("Project name cannot include path separators.");
      return;
    }

    const projectPath = join(homedir(), trimmed);

    try {
      mkdirSync(projectPath, { recursive: true });
      const project = createProject(trimmed, projectPath);

      setAddingRepo(false);
      setCreateProjectName("");
      setCreateProjectError("");
      setError("");

      setActiveRepo(null);
      setTasks([]);
      setActiveTask(null);
      touchProject(project.id);
      setActiveProject(project);
      setView("projectView");
    } catch (e: any) {
      setCreateProjectError(e.message || "Failed to create project.");
    }
  };

  const handleConfirmDelete = () => {
    if (!confirmDelete) return;
    const repo = confirmDelete;
    setConfirmDelete(null);
    setDeletingRepoId(repo.id);

    void (async () => {
      try {
        const repoTasks = getTasksForRepo(repo.id);

        for (const task of repoTasks) {
          destroySession(`${task.id}-terminal`);
          destroySession(`${task.id}-console`);
          destroySession(task.id);
        }

        for (const task of repoTasks) {
          if (!task.worktree_path) continue;
          await deleteWorktree(repo.path, task.worktree_path, task.branch_name);
        }

        const deletedTaskIds = new Set(repoTasks.map((t) => t.id));
        deleteRepo(repo.id);

        const state = useStore.getState();
        if (state.activeRepo?.id === repo.id) {
          state.setActiveRepo(null);
          state.setTasks([]);
          state.setActiveTask(null);
        }

        useStore.setState((prev) => {
          const gitStatuses = { ...prev.gitStatuses };
          const taskStatuses = { ...prev.taskStatuses };
          for (const taskId of deletedTaskIds) {
            delete gitStatuses[taskId];
            delete taskStatuses[taskId];
          }
          return {
            ...prev,
            gitStatuses,
            taskStatuses,
            consoleInteractedTasks: new Set(
              [...prev.consoleInteractedTasks].filter(
                (taskId) => !deletedTaskIds.has(taskId),
              ),
            ),
            clearedPrTasks: new Set(
              [...prev.clearedPrTasks].filter(
                (taskId) => !deletedTaskIds.has(taskId),
              ),
            ),
          };
        });

        const updated = reloadRepos();
        setSelectedIndex(Math.min(selectedIndex, Math.max(0, updated.length - 1)));
      } catch (e: any) {
        setError(e.message || "Failed to delete repo");
      } finally {
        setDeletingRepoId(null);
      }
    })();
  };

  useInput((input, key) => {
    if (deletingRepoId) return;

    if (addingRepo) {
      if (key.escape) {
        setAddingRepo(false);
        setCreateProjectName("");
        setCreateProjectError("");
      }
      return;
    }

    if (confirmDelete) return;

    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(Math.min(repos.length - 1, selectedIndex + 1));
    } else if (key.return && repos.length > 0) {
      const repo = repos[selectedIndex];
      if (!repo) return;
      touchRepo(repo.id);
      setActiveRepo(repo);
      const tasks = getTasksForRepo(repo.id);
      setTasks(tasks);
      setView("tasks");
    } else if (input === "s") {
      setView("settings");
    } else if (input === "d" && repos.length > 0) {
      const repo = repos[selectedIndex];
      if (repo) setConfirmDelete(repo);
    } else if (input === "u") {
      setView("standup");
    } else if (input === "g" && repos.length > 0) {
      const repo = repos[selectedIndex];
      if (!repo) return;

      const project = getProjectById(repo.project_id);
      if (!project) {
        setError("Project not found for selected repo.");
        return;
      }

      setActiveRepo(null);
      setTasks([]);
      setActiveTask(null);
      touchProject(project.id);
      setActiveProject(project);
      setView("projectView");
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}
          GLADIUS{" "}
        </Text>
      </Box>

      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold>Repos</Text>
        <Text dimColor>Ctrl+N: New Project g: Project d: Delete</Text>
      </Box>

      {repos.length === 0 && !addingRepo && (
        <Text dimColor>No repos yet. Press Ctrl+N to create a project.</Text>
      )}

      {repos.map((repo, i) => {
        const previous = i > 0 ? repos[i - 1] : null;
        const showProjectHeader = !previous || previous.project_name !== repo.project_name;
        const isDeleting = deletingRepoId === repo.id;
        const dots = { green: 0, red: 0, orange: 0, yellow: 0, purple: 0 };
        for (const tid of repoTaskIds[repo.id] || []) {
          const c = taskStatuses[tid];
          if (c === "green") dots.green++;
          else if (c === "red") dots.red++;
          else if (c === "orange") dots.orange++;
          else if (c === "yellow") dots.yellow++;
          else if (c === "purple") dots.purple++;
        }
        return (
          <Box key={repo.id} flexDirection="column">
            {showProjectHeader && (
              <Box paddingLeft={1} marginTop={i === 0 ? 0 : 1}>
                <Text bold color="yellow">
                  {repo.project_name}
                </Text>
              </Box>
            )}
            <Box paddingLeft={1} justifyContent="space-between">
              <Box>
                <Text
                  color={i === selectedIndex ? "cyan" : undefined}
                  bold={i === selectedIndex}
                >
                  {i === selectedIndex ? "▸ " : "  "}
                  {repo.name}
                </Text>
                {isDeleting && <Text color="yellow"> [deleting...]</Text>}
                {(taskCounts[repo.id] || 0) > 0 && (
                  <Text dimColor>
                    {"  "}
                    {taskCounts[repo.id]} task
                    {taskCounts[repo.id] !== 1 ? "s" : ""}
                  </Text>
                )}
              </Box>
              <StatusDots {...dots} />
            </Box>
          </Box>
        );
      })}

      {confirmDelete && (
        <ConfirmModal
          message={`Delete repo "${confirmDelete.name}" and all of its tasks/worktrees?`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {addingRepo && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">Create Project</Text>
          <Box marginTop={1}>
            <Text>Name: </Text>
            <InkTextInput
              value={createProjectName}
              onChange={setCreateProjectName}
              onSubmit={handleCreateProject}
            />
          </Box>
          {createProjectName.trim() && (
            <Box marginTop={1}>
              <Text dimColor>Folder: {join(homedir(), createProjectName.trim())}</Text>
            </Box>
          )}
          {createProjectError && (
            <Box marginTop={1}>
              <Text color="red">{createProjectError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>⏎ Create Esc Cancel</Text>
          </Box>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
