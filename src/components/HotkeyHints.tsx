import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readdirSync } from "fs";
import { useStore } from "../store/index.js";
import { isProjectLinearEnabled } from "../services/db.js";

function getPtyCount(): { used: number; max: number } {
  try {
    const used = readdirSync("/dev").filter((f) => f.startsWith("ttys")).length;
    const { execSync } = require("child_process");
    const max =
      parseInt(
        execSync("sysctl -n kern.tty.ptmx_max", { encoding: "utf-8" }).trim(),
        10,
      ) || 511;
    return { used, max };
  } catch {
    return { used: 0, max: 0 };
  }
}

export function HotkeyHints() {
  const view = useStore((s) => s.view);
  const focusPane = useStore((s) => s.focusPane);
  const activeRepo = useStore((s) => s.activeRepo);
  const activeTask = useStore((s) => s.activeTask);
  const addingRepo = useStore((s) => s.addingRepo);
  const modal = useStore((s) => s.modal);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const copyMode = useStore((s) => s.copyMode);
  const prCommentsSelectionKind = useStore((s) => s.prCommentsSelectionKind);
  const prCommentsHasSelection = useStore((s) => s.prCommentsHasSelection);

  const [pty, setPty] = useState({ used: 0, max: 0 });

  useEffect(() => {
    setPty(getPtyCount());
    const interval = setInterval(() => setPty(getPtyCount()), 5000);
    return () => clearInterval(interval);
  }, []);

  const hints: string[] = [];

  if (modal?.type === "hotkeyMenu") {
    hints.push("↑↓ Navigate", "⏎ Select", "Esc Cancel");
  } else if (view === "adoptBranch" || view === "adoptCommit") {
    hints.push("⏎ Submit", "Esc Cancel");
  } else if (view === "taskSwitcher") {
    hints.push("↑↓ Navigate", "⏎ Switch", "Esc Cancel");
  } else if (view === "projects" && addingRepo) {
    hints.push("⏎ Create", "Esc Cancel");
  } else if (view === "settings") {
    hints.push("↑↓ Navigate", "⏎ Edit", "Esc Back");
  } else if (view === "projects") {
    hints.push(
      "↑↓ Navigate",
      "⏎ Select",
      "Ctrl+N New Project",
      "r Refresh",
      "g Project",
      "d Delete",
      "q Quit",
      "u Standup",
      "s Settings",
    );
  } else if (view === "projectView") {
    if (focusPane === "none") {
      hints.push(
        "i Title",
        "t Terminal",
        "c Console",
        "cl Claude",
        "co Codex",
        "l/o Switch",
        "r Refresh",
        "d Dependencies",
        "y Linear",
        "Esc Back",
      );
    } else {
      const escHint = focusPane === "terminal" ? "Esc×2" : "Esc";
      hints.push(`${escHint} Unfocus (${focusPane})`);
      if (focusPane === "console") {
        hints.push("Ctrl+] Send Esc");
      }
    }
  } else if (view === "tasks") {
    const showLinearIssueHotkey =
      !!activeRepo && isProjectLinearEnabled(activeRepo.project_id);
    hints.push(
      "↑↓ Navigate",
      "⇧↑↓ Reorder",
      "⏎ Open",
      ...(showLinearIssueHotkey ? ["p View Issue"] : []),
      "x Close",
      "Ctrl+N New",
      "^A Adopt",
      "^S From Commit",
      "/ Search",
      "Ctrl+O Projects",
    );
  } else if (view === "taskView") {
    if (copyMode) {
      hints.push("y Exit Copy", "Esc Exit Copy");
    } else if (focusPane === "none") {
      const modelHints = activeTask?.model
        ? ["c Console"]
        : ["c Console (pick model)"];
      const pr = activeTask && gitStatuses[activeTask.id]?.pr;
      const prColor = pr?.statusColor ?? "none";
      const hasIssues = prColor === "red" || prColor === "yellow";
      const isGreen = prColor === "green";
      const prHints = hasIssues ? ["v PR Issues"] : [];
      const mergeHints = isGreen ? ["s Squash Merge"] : [];
      hints.push(
        "i Notes",
        "t Terminal",
        "o Open",
        "g Git",
        "l LazyGit",
        ...modelHints,
        ...prHints,
        ...mergeHints,
        "y Copy",
        "r Refresh",
        "Esc Back",
        "x Close",
      );
    } else {
      const escHint = focusPane === "console" ? "Esc" : "Esc×2";
      hints.push(`${escHint} Unfocus (${focusPane})`);
      if (focusPane === "console") {
        hints.push("Ctrl+] Send Esc");
      }
    }
  } else if (view === "taskLazygit") {
    hints.push("Esc Back", "Ctrl+] Send Esc");
  } else if (view === "standup") {
    hints.push("c Copy", "r Regenerate", "Esc Back");
  } else if (view === "createPr") {
    hints.push("Esc Cancel");
  } else if (view === "prComments") {
    hints.push("↑↓ Navigate", "Space Select/Deselect", "c Comment");
    if (prCommentsHasSelection) {
      hints.push("⏎ Send+Commit", "p Send");
    }
    if (prCommentsSelectionKind === "thread") {
      hints.push("s Resolve");
    }
    hints.push("Esc Back");
  }

  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      justifyContent="space-between"
    >
      <Text dimColor>{hints.join("  ")}</Text>
      {pty.max > 0 && (
        <Text dimColor>
          PTY {pty.used}/{pty.max}
        </Text>
      )}
    </Box>
  );
}
