import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import {
  getPrComments,
  getCiFailures,
  resolveThread,
  getGitStatusWithPr,
} from "../services/git.js";
import { writeToSession } from "../services/terminalManager.js";
import type { ReviewThread, CiCheckFailure } from "../store/types.js";

const MAX_DETAIL_LOG_LINES = 40;

function truncateDetailLog(
  log: string,
  maxLines = MAX_DETAIL_LOG_LINES,
): { text: string; truncated: boolean } {
  if (!log) return { text: "", truncated: false };

  const lines = log.split("\n");
  const truncated = lines.length > maxLines;
  let text = truncated ? lines.slice(0, maxLines).join("\n") : log;

  if (truncated) {
    text = `${text}\n\n[Output truncated in UI. Press p to paste full output.]`;
  }

  return { text, truncated };
}

function formatThreadForPaste(thread: ReviewThread): string {
  const lines = ["Please fix this PR review comment:"];
  lines.push(`File: ${thread.path}`);
  if (thread.startLine && thread.startLine !== thread.line) {
    lines.push(`Lines: ${thread.startLine}-${thread.line}`);
  } else {
    lines.push(`Line: ${thread.line}`);
  }
  lines.push("");
  for (const c of thread.comments) {
    lines.push(`Comment by @${c.author}:`);
    lines.push(c.body);
    lines.push("");
  }
  return lines.join("\n");
}

function formatCiFailureForPaste(failure: CiCheckFailure): string {
  const lines = ["Please fix this CI failure:"];
  lines.push(`Job: ${failure.name}`);
  if (failure.failedStep) {
    lines.push(`Failed step: ${failure.failedStep}`);
  }
  if (failure.log) {
    lines.push("");
    lines.push("Log output:");
    lines.push(failure.log);
  }
  return lines.join("\n");
}

export function PrComments() {
  const activeTask = useStore((s) => s.activeTask);
  const setView = useStore((s) => s.setView);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const setGitStatus = useStore((s) => s.setGitStatus);

  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [ciFailures, setCiFailures] = useState<CiCheckFailure[]>([]);
  const [selected, setSelected] = useState(0);
  const [loadingComments, setLoadingComments] = useState(true);
  const [loadingCi, setLoadingCi] = useState(true);

  const loading = loadingComments || loadingCi;
  const totalItems = ciFailures.length + threads.length;
  const isCiSelected = selected < ciFailures.length;
  const selectedCi = isCiSelected ? ciFailures[selected] : null;
  const selectedCiDisplay = selectedCi
    ? truncateDetailLog(selectedCi.log)
    : null;
  const selectedThread = !isCiSelected
    ? threads[selected - ciFailures.length]
    : null;

  useEffect(() => {
    if (!activeTask?.worktree_path) {
      setLoadingComments(false);
      setLoadingCi(false);
      return;
    }
    const branch = undefined; // detect from worktree's checked-out branch
    getPrComments(activeTask.worktree_path, branch).then((result) => {
      setThreads(result);
      setLoadingComments(false);
    });
    getCiFailures(activeTask.worktree_path, branch).then((result) => {
      setCiFailures(result);
      setLoadingCi(false);
    });
    // Refresh cached PR status so the header/dots stay current
    getGitStatusWithPr(activeTask.worktree_path, branch).then((status) =>
      setGitStatus(activeTask.id, status),
    );
  }, [activeTask?.id]);

  const goBack = () => setView("taskView");

  const refreshPr = () => {
    if (!activeTask?.worktree_path) return;
    getGitStatusWithPr(activeTask.worktree_path).then((status) =>
      setGitStatus(activeTask.id, status),
    );
  };

  const pasteToConsoleAndSubmit = (taskId: string, text: string) => {
    const consoleSessionId = `${taskId}-console`;
    let promptSent = false;

    const trySendPrompt = (): boolean => {
      if (promptSent) return true;
      const ok = writeToSession(consoleSessionId, text);
      if (ok) promptSent = true;
      return ok;
    };

    const trySendEnter = (): boolean => {
      // Some CLIs/PTYs respond to CR, others to LF. Try both.
      return (
        writeToSession(consoleSessionId, "\r") ||
        writeToSession(consoleSessionId, "\n")
      );
    };

    if (!trySendPrompt()) {
      let promptAttempts = 0;
      const maxPromptAttempts = 40; // 2s
      const promptRetry = setInterval(() => {
        promptAttempts++;
        if (trySendPrompt() || promptAttempts >= maxPromptAttempts) {
          clearInterval(promptRetry);
          if (promptSent) {
            setTimeout(() => {
              trySendEnter();
            }, 120);
          }
        }
      }, 50);
      return;
    }

    // Give the target CLI a beat to ingest pasted text before submit.
    setTimeout(() => {
      if (trySendEnter()) return;
      let enterAttempts = 0;
      const maxEnterAttempts = 20; // 1s
      const enterRetry = setInterval(() => {
        enterAttempts++;
        if (trySendEnter() || enterAttempts >= maxEnterAttempts) {
          clearInterval(enterRetry);
        }
      }, 50);
    }, 120);
  };

  const returnToConsoleWithPrompt = (text: string) => {
    if (!activeTask) return;
    const taskId = activeTask.id;
    goBack();
    setTimeout(() => {
      useStore.getState().setFocusPane("console");
      useStore.getState().markConsoleInteracted(taskId);
      pasteToConsoleAndSubmit(taskId, text);
    }, 0);
  };

  useInput((input, key) => {
    if (key.escape) {
      goBack();
      return;
    }

    if (totalItems === 0) return;

    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(totalItems - 1, s + 1));
      return;
    }

    if (input === "P" && activeTask && totalItems > 0) {
      const parts: string[] = [];
      if (ciFailures.length > 0) {
        parts.push("Please fix these CI failures:\n");
        for (const f of ciFailures) {
          parts.push(formatCiFailureForPaste(f));
        }
      }
      if (threads.length > 0) {
        parts.push("Please fix these PR review comments:\n");
        for (const t of threads) {
          parts.push(formatThreadForPaste(t));
        }
      }
      returnToConsoleWithPrompt(parts.join("\n---\n\n"));
      return;
    }

    if (input === "p" && activeTask) {
      if (selectedCi) {
        returnToConsoleWithPrompt(formatCiFailureForPaste(selectedCi));
      } else if (selectedThread) {
        returnToConsoleWithPrompt(formatThreadForPaste(selectedThread));
      }
      return;
    }

    if (input === "s") {
      // Only works on review threads, not CI failures
      if (isCiSelected || !selectedThread) return;
      const threadIndex = selected - ciFailures.length;
      resolveThread(selectedThread.id).then(() => refreshPr());
      const next = threads.filter((_, i) => i !== threadIndex);
      setThreads(next);
      const newTotal = ciFailures.length + next.length;
      if (selected >= newTotal) setSelected(Math.max(0, newTotal - 1));
      return;
    }
  });

  if (!activeTask) return null;

  // Build header summary
  const headerParts: string[] = [];
  if (ciFailures.length > 0)
    headerParts.push(
      `${ciFailures.length} CI failure${ciFailures.length !== 1 ? "s" : ""}`,
    );
  if (threads.length > 0)
    headerParts.push(
      `${threads.length} unresolved thread${threads.length !== 1 ? "s" : ""}`,
    );
  const headerSummary =
    headerParts.length > 0 ? headerParts.join(", ") : "No issues found";

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          PR Issues
        </Text>
        <Text dimColor>
          {" "}
          — {activeTask.label}
          {loading ? "" : ` (${headerSummary})`}
        </Text>
      </Box>

      {/* List (left) + Detail (right) */}
      <Box flexGrow={1}>
        {/* Item list */}
        <Box flexDirection="column" width="40%">
          {totalItems === 0 && !loading ? (
            <Text dimColor>No issues found.</Text>
          ) : (
            <>
              {/* CI Failures */}
              {loadingCi && <Text dimColor> Loading CI failures...</Text>}
              {ciFailures.map((f, i) => {
                const isSelected = i === selected;
                return (
                  <Box key={`ci-${i}`} flexDirection="column">
                    <Text
                      color={isSelected ? "cyan" : undefined}
                      bold={isSelected}
                      wrap="truncate"
                    >
                      {isSelected ? " \u25B8 " : "   "}
                      <Text color="red">CI: </Text>
                      {f.name}
                    </Text>
                    <Text dimColor wrap="truncate">
                      {"     "}
                      {f.failedStep ? `Step: ${f.failedStep}` : "Failed"}
                    </Text>
                  </Box>
                );
              })}
              {/* Separator */}
              {ciFailures.length > 0 && threads.length > 0 && (
                <Box marginY={0}>
                  <Text dimColor>{"   "}---</Text>
                </Box>
              )}
              {/* Review threads */}
              {loadingComments && (
                <Text dimColor> Loading review threads...</Text>
              )}
              {threads.map((t, i) => {
                const globalIndex = ciFailures.length + i;
                const previewComment =
                  [...t.comments]
                    .reverse()
                    .find((c) => c.body.trim().length > 0) ??
                  t.comments[t.comments.length - 1] ??
                  t.comments[0];
                const previewLine =
                  previewComment?.body
                    .split("\n")
                    .map((line) => line.trim())
                    .find((line) => line.length > 0) ?? "[No description]";
                const firstLine = previewLine.slice(0, 40);
                const isSelected = globalIndex === selected;
                return (
                  <Box key={t.id} flexDirection="column">
                    <Text
                      color={isSelected ? "cyan" : undefined}
                      bold={isSelected}
                      wrap="truncate"
                    >
                      {isSelected ? " \u25B8 " : "   "}
                      {t.path}:{t.line}
                    </Text>
                    <Text dimColor wrap="truncate">
                      {"     "}@{previewComment?.author ?? "unknown"}:{" "}
                      {firstLine}
                      {firstLine.length >= 40 ? "..." : ""}
                    </Text>
                  </Box>
                );
              })}
            </>
          )}
        </Box>

        {/* Detail pane */}
        {(selectedCi || selectedThread) && (
          <Box
            flexDirection="column"
            flexGrow={1}
            marginLeft={1}
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            paddingLeft={1}
          >
            {selectedCi && (
              <>
                <Text bold color="red">
                  {selectedCi.name}
                </Text>
                {selectedCi.failedStep && (
                  <Text dimColor>Step: {selectedCi.failedStep}</Text>
                )}
                {selectedCi.log ? (
                  <>
                    <Box marginTop={1} />
                    <Text wrap="wrap">
                      {selectedCiDisplay?.text || selectedCi.log}
                    </Text>
                  </>
                ) : (
                  <>
                    <Box marginTop={1} />
                    <Text dimColor>No log output available.</Text>
                  </>
                )}
              </>
            )}
            {selectedThread && (
              <>
                <Text bold color="cyan">
                  {selectedThread.path}
                  <Text dimColor>
                    :
                    {selectedThread.startLine &&
                    selectedThread.startLine !== selectedThread.line
                      ? `${selectedThread.startLine}-${selectedThread.line}`
                      : selectedThread.line}
                  </Text>
                </Text>
                <Box marginTop={1} />
                {(() => {
                  const visibleComments = selectedThread.comments.filter(
                    (c) => c.body.trim().length > 0,
                  );
                  if (visibleComments.length === 0) {
                    return <Text dimColor>No comment text available.</Text>;
                  }
                  return visibleComments.map((c, i) => (
                    <Box key={i} flexDirection="column" marginBottom={1}>
                      <Text bold>@{c.author}</Text>
                      <Text wrap="wrap">{c.body}</Text>
                    </Box>
                  ));
                })()}
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
