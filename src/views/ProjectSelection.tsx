import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import { getAllProjects, addProject, deleteProject, touchProject } from "../services/db.js";
import { getTasksForProject } from "../services/db.js";
import { StatusDots } from "../components/StatusDots.js";
import { EmbeddedTerminal } from "../components/EmbeddedTerminal.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import type { Project } from "../store/types.js";

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

  const [error, setError] = useState("");
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [terminalActive, setTerminalActive] = useState(false);
  const [capturedPath, setCapturedPath] = useState("");
  const [terminalError, setTerminalError] = useState("");

  // Load projects on mount
  useEffect(() => {
    const loaded = getAllProjects();
    setProjects(loaded);
    // Load task counts
    const counts: Record<string, number> = {};
    for (const p of loaded) {
      counts[p.id] = getTasksForProject(p.id).filter((t) => t.status === "active").length;
    }
    setTaskCounts(counts);
  }, []);

  // When addingProject becomes true, open terminal
  useEffect(() => {
    if (addingProject) {
      setTerminalActive(true);
      setCapturedPath("");
      setError("");
      setTerminalError("");
    }
  }, [addingProject]);

  const handleTerminalExit = (cwd: string) => {
    setCapturedPath(cwd);
    setTerminalActive(false);
  };

  const handleTerminalError = (message: string) => {
    setTerminalError(message);
    setTerminalActive(false);
  };

  useInput((input, key) => {
    // When terminal is active, it handles its own input via raw stdin
    if (addingProject && terminalActive) return;

    // Confirmation step or error: captured path shown
    if (addingProject && !terminalActive) {
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
    } else if (input === "d" && projects.length > 0) {
      const project = projects[selectedIndex];
      if (project) {
        setConfirmDelete(project);
      }
    }
  });

  const handleAddProject = (path: string) => {
    const resolvedPath = path.startsWith("~")
      ? path.replace("~", process.env.HOME || "")
      : path;

    try {
      const project = addProject(resolvedPath);
      const updated = getAllProjects();
      setProjects(updated);
      setAddingProject(false);
      setCapturedPath("");
      setError("");
    } catch (e: any) {
      setError(e.message || "Failed to add project");
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

  // Render embedded terminal for add-project flow
  if (addingProject && terminalActive) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {" "}GLADIUS{" "}
          </Text>
          <Text dimColor>  Add Project</Text>
        </Box>
        <EmbeddedTerminal
          cwd={process.env.HOME || "/"}
          onExit={handleTerminalExit}
          onError={handleTerminalError}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}GLADIUS{" "}
        </Text>
      </Box>

      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold>Projects</Text>
        <Text dimColor>Ctrl+N: New  d: Delete</Text>
      </Box>

      {projects.length === 0 && !addingProject && (
        <Text dimColor>No projects added. Press Ctrl+N to add one.</Text>
      )}

      {projects.map((project, i) => (
        <Box key={project.id} paddingLeft={1}>
          <Text
            color={i === selectedIndex ? "cyan" : undefined}
            bold={i === selectedIndex}
          >
            {i === selectedIndex ? "▸ " : "  "}
            {project.name}
          </Text>
          <Text dimColor>
            {"  "}
            {taskCounts[project.id] || 0} task{(taskCounts[project.id] || 0) !== 1 ? "s" : ""}
          </Text>
        </Box>
      ))}

      {confirmDelete && (
        <ConfirmModal
          message={`Delete project "${confirmDelete.name}"?`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {addingProject && !terminalActive && terminalError && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="red" paddingX={1} paddingY={1}>
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

      {addingProject && !terminalActive && !terminalError && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="cyan" paddingX={1} paddingY={1}>
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
            <Text dimColor>⏎ Add  Esc Cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
