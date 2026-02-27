import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readdirSync } from "fs";
import { useStore } from "../store/index.js";

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
  const activeTask = useStore((s) => s.activeTask);
  const addingRepo = useStore((s) => s.addingRepo);
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

  if (view === "adoptBranch") {
    hints.push("⏎ Submit", "Esc Cancel");
  } else if (view === "taskSwitcher") {
    hints.push("↑↓ Navigate", "⏎ Switch", "Esc Cancel");
  } else if (view === "projects" && addingRepo) {
    hints.push("Esc Cancel");
  } else if (view === "settings") {
    hints.push("↑↓ Navigate", "⏎ Edit", "Esc Back");
  } else if (view === "projects") {
    hints.push(
      "↑↓ Navigate",
      "⏎ Select",
      "Ctrl+N New Repo",
      "g Project",
      "d Delete",
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
        "Esc Back",
      );
    } else {
      const escHint = focusPane === "terminal" ? "Esc×2" : "Esc";
      hints.push(`${escHint} Unfocus (${focusPane})`);
    }
  } else if (view === "tasks") {
    hints.push(
      "↑↓ Navigate",
      "⇧↑↓ Reorder",
      "⏎ Open",
      "x Close",
      "Ctrl+N New",
      "^A Adopt",
      "/ Search",
      "Ctrl+O Projects",
    );
  } else if (view === "taskView") {
    if (copyMode) {
      hints.push("y Exit Copy", "Esc Exit Copy");
    } else if (focusPane === "none") {
      const modelHints = activeTask?.model
        ? ["c Console", "l Claude", "o Codex"]
        : ["cl Claude", "co Codex"];
      const pr = activeTask && gitStatuses[activeTask.id]?.pr;
      const hasIssues =
        pr &&
        (pr.hasConflicts ||
          pr.unresolvedThreads > 0 ||
          pr.ciFailed > 0 ||
          pr.ciPending > 0);
      const isGreen =
        pr &&
        pr.state === "open" &&
        !pr.hasConflicts &&
        pr.ciFailed === 0 &&
        pr.ciPending === 0 &&
        pr.unresolvedThreads === 0;
      const hasOpenPr = pr && pr.state === "open";
      const branch = activeTask && gitStatuses[activeTask.id]?.branch;
      const isMerged = pr && pr.state === "merged";
      const canCreatePr =
        !pr &&
        branch !== "main" &&
        branch !== "master" &&
        activeTask?.worktree_path;
      const behindMain = activeTask && gitStatuses[activeTask.id]?.behindMain;
      const rebaseHints = behindMain && behindMain > 0 && activeTask?.model ? ["gr Rebase"] : [];
      const towerHints = activeTask?.worktree_path ? ["b Tower"] : [];
      const cursorHints = activeTask?.worktree_path ? ["n Cursor"] : [];
      const openPrHints = hasOpenPr ? ["p View PR"] : [];
      const createPrHints = canCreatePr ? ["p Create PR"] : [];
      const clearPrHints = isMerged ? ["p Clear PR"] : [];
      const prHints = hasIssues ? ["v PR Issues"] : [];
      const mergeHints = isGreen ? ["s Squash Merge"] : [];
      hints.push(
        "i Notes",
        "t Terminal",
        ...modelHints,
        ...towerHints,
        ...cursorHints,
        ...openPrHints,
        ...createPrHints,
        ...clearPrHints,
        ...rebaseHints,
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
    }
  } else if (view === "standup") {
    hints.push("c Copy", "r Regenerate", "Esc Back");
  } else if (view === "createPr") {
    hints.push("Esc Cancel");
  } else if (view === "prComments") {
    hints.push("↑↓ Navigate", "Space Select/Deselect");
    if (prCommentsHasSelection) {
      hints.push("p Paste Selected");
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
