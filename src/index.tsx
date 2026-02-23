import { render } from "ink";
import React from "react";
import { App } from "./app.js";

// Bun workaround: ensure stdin is flowing for Ink to receive input
process.stdin.resume();

// Enter alternate screen buffer (like vim/less/htop)
process.stdout.write("\x1b[?1049h");
// Hide cursor
process.stdout.write("\x1b[?25l");
// Clear screen
process.stdout.write("\x1b[2J\x1b[H");

const { waitUntilExit, unmount } = render(<App />);

// Restore terminal on exit
function cleanup() {
  // Show cursor
  process.stdout.write("\x1b[?25h");
  // Leave alternate screen buffer
  process.stdout.write("\x1b[?1049l");
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
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
