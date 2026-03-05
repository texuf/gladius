import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { $ } from "bun";
import { useStore } from "../store/index.js";
import { getTasksForRepo, createTask as dbCreateTask } from "../services/db.js";
import { createWorktree, deleteWorktree } from "../services/worktree.js";
import { deduplicateLabel, generateLabel } from "../utils/label.js";
import { BRANCH_PREFIX } from "../utils/constants.js";

type Phase = "input" | "creating" | "error";

export function AdoptCommit() {
  const activeRepo = useStore((s) => s.activeRepo);
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setTasks = useStore((s) => s.setTasks);

  const [phase, setPhase] = useState<Phase>("input");
  const [commitHash, setCommitHash] = useState("");
  const [error, setError] = useState("");

  const reloadTasks = useCallback(() => {
    if (activeRepo) {
      const updated = getTasksForRepo(activeRepo.id);
      setTasks(updated);
      return updated;
    }
    return [];
  }, [activeRepo, setTasks]);

  const handleSubmit = async (value: string) => {
    const trimmedHash = value.trim();
    if (!trimmedHash || !activeRepo) return;

    setPhase("creating");
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    try {
      const subject =
        await $`git -C ${activeRepo.path} show -s --format=%s ${trimmedHash}`.text();
      const description = subject.trim();
      if (!description) {
        throw new Error("Commit has no subject line.");
      }

      const existingLabels = getTasksForRepo(activeRepo.id).map((t) => t.label);
      let label = generateLabel(description);
      if (!label) {
        label = `commit-${trimmedHash.slice(0, 8)}`;
      }
      label = deduplicateLabel(label, existingLabels);
      branchName = `${BRANCH_PREFIX}/${label}`;

      worktreePath = await createWorktree(activeRepo.path, label);
      await $`git -C ${worktreePath} cherry-pick ${trimmedHash}`.text();

      const task = dbCreateTask(
        activeRepo.id,
        label,
        description,
        branchName,
        worktreePath,
      );

      reloadTasks();
      setActiveTask(task);
      setView("taskView");
    } catch (e: any) {
      if (worktreePath && branchName) {
        try {
          await $`git -C ${worktreePath} cherry-pick --abort`.quiet().nothrow();
        } catch {}
        try {
          await deleteWorktree(activeRepo.path, worktreePath, branchName);
        } catch {}
      }
      const stderr = e?.stderr?.toString?.()?.trim?.();
      setError(stderr || e?.message || "Failed to create task from commit");
      setPhase("error");
    }
  };

  useInput((_input, key) => {
    if (useStore.getState().modal?.type === "hotkeyMenu") return;
    if (key.escape) {
      setView("tasks");
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      flexGrow={1}
      width="100%"
    >
      <Text bold color="magenta">
        Create Task From Commit
      </Text>

      {phase === "input" && (
        <Box marginTop={1}>
          <Text>Commit: </Text>
          <InkTextInput
            value={commitHash}
            onChange={setCommitHash}
            onSubmit={handleSubmit}
            placeholder="Paste commit hash..."
          />
        </Box>
      )}

      {phase === "creating" && (
        <Box marginTop={1}>
          <Text dimColor>
            Creating worktree and cherry-picking {commitHash}...
          </Text>
        </Box>
      )}

      {phase === "error" && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Error: {error}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Esc to go back</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
