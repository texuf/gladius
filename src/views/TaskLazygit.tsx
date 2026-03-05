import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { EmbeddedTerminal } from "../components/EmbeddedTerminal.js";
import { useStore } from "../store/index.js";
import { formatPrStatus, getGitStatusWithPr } from "../services/git.js";

const LAZYGIT_RESERVED_ROWS = 10; // header + hints + frame overhead
const LAZYGIT_CHROME_COLS = 6; // pane border/padding + outer padding

export function TaskLazygit() {
  const activeTask = useStore((s) => s.activeTask);
  const activeRepo = useStore((s) => s.activeRepo);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const setGitStatus = useStore((s) => s.setGitStatus);
  const setView = useStore((s) => s.setView);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const [termError, setTermError] = useState("");

  const hasWorktree = !!activeTask?.worktree_path;

  useEffect(() => {
    if (!activeTask) {
      setView("tasks");
      return;
    }
  }, [activeTask?.id, setView]);

  useEffect(() => {
    if (!hasWorktree) {
      setFocusPane("none");
      return;
    }
    setFocusPane("terminal");
    return () => {
      if (useStore.getState().focusPane === "terminal") {
        setFocusPane("none");
      }
    };
  }, [hasWorktree, setFocusPane]);

  useEffect(() => {
    if (!activeTask?.worktree_path) return;
    let cancelled = false;

    const poll = () => {
      if (!activeTask?.worktree_path) return;
      getGitStatusWithPr(activeTask.worktree_path)
        .then((status) => {
          if (!cancelled) {
            setGitStatus(activeTask.id, status);
          }
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeTask?.id, activeTask?.worktree_path, setGitStatus]);

  useInput((_input, key) => {
    if (useStore.getState().modal?.type === "hotkeyMenu") return;
    if (!hasWorktree && key.escape) {
      setView("taskView");
    }
  });

  if (!activeTask) return null;

  const gitStatus = gitStatuses[activeTask.id];
  const lazygitRows = Math.max(
    8,
    (process.stdout.rows || 24) - LAZYGIT_RESERVED_ROWS,
  );
  const lazygitCols = Math.max(
    40,
    (process.stdout.columns || 80) - LAZYGIT_CHROME_COLS,
  );
  const isEvenWithTracking =
    !!gitStatus &&
    gitStatus.hasTrackingBranch &&
    gitStatus.ahead === 0 &&
    gitStatus.behind === 0 &&
    !gitStatus.tracksMain;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="column">
          <Text dimColor>
            {activeRepo ? `${activeRepo.name}/` : `${activeTask.label}`}
          </Text>
          <Text>{activeTask.description}</Text>
          {gitStatus && (
            <Text dimColor>
              {gitStatus.branch}
              {(gitStatus.ahead > 0 ||
                gitStatus.behind > 0 ||
                gitStatus.tracksMain ||
                isEvenWithTracking) && (
                <>
                  {" "}
                  (
                  {isEvenWithTracking
                    ? "="
                    : `+${gitStatus.ahead}/${gitStatus.tracksMain ? "m" : `-${gitStatus.behind}`}`}
                  )
                </>
              )}
              {gitStatus.behindMain > 0 ? ` [-${gitStatus.behindMain}]` : ""}
              {gitStatus.changedFiles > 0
                ? ` ${gitStatus.changedFiles} file${gitStatus.changedFiles === 1 ? "" : "s"}`
                : ""}
              {gitStatus.pr ? ` ${formatPrStatus(gitStatus.pr)}` : ""}
            </Text>
          )}
        </Box>
        <Text dimColor color="green">
          LazyGit
        </Text>
      </Box>

      {termError && (
        <Box marginBottom={1}>
          <Text color="red">{termError}</Text>
        </Box>
      )}

      {!hasWorktree ? (
        <Text dimColor>[No worktree available for this task]</Text>
      ) : (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="green"
          paddingX={1}
          flexGrow={1}
        >
          <EmbeddedTerminal
            taskId={`${activeTask.id}-lazygit`}
            cwd={activeTask.worktree_path!}
            command={["lazygit"]}
            focused={true}
            rows={lazygitRows}
            cols={lazygitCols}
            singleEsc={true}
            onEsc={() => {
              setFocusPane("none");
              setView("taskView");
            }}
            onError={setTermError}
          />
        </Box>
      )}
    </Box>
  );
}
