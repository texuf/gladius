import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { getAllProjects, addProject, touchProject } from "../services/db.js";
import { getTasksForProject } from "../services/db.js";
import { StatusDots } from "../components/StatusDots.js";
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

  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState("");
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});

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

  useInput((input, key) => {
    if (addingProject) {
      if (key.escape) {
        setAddingProject(false);
        setPathInput("");
        setError("");
      }
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
      setPathInput("");
      setError("");
    } catch (e: any) {
      setError(e.message || "Failed to add project");
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}GLADIUS{" "}
        </Text>
      </Box>

      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold>Projects</Text>
        <Text dimColor>Ctrl+Shift+N: New</Text>
      </Box>

      {projects.length === 0 && !addingProject && (
        <Text dimColor>No projects added. Press Ctrl+Shift+N to add one.</Text>
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

      {addingProject && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="cyan" paddingX={1} paddingY={1}>
          <Text bold color="cyan">
            Add Project Directory:
          </Text>
          <Box marginTop={1}>
            <Text>&gt; </Text>
            <InkTextInput
              value={pathInput}
              onChange={setPathInput}
              onSubmit={handleAddProject}
              placeholder="/path/to/project"
            />
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
