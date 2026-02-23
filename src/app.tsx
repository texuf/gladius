import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useStore } from "./store/index.js";
import { ProjectSelection } from "./views/ProjectSelection.js";
import { TaskList } from "./views/TaskList.js";
import { TaskView } from "./views/TaskView.js";
import { TaskSwitcher } from "./views/TaskSwitcher.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { HotkeyHints } from "./components/HotkeyHints.js";
import { hasModifier } from "./utils/keyboard.js";

export function App() {
  const { exit } = useApp();
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const setView = useStore((s) => s.setView);
  const setModal = useStore((s) => s.setModal);
  const activeProject = useStore((s) => s.activeProject);

  useInput((input, key) => {
    const mod = hasModifier(key);

    // Cmd+Q / Ctrl+Q — Quit
    if (input === "q" && mod) {
      exit();
      return;
    }

    // Don't process global shortcuts if a modal is open
    if (modal) return;

    // Cmd+Shift+0 / Ctrl+Shift+0 — Return to Project Selection
    // Kitty protocol: Cmd+Shift+0 comes as input=")" with key.super
    // Standard terminal: Ctrl+0 may come as input="0" with key.ctrl
    if ((input === ")" || input === "0") && mod) {
      setView("projects");
      return;
    }

    // Cmd+Shift+N / Ctrl+Shift+N — Add new project
    if (input === "N" && mod) {
      setView("projects");
      useStore.getState().setAddingProject(true);
      return;
    }

    // Cmd+N / Ctrl+N — Create new task (requires active project)
    if (input === "n" && mod && activeProject) {
      setModal({ type: "newTask" });
      return;
    }

    // Cmd+P / Ctrl+P — Return to Task List
    if (input === "p" && mod && !key.shift && activeProject) {
      setView("tasks");
      return;
    }

    // Cmd+Shift+P / Ctrl+Shift+P — Open Task Switcher
    if (input === "P" && mod) {
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
