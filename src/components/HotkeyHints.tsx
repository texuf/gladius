import React from "react";
import { Box, Text } from "ink";
import { useStore } from "../store/index.js";

// Use Ctrl labels since they work everywhere; Cmd also works in Kitty-protocol terminals
const MOD = "Ctrl";

export function HotkeyHints() {
  const view = useStore((s) => s.view);
  const focusPane = useStore((s) => s.focusPane);
  const activeTask = useStore((s) => s.activeTask);

  const hints: string[] = [];

  if (view === "projects") {
    hints.push("↑↓ Navigate", "⏎ Select", `${MOD}+Shift+N New Project`);
  } else if (view === "tasks") {
    hints.push(
      "↑↓ Navigate",
      "⇧↑↓ Reorder",
      "⏎ Open",
      "x Close",
      `${MOD}+N New`,
      `${MOD}+⇧0 Projects`
    );
  } else if (view === "taskView") {
    if (focusPane === "none") {
      const modelHints = activeTask?.model
        ? ["c Console"]
        : ["cl Claude", "co Codex"];
      hints.push(
        "i Notes",
        "t Terminal",
        ...modelHints,
        "Esc Back",
        "x Close"
      );
    } else {
      hints.push(`Esc Unfocus (${focusPane})`);
    }
  }

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text dimColor>{hints.join("  ")}</Text>
    </Box>
  );
}
