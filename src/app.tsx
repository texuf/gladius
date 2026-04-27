import React, { useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useStore } from "./store/index.js";
import {
  getAppState,
  getProjectById,
  getRepoById,
  getTasksForRepo,
} from "./services/db.js";
import { RepoSelection } from "./views/RepoSelection.js";
import { ProjectView } from "./views/ProjectView.js";
import { TaskList } from "./views/TaskList.js";
import { TaskView } from "./views/TaskView.js";
import { TaskLazygit } from "./views/TaskLazygit.js";
import { TaskTranscript } from "./views/TaskTranscript.js";
import { TaskSwitcher } from "./views/TaskSwitcher.js";
import { PrComments } from "./views/PrComments.js";
import { Settings } from "./views/Settings.js";
import { CreatePr } from "./views/CreatePr.js";
import { Standup } from "./views/Standup.js";
import { AdoptBranch } from "./views/AdoptBranch.js";
import { AdoptCommit } from "./views/AdoptCommit.js";
import { HotkeyHints } from "./components/HotkeyHints.js";
import { HotkeyMenuModal } from "./components/HotkeyMenuModal.js";
import { hasModifier } from "./utils/keyboard.js";
import type { ViewState } from "./store/types.js";
import { refreshAllTaskStatuses } from "./services/taskStatus.js";

export function App() {
  const { exit } = useApp();
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const setView = useStore((s) => s.setView);
  const setModal = useStore((s) => s.setModal);
  const activeRepo = useStore((s) => s.activeRepo);
  const addingRepo = useStore((s) => s.addingRepo);
  const hotkeyMenu = modal?.type === "hotkeyMenu" ? modal : null;

  const resolveRestoredView = (
    savedView: ViewState | null,
    hasActiveProject: boolean,
    hasActiveRepo: boolean,
    hasTask: boolean,
  ): ViewState => {
    const preferred =
      savedView ??
      (hasActiveRepo ? "tasks" : hasActiveProject ? "projectView" : "projects");

    switch (preferred) {
      case "projects":
      case "projectView":
      case "settings":
      case "taskSwitcher":
      case "standup":
        if (preferred === "projectView") {
          return hasActiveProject ? "projectView" : "projects";
        }
        return preferred;
      case "tasks":
      case "adoptBranch":
      case "adoptCommit":
        return hasActiveRepo
          ? "tasks"
          : hasActiveProject
            ? "projectView"
            : "projects";
      case "taskView":
      case "taskLazygit":
      case "taskTranscript":
      case "prComments":
      case "createPr":
        if (hasTask) return preferred;
        return hasActiveRepo
          ? "tasks"
          : hasActiveProject
            ? "projectView"
            : "projects";
      default:
        return hasActiveRepo
          ? "tasks"
          : hasActiveProject
            ? "projectView"
            : "projects";
    }
  };

  // Restore navigation breadcrumb on startup
  useEffect(() => {
    const savedView = getAppState("nav.view") as ViewState | null;
    const savedProjectId = getAppState("nav.project_id");
    const savedRepoId = getAppState("nav.repo_id");
    const savedTaskId = getAppState("nav.task_id");

    if (savedProjectId) {
      const project = getProjectById(savedProjectId);
      if (project) {
        useStore.getState().setActiveProject(project);
      }
    }

    if (savedRepoId) {
      const repo = getRepoById(savedRepoId);
      if (repo) {
        useStore.getState().setActiveRepo(repo);
        const tasks = getTasksForRepo(repo.id);
        useStore.getState().setTasks(tasks);

        if (savedTaskId) {
          const task = tasks.find(
            (t) => t.id === savedTaskId && t.status === "active",
          );
          if (task) {
            useStore.getState().setActiveTask(task);
          }
        }
      }
    }

    const state = useStore.getState();
    const hasTask = !!state.activeTask;
    const hasActiveRepo = !!state.activeRepo;
    const hasActiveProject = !!state.activeProject;
    useStore
      .getState()
      .setView(
        resolveRestoredView(
          savedView,
          hasActiveProject,
          hasActiveRepo,
          hasTask,
        ),
      );
  }, []);

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
    const focusPane = useStore.getState().focusPane;

    if (input === "c" && key.ctrl) {
      if (focusPane === "terminal" || focusPane === "console") {
        return;
      }
      exit();
      return;
    }

    // Cmd+Q / Ctrl+Q — Quit
    if (input === "q" && mod) {
      exit();
      return;
    }

    // Don't process global shortcuts if a modal is open, text input is active,
    // or a terminal/console pane is focused (only Esc handled there)
    if (modal || addingRepo || focusPane !== "none") return;

    // Repos page: plain q quits.
    if (view === "projects" && input === "q" && !mod) {
      exit();
      return;
    }

    // Esc on task list -> Repo Selection
    if (key.escape && view === "tasks") {
      setView("projects");
      return;
    }

    // Cmd+Shift+0 — Return to Repo Selection
    if (input === ")" && key.super) {
      setView("projects");
      return;
    }

    // Cmd+Shift+N — Add new project (Kitty protocol terminals)
    if (input === "N" && key.super) {
      setView("projects");
      useStore.getState().setAddingRepo(true);
      return;
    }

    // Ctrl+N — Context-sensitive: create project (repos) or new task (task/taskView)
    if (input === "n" && mod) {
      if (view === "projects") {
        useStore.getState().setAddingRepo(true);
      } else if ((view === "tasks" || view === "taskView") && activeRepo) {
        setModal({ type: "newTask" });
      }
      return;
    }

    // Ctrl+A — Adopt existing branch (from task list)
    if (input === "a" && mod) {
      if (view === "tasks" && activeRepo) {
        setView("adoptBranch");
      }
      return;
    }

    // Ctrl+S — Create task from commit hash (from task list)
    if (input === "s" && mod) {
      if (view === "tasks" && activeRepo) {
        setView("adoptCommit");
      }
      return;
    }

    // Cmd+P / Ctrl+P — Return to Task List
    if (input === "p" && mod && activeRepo) {
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
        return <RepoSelection />;
      case "projectView":
        return <ProjectView />;
      case "tasks":
        return <TaskList />;
      case "taskView":
        return <TaskView />;
      case "taskLazygit":
        return <TaskLazygit />;
      case "taskTranscript":
        return <TaskTranscript />;
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
      case "adoptBranch":
        return <AdoptBranch />;
      case "adoptCommit":
        return <AdoptCommit />;
      default:
        return <RepoSelection />;
    }
  };

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexGrow={1} flexDirection="column">
        {renderView()}
        {hotkeyMenu && (
          <HotkeyMenuModal
            menu={hotkeyMenu}
            onSelect={(item) => {
              setModal(null);
              item.onSelect();
            }}
            onCancel={() => {
              const onCancel = hotkeyMenu.onCancel;
              setModal(null);
              onCancel?.();
            }}
          />
        )}
      </Box>
      <HotkeyHints />
    </Box>
  );
}
