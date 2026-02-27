import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import {
  getAllRepos,
  addRepo,
  deleteRepo,
  touchRepo,
  getTasksForRepo,
  getProjectById,
  touchProject,
} from "../services/db.js";
import { StatusDots } from "../components/StatusDots.js";
import { EmbeddedTerminal, getCwd } from "../components/EmbeddedTerminal.js";
import { destroySession } from "../services/terminalManager.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import type { Repo } from "../store/types.js";
import { deleteWorktree } from "../services/worktree.js";
import { homedir } from "os";
import { $ } from "bun";

type AddRepoPhase =
  | "method-select"
  | "navigate"
  | "navigate-confirm"
  | "clone-project"
  | "clone-new-project"
  | "clone-url"
  | "clone-progress"
  | null;

export function RepoSelection() {
  const repos = useStore((s) => s.repos);
  const setRepos = useStore((s) => s.setRepos);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedIndex = useStore((s) => s.setSelectedIndex);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveRepo = useStore((s) => s.setActiveRepo);
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

  const [addRepoPhase, setAddRepoPhase] = useState<AddRepoPhase>(null);
  const [capturedPath, setCapturedPath] = useState("");
  const [terminalError, setTerminalError] = useState("");

  const [methodIndex, setMethodIndex] = useState(0);

  const [cloneProjectIndex, setCloneProjectIndex] = useState(0);
  const [cloneProjectName, setCloneProjectName] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneError, setCloneError] = useState("");

  const existingProjects = [...new Set(repos.map((r) => r.project_name))].sort();

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
      setAddRepoPhase("method-select");
      setMethodIndex(0);
      setCapturedPath("");
      setError("");
      setTerminalError("");
      setCloneProjectIndex(0);
      setCloneProjectName("");
      setNewProjectName("");
      setCloneUrl("");
      setCloneError("");
    } else {
      setAddRepoPhase(null);
    }
  }, [addingRepo]);

  const handleTerminalEsc = (pid: number) => {
    const shellCwd = getCwd("__add-repo", pid);
    setCapturedPath(shellCwd);
    destroySession("__add-repo");
    setAddRepoPhase("navigate-confirm");
  };

  const handleTerminalError = (message: string) => {
    setTerminalError(message);
    destroySession("__add-repo");
    setAddRepoPhase("navigate-confirm");
  };

  function parseRepoName(url: string): string {
    const lastSegment = url.split("/").pop() || url.split(":").pop() || "";
    return lastSegment.replace(/\.git$/, "");
  }

  const handleAddRepo = (path: string) => {
    const resolvedPath = path.startsWith("~")
      ? path.replace("~", process.env.HOME || "")
      : path;

    try {
      addRepo(resolvedPath);
      reloadRepos();
      setAddingRepo(false);
      setCapturedPath("");
      setError("");
    } catch (e: any) {
      setError(e.message || "Failed to add repo");
    }
  };

  async function handleClone(url: string) {
    const repoName = parseRepoName(url.trim());
    if (!repoName) {
      setCloneError("Could not parse repository name from URL");
      return;
    }

    const home = homedir();
    const targetPath = `${home}/${cloneProjectName}/${repoName}`;
    setAddRepoPhase("clone-progress");
    setCloneError("");

    try {
      await $`mkdir -p ${home}/${cloneProjectName}`;
      const proc = Bun.spawn(["git", "clone", url.trim(), targetPath], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(stderr.trim() || "Clone failed");
      }
      addRepo(targetPath, cloneProjectName);
      reloadRepos();
      setAddingRepo(false);
    } catch (e: any) {
      setCloneError(e.message || "Clone failed");
      setAddRepoPhase("clone-url");
    }
  }

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

    if (addRepoPhase === "navigate") return;

    if (addRepoPhase === "method-select") {
      if (key.escape) {
        setAddingRepo(false);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setMethodIndex(methodIndex === 0 ? 1 : 0);
        return;
      }
      if (key.return) {
        if (methodIndex === 0) {
          setAddRepoPhase("navigate");
        } else {
          setAddRepoPhase("clone-project");
          setCloneProjectIndex(0);
        }
      }
      return;
    }

    if (addRepoPhase === "navigate-confirm") {
      if (key.escape) {
        setAddingRepo(false);
        setCapturedPath("");
        setError("");
        setTerminalError("");
        return;
      }
      if (!terminalError && key.return) {
        handleAddRepo(capturedPath);
      }
      return;
    }

    if (addRepoPhase === "clone-project") {
      const projectOptions = [...existingProjects, "New project..."];
      if (key.escape) {
        setAddRepoPhase("method-select");
        return;
      }
      if (key.upArrow) {
        setCloneProjectIndex(Math.max(0, cloneProjectIndex - 1));
        return;
      }
      if (key.downArrow) {
        setCloneProjectIndex(
          Math.min(projectOptions.length - 1, cloneProjectIndex + 1),
        );
        return;
      }
      if (key.return) {
        if (cloneProjectIndex === projectOptions.length - 1) {
          setAddRepoPhase("clone-new-project");
          setNewProjectName("");
        } else {
          setCloneProjectName(projectOptions[cloneProjectIndex]);
          setAddRepoPhase("clone-url");
          setCloneUrl("");
          setCloneError("");
        }
      }
      return;
    }

    if (addRepoPhase === "clone-new-project") {
      if (key.escape) {
        setAddRepoPhase("clone-project");
      }
      return;
    }

    if (addRepoPhase === "clone-url") {
      if (key.escape) {
        setAddRepoPhase("clone-project");
        setCloneError("");
      }
      return;
    }

    if (addRepoPhase === "clone-progress") {
      return;
    }

    if (confirmDelete) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(Math.min(repos.length - 1, selectedIndex + 1));
    } else if (key.return && repos.length > 0) {
      const repo = repos[selectedIndex];
      if (repo) {
        touchRepo(repo.id);
        setActiveRepo(repo);
        const tasks = getTasksForRepo(repo.id);
        setTasks(tasks);
        setView("tasks");
      }
    } else if (input === "s") {
      setView("settings");
    } else if (input === "d" && repos.length > 0) {
      const repo = repos[selectedIndex];
      if (repo) {
        setConfirmDelete(repo);
      }
    } else if (input === "u") {
      setView("standup");
    } else if (input === "g" && repos.length > 0) {
      const repo = repos[selectedIndex];
      if (repo) {
        const project = getProjectById(repo.project_id);
        if (project) {
          setActiveRepo(null);
          setTasks([]);
          useStore.getState().setActiveTask(null);
          touchProject(project.id);
          setActiveProject(project);
          setView("projectView");
        } else {
          setError("Project not found for selected repo.");
        }
      }
    }
  });

  if (addRepoPhase === "navigate") {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {" "}
            GLADIUS{" "}
          </Text>
          <Text dimColor> Add Repo</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>cd to your repository directory, then press Esc Confirm</Text>
        </Box>
        <EmbeddedTerminal
          taskId="__add-repo"
          cwd={process.env.HOME || "/"}
          singleEsc
          onEsc={handleTerminalEsc}
          onError={handleTerminalError}
        />
      </Box>
    );
  }

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
        <Text dimColor>Ctrl+N: New g: Project d: Delete</Text>
      </Box>

      {repos.length === 0 && !addingRepo && (
        <Text dimColor>No repos added. Press Ctrl+N to add one.</Text>
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
                <Text dimColor>
                  {"  "}
                  {taskCounts[repo.id] || 0} task
                  {(taskCounts[repo.id] || 0) !== 1 ? "s" : ""}
                </Text>
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

      {addRepoPhase === "method-select" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Add Repo
          </Text>
          <Box marginTop={1} flexDirection="column">
            {["Navigate to directory", "Clone from URL"].map((label, i) => (
              <Text
                key={label}
                color={i === methodIndex ? "cyan" : undefined}
                bold={i === methodIndex}
              >
                {i === methodIndex ? "▸ " : "  "}
                {label}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑↓ Select ⏎ Confirm Esc Cancel</Text>
          </Box>
        </Box>
      )}

      {addRepoPhase === "navigate-confirm" && terminalError && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="red"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="red">Terminal Error</Text>
          <Box marginTop={1}>
            <Text color="red">{terminalError}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Try closing unused terminal tabs to free PTY devices.</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc Cancel</Text>
          </Box>
        </Box>
      )}

      {addRepoPhase === "navigate-confirm" && !terminalError && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">Add repo at:</Text>
          <Box marginTop={1}>
            <Text>{capturedPath}</Text>
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>⏎ Add Esc Cancel</Text>
          </Box>
        </Box>
      )}

      {addRepoPhase === "clone-project" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">Select Project</Text>
          <Box marginTop={1} flexDirection="column">
            {[...existingProjects, "New project..."].map((label, i) => (
              <Text
                key={label}
                color={i === cloneProjectIndex ? "cyan" : undefined}
                bold={i === cloneProjectIndex}
              >
                {i === cloneProjectIndex ? "▸ " : "  "}
                {label}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑↓ Select ⏎ Confirm Esc Back</Text>
          </Box>
        </Box>
      )}

      {addRepoPhase === "clone-new-project" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">New Project Name</Text>
          <Box marginTop={1}>
            <Text>Project: </Text>
            <InkTextInput
              value={newProjectName}
              onChange={setNewProjectName}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) return;
                setCloneProjectName(trimmed);
                setAddRepoPhase("clone-url");
                setCloneUrl("");
                setCloneError("");
              }}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>⏎ Confirm Esc Back</Text>
          </Box>
        </Box>
      )}

      {addRepoPhase === "clone-url" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">Clone Repository</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Project: <Text color="white">{cloneProjectName}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>URL: </Text>
            <InkTextInput
              value={cloneUrl}
              onChange={setCloneUrl}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) return;
                const httpsMatch = trimmed.match(
                  /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
                );
                if (httpsMatch) {
                  const sshUrl = `git@github.com:${httpsMatch[1]}.git`;
                  setCloneUrl(sshUrl);
                  handleClone(sshUrl);
                  return;
                }
                if (!trimmed.startsWith("git@")) {
                  setCloneError("Please use an SSH URL (git@github.com:...)");
                  return;
                }
                handleClone(trimmed);
              }}
            />
          </Box>
          {cloneError && (
            <Box marginTop={1}>
              <Text color="red">{cloneError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>⏎ Clone Esc Back</Text>
          </Box>
        </Box>
      )}

      {addRepoPhase === "clone-progress" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">Cloning...</Text>
          <Box marginTop={1}>
            <Text dimColor>
              {cloneProjectName}/{parseRepoName(cloneUrl)}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
