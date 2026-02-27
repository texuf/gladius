import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import {
  getTasksForRepo,
  createTask as dbCreateTask,
} from "../services/db.js";
import { adoptBranch } from "../services/worktree.js";
import { deduplicateLabel } from "../utils/label.js";

type Phase = "input" | "creating" | "error";

export function AdoptBranch() {
  const activeRepo = useStore((s) => s.activeRepo);
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setTasks = useStore((s) => s.setTasks);

  const [phase, setPhase] = useState<Phase>("input");
  const [branchName, setBranchName] = useState("");
  const [error, setError] = useState("");

  const reloadTasks = useCallback(() => {
    if (activeRepo) {
      const updated = getTasksForRepo(activeRepo.id);
      setTasks(updated);
      return updated;
    }
    return [];
  }, [activeRepo]);

  const handleSubmit = async (branch: string) => {
    const trimmed = branch.trim();
    if (!trimmed || !activeRepo) return;

    setPhase("creating");

    try {
      const parts = trimmed.split("/");
      let label = parts[parts.length - 1];
      if (label.length > 30) label = label.slice(0, 30);

      const existingLabels = getTasksForRepo(activeRepo.id).map((t) => t.label);
      label = deduplicateLabel(label, existingLabels);

      const description = `Adopted branch: ${trimmed}`;
      const worktreePath = await adoptBranch(activeRepo.path, trimmed, label);
      const task = dbCreateTask(
        activeRepo.id,
        label,
        description,
        trimmed,
        worktreePath,
      );

      reloadTasks();
      setActiveTask(task);
      setView("taskView");
    } catch (e: any) {
      setError(e.message || "Failed to adopt branch");
      setPhase("error");
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      setView("tasks");
      return;
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
        Adopt Branch
      </Text>

      {phase === "input" && (
        <Box marginTop={1}>
          <Text>Branch: </Text>
          <InkTextInput
            value={branchName}
            onChange={setBranchName}
            onSubmit={handleSubmit}
            placeholder="Paste branch name..."
          />
        </Box>
      )}

      {phase === "creating" && (
        <Box marginTop={1}>
          <Text dimColor>Creating worktree for {branchName}...</Text>
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
