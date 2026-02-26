import React, { useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useStore } from "./store/index.js";
import {
  getAppState,
  getProjectById,
  getTasksForProject,
} from "./services/db.js";
import { ProjectSelection } from "./views/ProjectSelection.js";
import { TaskList } from "./views/TaskList.js";
import { TaskView } from "./views/TaskView.js";
import { TaskSwitcher } from "./views/TaskSwitcher.js";
import { PrComments } from "./views/PrComments.js";
import { Settings } from "./views/Settings.js";
import { CreatePr } from "./views/CreatePr.js";
import { Standup } from "./views/Standup.js";
import { HotkeyHints } from "./components/HotkeyHints.js";
import { hasModifier } from "./utils/keyboard.js";
import type { ViewState } from "./store/types.js";
import { refreshAllTaskStatuses } from "./services/taskStatus.js";

export function App() {
  const { exit } = useApp();
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const setView = useStore((s) => s.setView);
  const setModal = useStore((s) => s.setModal);
  const activeProject = useStore((s) => s.activeProject);
  const addingProject = useStore((s) => s.addingProject);

  const resolveRestoredView = (
    savedView: ViewState | null,
    hasProject: boolean,
    hasTask: boolean,
  ): ViewState => {
    const preferred = savedView ?? (hasProject ? "tasks" : "projects");

    switch (preferred) {
      case "projects":
      case "settings":
      case "taskSwitcher":
      case "standup":
        return preferred;
      case "tasks":
        return hasProject ? "tasks" : "projects";
      case "taskView":
      case "prComments":
      case "createPr":
        if (hasTask) return preferred;
        return hasProject ? "tasks" : "projects";
      default:
        return hasProject ? "tasks" : "projects";
    }
  };

  // Restore navigation breadcrumb on startup
  useEffect(() => {
    const savedView = getAppState("nav.view") as ViewState | null;
    const savedProjectId = getAppState("nav.project_id");
    const savedTaskId = getAppState("nav.task_id");

    if (!savedProjectId) {
      useStore.getState().setView(resolveRestoredView(savedView, false, false));
      return;
    }

    const project = getProjectById(savedProjectId);
    if (!project) {
      useStore.getState().setView(resolveRestoredView(savedView, false, false));
      return;
    }

    useStore.getState().setActiveProject(project);
    const tasks = getTasksForProject(project.id);
    useStore.getState().setTasks(tasks);

    if (savedTaskId) {
      const task = tasks.find(
        (t) => t.id === savedTaskId && t.status === "active",
      );
      if (task) {
        useStore.getState().setActiveTask(task);
      }
    }

    const hasTask = !!useStore.getState().activeTask;
    useStore.getState().setView(resolveRestoredView(savedView, true, hasTask));
  }, []);

  // Clear screen on view change to prevent stale content above
  useEffect(() => {
    process.stdout.write("\x1b[2J\x1b[H");
  }, [view]);

  // Poll task statuses globally (LLM activity + PR status)
  useEffect(() => {
    const poll = () => {
      refreshAllTaskStatuses();
    };
    poll();
    const interval = setInterval(poll, 30000);
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

    // Esc on task list -> Project Selection
    if (key.escape && view === "tasks") {
      setView("projects");
      return;
    }

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
      setView("taskSwitcher");
      return;
    }
    if (input === "P" && key.super) {
      setView("taskSwitcher");
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
      case "taskSwitcher":
        return <TaskSwitcher />;
      case "prComments":
        return <PrComments />;
      case "settings":
        return <Settings />;
      case "createPr":
        return <CreatePr />;
      case "standup":
        return <Standup />;
      default:
        return <ProjectSelection />;
    }
  };

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {renderView()}
      <HotkeyHints />
    </Box>
  );
}
