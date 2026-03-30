import { render } from "ink";
import React from "react";
import { App } from "./app.js";
import { useStore } from "./store/index.js";
import {
  detachAllSessions,
  writeToSession,
} from "./services/terminalManager.js";

// Bun workaround: ensure stdin is flowing for Ink to receive input
process.stdin.resume();

// Enter alternate screen buffer (like vim/less/htop)
process.stdout.write("\x1b[?1049h");
// Hide cursor
process.stdout.write("\x1b[?25l");
// Clear screen
process.stdout.write("\x1b[2J\x1b[H");

const { waitUntilExit, unmount } = render(<App />, {
  exitOnCtrlC: false,
});

function sendSigintToFocusedPane(): boolean {
  const state = useStore.getState();
  if (state.focusPane !== "terminal" && state.focusPane !== "console") {
    return false;
  }

  const paneSuffix = state.focusPane;
  const taskSessionId = state.activeTask
    ? `${state.activeTask.id}-${paneSuffix}`
    : null;
  if (taskSessionId && writeToSession(taskSessionId, "\x03")) {
    return true;
  }

  const projectSessionId = state.activeProject
    ? `project-${state.activeProject.id}-${paneSuffix}`
    : null;
  if (projectSessionId && writeToSession(projectSessionId, "\x03")) {
    return true;
  }

  return false;
}

// Restore terminal on exit
function cleanup() {
  detachAllSessions();
  // Show cursor
  process.stdout.write("\x1b[?25h");
  // Leave alternate screen buffer
  process.stdout.write("\x1b[?1049l");
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  if (sendSigintToFocusedPane()) {
    return;
  }
  unmount();
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  unmount();
  cleanup();
  process.exit(0);
});

waitUntilExit().then(cleanup);
