import React, { useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useStore } from "./store/index.js";
import { getAppState, getProjectById, getTasksForProject } from "./services/db.js";
import { ProjectSelection } from "./views/ProjectSelection.js";
import { TaskList } from "./views/TaskList.js";
import { TaskView } from "./views/TaskView.js";
import { TaskSwitcher } from "./views/TaskSwitcher.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { HotkeyHints } from "./components/HotkeyHints.js";
import { hasModifier } from "./utils/keyboard.js";
import type { ViewState } from "./store/types.js";
import { computeAllTaskStatuses } from "./services/taskStatus.js";

export function App() {
  const { exit } = useApp();
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const setView = useStore((s) => s.setView);
  const setModal = useStore((s) => s.setModal);
  const activeProject = useStore((s) => s.activeProject);
  const addingProject = useStore((s) => s.addingProject);

  // Restore navigation breadcrumb on startup
  useEffect(() => {
    const savedView = getAppState("nav.view") as ViewState | null;
    const savedProjectId = getAppState("nav.project_id");
    const savedTaskId = getAppState("nav.task_id");

    if (!savedProjectId) {
      if (savedView) useStore.getState().setView(savedView);
      return;
    }

    const project = getProjectById(savedProjectId);
    if (!project) return; // deleted project — stay on projects view

    useStore.getState().setActiveProject(project);
    const tasks = getTasksForProject(project.id);
    useStore.getState().setTasks(tasks);

    if (savedTaskId) {
      const task = tasks.find((t) => t.id === savedTaskId && t.status === "active");
      if (task) {
        useStore.getState().setActiveTask(task);
      }
    }

    // Restore the actual saved view (projects, tasks, or taskView)
    // Fall back to tasks if we were on taskView but the task no longer exists
    if (savedView === "taskView" && !useStore.getState().activeTask) {
      useStore.getState().setView("tasks");
    } else {
      useStore.getState().setView(savedView || "tasks");
    }
  }, []);

  // Poll task statuses globally (LLM activity + PR status)
  useEffect(() => {
    const poll = () => {
      computeAllTaskStatuses().then((statuses) => {
        useStore.getState().setTaskStatuses(statuses);
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    const mod = hasModifier(key);

    // Cmd+Q / Ctrl+Q — Quit
    if (input === "q" && mod) {
      exit();
      return;
    }

    // Don't process global shortcuts if a modal is open, text input is active,
    // or a terminal/console pane is focused (only Esc handled there)
    const focusPane = useStore.getState().focusPane;
    if (modal || addingProject || focusPane !== "none") return;

    // Ctrl+O / Cmd+Shift+0 — Return to Project Selection
    if ((input === "o" && key.ctrl) || (input === ")" && key.super)) {
      setView("projects");
      return;
    }

    // Cmd+Shift+N — Add new project (Kitty protocol terminals)
    if (input === "N" && key.super) {
      setView("projects");
      useStore.getState().setAddingProject(true);
      return;
    }

    // Ctrl+N — Context-sensitive: add project (project view) or new task (task/taskView)
    if (input === "n" && mod) {
      if (view === "projects") {
        useStore.getState().setAddingProject(true);
      } else if (activeProject) {
        setModal({ type: "newTask" });
      }
      return;
    }

    // Cmd+P / Ctrl+P — Return to Task List
    if (input === "p" && mod && activeProject) {
      setView("tasks");
      return;
    }

    // "/" — Open Task Switcher (works in any terminal)
    // Cmd+Shift+P — Open Task Switcher (Kitty protocol)
    if (input === "/" && !mod) {
      setModal({ type: "taskSwitcher" });
      return;
    }
    if (input === "P" && key.super) {
      setModal({ type: "taskSwitcher" });
      return;
    }
  });

  const renderView = () => {
    switch (view) {
      case "projects":
        return <ProjectSelection />;
      case "tasks":
        return <TaskList />;
      case "taskView":
        return <TaskView />;
      default:
        return <ProjectSelection />;
    }
  };

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {modal?.type === "taskSwitcher" ? <TaskSwitcher /> : renderView()}
      <HotkeyHints />
    </Box>
  );
}
