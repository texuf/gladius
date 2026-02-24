import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readdirSync } from "fs";
import { useStore } from "../store/index.js";

function getPtyCount(): { used: number; max: number } {
  try {
    const used = readdirSync("/dev").filter((f) => f.startsWith("ttys")).length;
    const { execSync } = require("child_process");
    const max = parseInt(execSync("sysctl -n kern.tty.ptmx_max", { encoding: "utf-8" }).trim(), 10) || 511;
    return { used, max };
  } catch {
    return { used: 0, max: 0 };
  }
}

export function HotkeyHints() {
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const focusPane = useStore((s) => s.focusPane);
  const activeTask = useStore((s) => s.activeTask);
  const addingProject = useStore((s) => s.addingProject);

  const [pty, setPty] = useState({ used: 0, max: 0 });

  useEffect(() => {
    setPty(getPtyCount());
    const interval = setInterval(() => setPty(getPtyCount()), 5000);
    return () => clearInterval(interval);
  }, []);

  const hints: string[] = [];

  if (modal?.type === "taskSwitcher") {
    hints.push("↑↓ Navigate", "⏎ Switch", "Esc Cancel");
  } else if (view === "projects" && addingProject) {
    hints.push("Esc Cancel");
  } else if (view === "projects") {
    hints.push("↑↓ Navigate", "⏎ Select", "Ctrl+N New Project", "d Delete");
  } else if (view === "tasks") {
    hints.push(
      "↑↓ Navigate",
      "⇧↑↓ Reorder",
      "⏎ Open",
      "x Close",
      "Ctrl+N New",
      "/ Search",
      "Ctrl+O Projects"
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
      hints.push(`Esc×2 Unfocus (${focusPane})`);
    }
  }

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1} justifyContent="space-between">
      <Text dimColor>{hints.join("  ")}</Text>
      {pty.max > 0 && <Text dimColor>PTY {pty.used}/{pty.max}</Text>}
    </Box>
  );
}
