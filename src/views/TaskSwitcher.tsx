import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { getAllRepos, getTasksForRepo, touchTask, touchRepo } from "../services/db.js";
import type { Task } from "../store/types.js";
import { StatusDots } from "../components/StatusDots.js";

interface TaskWithRepo extends Task {
  repoName: string;
  repoId: string;
}

export function TaskSwitcher() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeRepo = useStore((s) => s.activeRepo);
  const setActiveRepo = useStore((s) => s.setActiveRepo);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setView = useStore((s) => s.setView);
  const setTasks = useStore((s) => s.setTasks);
  const taskStatuses = useStore((s) => s.taskStatuses);

  const [allTasks, setAllTasks] = useState<TaskWithRepo[]>([]);

  useEffect(() => {
    const repos = getAllRepos();
    const tasks: TaskWithRepo[] = [];

    for (const repo of repos) {
      const repoTasks = getTasksForRepo(repo.id).filter((t) => t.status === "active");
      for (const task of repoTasks) {
        tasks.push({
          ...task,
          repoName: repo.name,
          repoId: repo.id,
        });
      }
    }

    tasks.sort((a, b) => {
      if (activeRepo) {
        if (a.repoId === activeRepo.id && b.repoId !== activeRepo.id) return -1;
        if (b.repoId === activeRepo.id && a.repoId !== activeRepo.id) return 1;
      }
      return (
        new Date(b.last_accessed_at).getTime() -
        new Date(a.last_accessed_at).getTime()
      );
    });

    setAllTasks(tasks);
  }, [activeRepo?.id]);

  const filtered = query
    ? allTasks.filter(
        (t) =>
          t.label.toLowerCase().includes(query.toLowerCase()) ||
          t.description.toLowerCase().includes(query.toLowerCase()),
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
      touchTask(task.id);

      const repos = getAllRepos();
      const repo = repos.find((r) => r.id === task.repoId);
      if (repo) {
        if (!activeRepo || activeRepo.id !== repo.id) {
          touchRepo(repo.id);
          setActiveRepo(repo);
        }
        const repoTasks = getTasksForRepo(repo.id);
        setTasks(repoTasks);
        const freshTask = repoTasks.find((t) => t.id === task.id) ?? task;
        setActiveTask(freshTask);
      } else {
        setActiveTask(task);
      }
      setView("taskView");
    }
  });

  const currentRepoTasks = filtered.filter(
    (t) => activeRepo && t.repoId === activeRepo.id,
  );
  const otherRepoTasks = filtered.filter(
    (t) => !activeRepo || t.repoId !== activeRepo.id,
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

      {currentRepoTasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Current Repo: {activeRepo?.name}</Text>
          {currentRepoTasks.map((task) => {
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
                    purple={taskColor === "purple" ? 1 : 0}
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

      {otherRepoTasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Other Repos:</Text>
          {otherRepoTasks.map((task) => {
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
                    purple={taskColor === "purple" ? 1 : 0}
                  />
                ) : (
                  <Text> </Text>
                )}
                <Text
                  color={idx === selectedIndex ? "magenta" : undefined}
                  bold={idx === selectedIndex}
                >
                  {idx === selectedIndex ? "▸ " : "  "}
                  {task.repoName} / {task.label}
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
