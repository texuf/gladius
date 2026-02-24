import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { getAllActiveTasks, getTasksForProject, touchTask, touchProject } from "../services/db.js";
import { getAllProjects } from "../services/db.js";
import type { Task, Project } from "../store/types.js";
import { StatusDots } from "../components/StatusDots.js";

interface TaskWithProject extends Task {
  projectName: string;
  projectId: string;
}

export function TaskSwitcher() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeProject = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setView = useStore((s) => s.setView);
  const setTasks = useStore((s) => s.setTasks);
  const taskStatuses = useStore((s) => s.taskStatuses);

  const [allTasks, setAllTasks] = useState<TaskWithProject[]>([]);

  useEffect(() => {
    const projects = getAllProjects();
    const tasks: TaskWithProject[] = [];

    for (const project of projects) {
      const projectTasks = getTasksForProject(project.id).filter(
        (t) => t.status === "active"
      );
      for (const task of projectTasks) {
        tasks.push({
          ...task,
          projectName: project.name,
          projectId: project.id,
        });
      }
    }

    // Sort: current project first, then by last accessed
    tasks.sort((a, b) => {
      if (activeProject) {
        if (a.projectId === activeProject.id && b.projectId !== activeProject.id) return -1;
        if (b.projectId === activeProject.id && a.projectId !== activeProject.id) return 1;
      }
      return new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime();
    });

    setAllTasks(tasks);
  }, []);

  const filtered = query
    ? allTasks.filter(
        (t) =>
          t.label.toLowerCase().includes(query.toLowerCase()) ||
          t.description.toLowerCase().includes(query.toLowerCase())
      )
    : allTasks;

  useInput((input, key) => {
    if (key.escape) {
      setView("tasks");
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(Math.min(filtered.length - 1, selectedIndex + 1));
    } else if (key.return && filtered[selectedIndex]) {
      const task = filtered[selectedIndex];
      // Switch to this task
      touchTask(task.id);

      // If different project, switch project too
      if (!activeProject || activeProject.id !== task.projectId) {
        const projects = getAllProjects();
        const project = projects.find((p) => p.id === task.projectId);
        if (project) {
          touchProject(project.id);
          setActiveProject(project);
          setTasks(getTasksForProject(project.id));
        }
      }

      setActiveTask(task);
      setView("taskView");
    }
  });

  // Group tasks by project
  const currentProjectTasks = filtered.filter(
    (t) => activeProject && t.projectId === activeProject.id
  );
  const otherProjectTasks = filtered.filter(
    (t) => !activeProject || t.projectId !== activeProject.id
  );

  let globalIdx = 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      flexGrow={1}
      width="100%"
    >
      <Text bold color="magenta">
        Switch Task
      </Text>

      <Box marginTop={1}>
        <Text>&gt; </Text>
        <InkTextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setSelectedIndex(0);
          }}
          placeholder="Search tasks..."
        />
      </Box>

      {currentProjectTasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            Current Project: {activeProject?.name}
          </Text>
          {currentProjectTasks.map((task) => {
            const idx = globalIdx++;
            const taskColor = taskStatuses[task.id];
            return (
              <Box key={task.id} paddingLeft={1}>
                {taskColor && taskColor !== "none" ? (
                  <StatusDots
                    green={taskColor === "green" ? 1 : 0}
                    red={taskColor === "red" ? 1 : 0}
                    orange={taskColor === "orange" ? 1 : 0}
                    yellow={taskColor === "yellow" ? 1 : 0}
                  />
                ) : (
                  <Text> </Text>
                )}
                <Text
                  color={idx === selectedIndex ? "magenta" : undefined}
                  bold={idx === selectedIndex}
                >
                  {idx === selectedIndex ? "▸ " : "  "}
                  {task.label}
                </Text>
                <Text dimColor>
                  {" "}&quot;{task.description.slice(0, 30)}
                  {task.description.length > 30 ? "..." : ""}&quot;
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {otherProjectTasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Other Projects:</Text>
          {otherProjectTasks.map((task) => {
            const idx = globalIdx++;
            const taskColor = taskStatuses[task.id];
            return (
              <Box key={task.id} paddingLeft={1}>
                {taskColor && taskColor !== "none" ? (
                  <StatusDots
                    green={taskColor === "green" ? 1 : 0}
                    red={taskColor === "red" ? 1 : 0}
                    orange={taskColor === "orange" ? 1 : 0}
                    yellow={taskColor === "yellow" ? 1 : 0}
                  />
                ) : (
                  <Text> </Text>
                )}
                <Text
                  color={idx === selectedIndex ? "magenta" : undefined}
                  bold={idx === selectedIndex}
                >
                  {idx === selectedIndex ? "▸ " : "  "}
                  {task.projectName} / {task.label}
                </Text>
                <Text dimColor>
                  {" "}&quot;{task.description.slice(0, 30)}
                  {task.description.length > 30 ? "..." : ""}&quot;
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {filtered.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>No matching tasks found.</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ Navigate  ⏎ Switch  Esc Cancel</Text>
      </Box>
    </Box>
  );
}
