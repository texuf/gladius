import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useStore } from "./store/index.js";
import { ProjectSelection } from "./views/ProjectSelection.js";
import { TaskList } from "./views/TaskList.js";
import { TaskView } from "./views/TaskView.js";
import { TaskSwitcher } from "./views/TaskSwitcher.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { HotkeyHints } from "./components/HotkeyHints.js";

export function App() {
  const { exit } = useApp();
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const setView = useStore((s) => s.setView);
  const setModal = useStore((s) => s.setModal);
  const activeProject = useStore((s) => s.activeProject);

  useInput((input, key) => {
    // Cmd+Q — Quit
    if (input === "q" && key.super) {
      exit();
      return;
    }

    // Don't process global shortcuts if a modal is open
    if (modal) return;

    // Cmd+Shift+0 — Return to Project Selection
    // Kitty protocol: Cmd+Shift+0 comes as input=")" with key.super
    if (input === ")" && key.super) {
      setView("projects");
      return;
    }

    // Cmd+Shift+N — Add new project
    if (input === "N" && key.super) {
      setView("projects");
      useStore.getState().setAddingProject(true);
      return;
    }

    // Cmd+N — Create new task (requires active project)
    if (input === "n" && key.super && activeProject) {
      setModal({ type: "newTask" });
      return;
    }

    // Cmd+P — Return to Task List
    if (input === "p" && key.super && !key.shift && activeProject) {
      setView("tasks");
      return;
    }

    // Cmd+Shift+P — Open Task Switcher
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
      {renderView()}
      {modal?.type === "taskSwitcher" && <TaskSwitcher />}
      <HotkeyHints />
    </Box>
  );
}
