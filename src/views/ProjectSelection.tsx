import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import {
  getAllProjects,
  addProject,
  deleteProject,
  touchProject,
  updateProjectGroup,
} from "../services/db.js";
import { getTasksForProject } from "../services/db.js";
import { StatusDots } from "../components/StatusDots.js";
import { EmbeddedTerminal, getCwd } from "../components/EmbeddedTerminal.js";
import { destroySession } from "../services/terminalManager.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import type { Project } from "../store/types.js";
import { homedir } from "os";
import { $ } from "bun";

type AddProjectPhase =
  | "method-select"
  | "navigate"
  | "navigate-confirm"
  | "clone-group"
  | "clone-new-group"
  | "clone-url"
  | "clone-progress"
  | null;

export function ProjectSelection() {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedIndex = useStore((s) => s.setSelectedIndex);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setView = useStore((s) => s.setView);
  const addingProject = useStore((s) => s.addingProject);
  const setAddingProject = useStore((s) => s.setAddingProject);
  const setTasks = useStore((s) => s.setTasks);

  const taskStatuses = useStore((s) => s.taskStatuses);
  const [error, setError] = useState("");
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [projectTaskIds, setProjectTaskIds] = useState<
    Record<string, string[]>
  >({});
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [editingGroupProjectId, setEditingGroupProjectId] = useState<
    string | null
  >(null);
  const [groupEditValue, setGroupEditValue] = useState("");
  const [groupEditError, setGroupEditError] = useState("");

  // Add-project flow state
  const [addProjectPhase, setAddProjectPhase] =
    useState<AddProjectPhase>(null);
  const [capturedPath, setCapturedPath] = useState("");
  const [terminalError, setTerminalError] = useState("");

  // Method select state
  const [methodIndex, setMethodIndex] = useState(0);

  // Clone flow state
  const [cloneGroupIndex, setCloneGroupIndex] = useState(0);
  const [cloneGroupName, setCloneGroupName] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneError, setCloneError] = useState("");

  // Derive unique group names from projects
  const existingGroups = [...new Set(projects.map((p) => p.group_name))].sort();

  // Load projects on mount
  useEffect(() => {
    const loaded = getAllProjects();
    setProjects(loaded);
    const counts: Record<string, number> = {};
    const taskIds: Record<string, string[]> = {};
    for (const p of loaded) {
      const active = getTasksForProject(p.id).filter(
        (t) => t.status === "active",
      );
      counts[p.id] = active.length;
      taskIds[p.id] = active.map((t) => t.id);
    }
    setTaskCounts(counts);
    setProjectTaskIds(taskIds);
  }, []);

  // When addingProject becomes true, start at method-select
  useEffect(() => {
    if (addingProject) {
      setAddProjectPhase("method-select");
      setMethodIndex(0);
      setCapturedPath("");
      setError("");
      setTerminalError("");
      setCloneGroupIndex(0);
      setCloneGroupName("");
      setNewGroupName("");
      setCloneUrl("");
      setCloneError("");
    } else {
      setAddProjectPhase(null);
    }
  }, [addingProject]);

  const handleTerminalEsc = (pid: number) => {
    const shellCwd = getCwd("__add-project", pid);
    setCapturedPath(shellCwd);
    destroySession("__add-project");
    setAddProjectPhase("navigate-confirm");
  };

  const handleTerminalError = (message: string) => {
    setTerminalError(message);
    destroySession("__add-project");
    setAddProjectPhase("navigate-confirm");
  };

  function parseRepoName(url: string): string {
    const lastSegment = url.split("/").pop() || url.split(":").pop() || "";
    return lastSegment.replace(/\.git$/, "");
  }

  function reloadProjects() {
    const updated = getAllProjects();
    setProjects(updated);
    const counts: Record<string, number> = {};
    const taskIds: Record<string, string[]> = {};
    for (const p of updated) {
      const active = getTasksForProject(p.id).filter(
        (t) => t.status === "active",
      );
      counts[p.id] = active.length;
      taskIds[p.id] = active.map((t) => t.id);
    }
    setTaskCounts(counts);
    setProjectTaskIds(taskIds);
  }

  async function handleClone(url: string) {
    const repoName = parseRepoName(url.trim());
    if (!repoName) {
      setCloneError("Could not parse repository name from URL");
      return;
    }

    const home = homedir();
    const targetPath = `${home}/${cloneGroupName}/${repoName}`;
    setAddProjectPhase("clone-progress");
    setCloneError("");

    try {
      await $`mkdir -p ${home}/${cloneGroupName}`;
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
      addProject(targetPath, cloneGroupName);
      reloadProjects();
      setAddingProject(false);
    } catch (e: any) {
      setCloneError(e.message || "Clone failed");
      setAddProjectPhase("clone-url");
    }
  }

  useInput((input, key) => {
    // Navigate phase: terminal handles its own input
    if (addProjectPhase === "navigate") return;

    // Method select phase
    if (addProjectPhase === "method-select") {
      if (key.escape) {
        setAddingProject(false);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setMethodIndex(methodIndex === 0 ? 1 : 0);
        return;
      }
      if (key.return) {
        if (methodIndex === 0) {
          setAddProjectPhase("navigate");
        } else {
          setAddProjectPhase("clone-group");
          setCloneGroupIndex(0);
        }
        return;
      }
      return;
    }

    // Navigate confirm phase (existing flow)
    if (addProjectPhase === "navigate-confirm") {
      if (key.escape) {
        setAddingProject(false);
        setCapturedPath("");
        setError("");
        setTerminalError("");
        return;
      }
      if (!terminalError && key.return) {
        handleAddProject(capturedPath);
        return;
      }
      return;
    }

    // Clone group select phase
    if (addProjectPhase === "clone-group") {
      const groupOptions = [...existingGroups, "New group..."];
      if (key.escape) {
        setAddProjectPhase("method-select");
        return;
      }
      if (key.upArrow) {
        setCloneGroupIndex(Math.max(0, cloneGroupIndex - 1));
        return;
      }
      if (key.downArrow) {
        setCloneGroupIndex(
          Math.min(groupOptions.length - 1, cloneGroupIndex + 1),
        );
        return;
      }
      if (key.return) {
        if (cloneGroupIndex === groupOptions.length - 1) {
          setAddProjectPhase("clone-new-group");
          setNewGroupName("");
        } else {
          setCloneGroupName(groupOptions[cloneGroupIndex]);
          setAddProjectPhase("clone-url");
          setCloneUrl("");
          setCloneError("");
        }
        return;
      }
      return;
    }

    // Clone new group name (Esc only; text handled by InkTextInput)
    if (addProjectPhase === "clone-new-group") {
      if (key.escape) {
        setAddProjectPhase("clone-group");
      }
      return;
    }

    // Clone URL input (Esc only; text handled by InkTextInput)
    if (addProjectPhase === "clone-url") {
      if (key.escape) {
        setAddProjectPhase("clone-group");
        setCloneError("");
      }
      return;
    }

    // Clone progress: no input
    if (addProjectPhase === "clone-progress") {
      return;
    }

    // ── Normal project list input ──

    if (editingGroupProjectId) {
      if (key.escape) {
        setEditingGroupProjectId(null);
        setGroupEditValue("");
        setGroupEditError("");
      }
      return;
    }

    if (confirmDelete) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(Math.min(projects.length - 1, selectedIndex + 1));
    } else if (key.return && projects.length > 0) {
      const project = projects[selectedIndex];
      if (project) {
        touchProject(project.id);
        setActiveProject(project);
        const tasks = getTasksForProject(project.id);
        setTasks(tasks);
        setView("tasks");
      }
    } else if (input === "s") {
      setView("settings");
    } else if (input === "d" && projects.length > 0) {
      const project = projects[selectedIndex];
      if (project) {
        setConfirmDelete(project);
      }
    } else if (input === "u") {
      setView("standup");
    } else if (input === "g" && projects.length > 0) {
      const project = projects[selectedIndex];
      if (project) {
        setEditingGroupProjectId(project.id);
        setGroupEditValue(project.group_name);
        setGroupEditError("");
      }
    }
  });

  const handleAddProject = (path: string) => {
    const resolvedPath = path.startsWith("~")
      ? path.replace("~", process.env.HOME || "")
      : path;

    try {
      addProject(resolvedPath);
      reloadProjects();
      setAddingProject(false);
      setCapturedPath("");
      setError("");
    } catch (e: any) {
      setError(e.message || "Failed to add project");
    }
  };

  const handleGroupEditSubmit = (value: string) => {
    if (!editingGroupProjectId) return;
    const normalized = value.trim();
    if (!normalized) {
      setGroupEditError("Group name cannot be empty.");
      return;
    }

    try {
      updateProjectGroup(editingGroupProjectId, normalized);
      const updated = getAllProjects();
      const selectedProjectId = editingGroupProjectId;
      setProjects(updated);
      const nextIndex = updated.findIndex((p) => p.id === selectedProjectId);
      setSelectedIndex(nextIndex === -1 ? 0 : nextIndex);
      setEditingGroupProjectId(null);
      setGroupEditValue("");
      setGroupEditError("");
    } catch (e: any) {
      setGroupEditError(e.message || "Failed to update group.");
    }
  };

  const handleConfirmDelete = () => {
    if (!confirmDelete) return;
    deleteProject(confirmDelete.id);
    const updated = getAllProjects();
    setProjects(updated);
    setSelectedIndex(Math.min(selectedIndex, updated.length - 1));
    setConfirmDelete(null);
  };

  // ── Render: Navigate terminal ──
  if (addProjectPhase === "navigate") {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {" "}
            GLADIUS{" "}
          </Text>
          <Text dimColor> Add Project</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            cd to your project directory, then press Esc Confirm
          </Text>
        </Box>
        <EmbeddedTerminal
          taskId="__add-project"
          cwd={process.env.HOME || "/"}
          singleEsc
          onEsc={handleTerminalEsc}
          onError={handleTerminalError}
        />
      </Box>
    );
  }

  // ── Main render ──
  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}
          GLADIUS{" "}
        </Text>
      </Box>

      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold>Projects</Text>
        <Text dimColor>Ctrl+N: New g: Group d: Delete</Text>
      </Box>

      {projects.length === 0 && !addingProject && (
        <Text dimColor>No projects added. Press Ctrl+N to add one.</Text>
      )}

      {projects.map((project, i) => {
        const previous = i > 0 ? projects[i - 1] : null;
        const showGroupHeader =
          !previous || previous.group_name !== project.group_name;
        const dots = { green: 0, red: 0, orange: 0, yellow: 0, purple: 0 };
        for (const tid of projectTaskIds[project.id] || []) {
          const c = taskStatuses[tid];
          if (c === "green") dots.green++;
          else if (c === "red") dots.red++;
          else if (c === "orange") dots.orange++;
          else if (c === "yellow") dots.yellow++;
          else if (c === "purple") dots.purple++;
        }
        return (
          <Box key={project.id} flexDirection="column">
            {showGroupHeader && (
              <Box paddingLeft={1} marginTop={i === 0 ? 0 : 1}>
                <Text bold color="yellow">
                  {project.group_name}
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
                  {project.name}
                </Text>
                <Text dimColor>
                  {"  "}
                  {taskCounts[project.id] || 0} task
                  {(taskCounts[project.id] || 0) !== 1 ? "s" : ""}
                </Text>
              </Box>
              <StatusDots {...dots} />
            </Box>
          </Box>
        );
      })}

      {confirmDelete && (
        <ConfirmModal
          message={`Delete project "${confirmDelete.name}"?`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* ── Method Select ── */}
      {addProjectPhase === "method-select" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Add Project
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

      {/* ── Navigate Confirm ── */}
      {addProjectPhase === "navigate-confirm" && terminalError && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="red"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="red">
            Terminal Error
          </Text>
          <Box marginTop={1}>
            <Text color="red">{terminalError}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Try closing unused terminal tabs to free PTY devices.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc Cancel</Text>
          </Box>
        </Box>
      )}

      {addProjectPhase === "navigate-confirm" && !terminalError && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Add project at:
          </Text>
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

      {/* ── Clone: Group Select ── */}
      {addProjectPhase === "clone-group" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Select Group
          </Text>
          <Box marginTop={1} flexDirection="column">
            {[...existingGroups, "New group..."].map((label, i) => (
              <Text
                key={label}
                color={i === cloneGroupIndex ? "cyan" : undefined}
                bold={i === cloneGroupIndex}
              >
                {i === cloneGroupIndex ? "▸ " : "  "}
                {label}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑↓ Select ⏎ Confirm Esc Back</Text>
          </Box>
        </Box>
      )}

      {/* ── Clone: New Group Name ── */}
      {addProjectPhase === "clone-new-group" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            New Group Name
          </Text>
          <Box marginTop={1}>
            <Text>Group: </Text>
            <InkTextInput
              value={newGroupName}
              onChange={setNewGroupName}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) return;
                setCloneGroupName(trimmed);
                setAddProjectPhase("clone-url");
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

      {/* ── Clone: URL Input ── */}
      {addProjectPhase === "clone-url" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Clone Repository
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              Group: <Text color="white">{cloneGroupName}</Text>
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
                // Auto-convert HTTPS GitHub URLs to SSH
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

      {/* ── Clone: Progress ── */}
      {addProjectPhase === "clone-progress" && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="cyan">
            Cloning...
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              {cloneGroupName}/{parseRepoName(cloneUrl)}
            </Text>
          </Box>
        </Box>
      )}

      {editingGroupProjectId && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
          paddingY={1}
        >
          <Text bold color="yellow">
            Edit project group
          </Text>
          <Box marginTop={1}>
            <Text>Group: </Text>
            <InkTextInput
              value={groupEditValue}
              onChange={setGroupEditValue}
              onSubmit={handleGroupEditSubmit}
            />
          </Box>
          {groupEditError && (
            <Box marginTop={1}>
              <Text color="red">{groupEditError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>⏎ Save Esc Cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
