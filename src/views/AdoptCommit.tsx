import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { getTasksForRepo, createTask as dbCreateTask } from "../services/db.js";
import { createWorktree, deleteWorktree } from "../services/worktree.js";
import {
  resolveProjectBackend,
  runBackendCommand,
} from "../services/projectBackend.js";
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
    const backend = resolveProjectBackend({
      backend_kind: activeRepo.project_backend_kind,
      backend_target: activeRepo.project_backend_target,
      backend_base_path: activeRepo.project_backend_base_path,
      backend_display_name: activeRepo.project_backend_display_name,
      path: activeRepo.project_path,
      name: activeRepo.project_name,
    });
    try {
      const subjectResult = runBackendCommand(
        backend,
        `git show -s --format=%s ${trimmedHash}`,
        { cwd: activeRepo.path },
      );
      if (subjectResult.exitCode !== 0) {
        throw new Error(
          (subjectResult.stderr || subjectResult.stdout).trim() ||
            "Failed to read commit subject.",
        );
      }
      const subject = subjectResult.stdout;
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

      worktreePath = await createWorktree(activeRepo, label);
      const cherryPickResult = runBackendCommand(
        backend,
        `git cherry-pick ${trimmedHash}`,
        { cwd: worktreePath },
      );
      if (cherryPickResult.exitCode !== 0) {
        throw new Error(
          (cherryPickResult.stderr || cherryPickResult.stdout).trim() ||
            "Failed to cherry-pick commit.",
        );
      }

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
          runBackendCommand(backend, "git cherry-pick --abort >/dev/null 2>&1 || true", {
            cwd: worktreePath,
          });
        } catch {}
        try {
          await deleteWorktree(activeRepo, worktreePath, branchName);
        } catch {}
      }
      setError(e?.message || "Failed to create task from commit");
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
