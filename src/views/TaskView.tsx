import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { $ } from "bun";
import { useStore } from "../store/index.js";
import { NotesPane } from "../components/NotesPane.js";
import { TaskStatusPane } from "../components/TaskStatusPane.js";
import { TerminalPane } from "../components/TerminalPane.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import {
  COMMIT_MESSAGE_MODEL,
  generateCommitMessage,
} from "../services/llm.js";
import {
  fetchLatestMain,
  formatPrStatus,
  getCurrentBranch,
  getGitStatus,
  getGitStatusWithPr,
  pushBranch,
} from "../services/git.js";
import { refreshAllTaskStatuses } from "../services/taskStatus.js";
import {
  addTaskEvent,
  closeTask as dbCloseTask,
  getAppState,
  getProjectLinearTeam,
  updateTask,
  getTasksForRepo,
} from "../services/db.js";
import { deleteWorktree } from "../services/worktree.js";
import { destroySession, isSessionDead } from "../services/terminalManager.js";
import { StatusDots } from "../components/StatusDots.js";
import { getRecentTaskPrompts } from "../services/taskPrompt.js";

const MAX_DIFF_CHARS = 120_000;
const MAX_PROMPTS_CHARS = 40_000;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_UNTRACKED_FILES_IN_PROMPT = 20;

export function TaskView() {
  const activeTask = useStore((s) => s.activeTask);
  const activeRepo = useStore((s) => s.activeRepo);
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const escCooldownRef = useRef(0);
  const lastUnfocusRef = useRef(0);
  const prevFocusPaneRef = useRef(focusPane);
  const gitIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const setView = useStore((s) => s.setView);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setTasks = useStore((s) => s.setTasks);
  const modal = useStore((s) => s.modal);
  const setModal = useStore((s) => s.setModal);
  const gitStatuses = useStore((s) => s.gitStatuses);
  const setGitStatus = useStore((s) => s.setGitStatus);
  const taskStatuses = useStore((s) => s.taskStatuses);
  const copyMode = useStore((s) => s.copyMode);
  const setCopyMode = useStore((s) => s.setCopyMode);
  const [fetching, setFetching] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Fetching");
  const [actionError, setActionError] = useState("");

  const markConsoleInteracted = (taskId: string) => {
    useStore.getState().markConsoleInteracted(taskId);
    useStore.getState().setTaskStatuses({
      ...useStore.getState().taskStatuses,
      [taskId]: "yellow",
    });
  };

  const resetDeadConsoleSession = () => {
    if (!activeTask?.model) return;
    const sessionKey = `${activeTask.id}-console`;
    if (!isSessionDead(sessionKey)) return;

    destroySession(sessionKey);

    const updates =
      activeTask.model === "claude"
        ? { claude_session_id: null }
        : { codex_session_id: null };
    updateTask(activeTask.id, updates);
    setActiveTask({ ...activeTask, ...updates });
    setTasks(
      useStore
        .getState()
        .tasks.map((t) => (t.id === activeTask.id ? { ...t, ...updates } : t)),
    );
  };

  const selectModel = (model: "claude" | "codex") => {
    if (!activeTask) return;
    if (activeTask.model === model) {
      setFocusPane("console");
      markConsoleInteracted(activeTask.id);
      return;
    }

    const switchingProvider = !!activeTask.model && activeTask.model !== model;
    if (switchingProvider) {
      destroySession(`${activeTask.id}-console`);
    }

    const updates = { model };
    updateTask(activeTask.id, updates);
    setActiveTask({ ...activeTask, ...updates });
    setTasks(
      useStore
        .getState()
        .tasks.map((t) => (t.id === activeTask.id ? { ...t, ...updates } : t)),
    );
    setFocusPane("console");
    markConsoleInteracted(activeTask.id);
  };

  // Track when focusPane transitions to "none" (covers both useInput and raw stdin onEsc)
  useEffect(() => {
    if (prevFocusPaneRef.current !== "none" && focusPane === "none") {
      lastUnfocusRef.current = Date.now();
    }
    prevFocusPaneRef.current = focusPane;
  }, [focusPane]);

  // Poll git status (fast) and PR status (slower, separate)
  const prInFlightRef = useRef(false);

  const pollGit = () => {
    if (!activeTask?.worktree_path) return Promise.resolve();
    return getGitStatus(activeTask.worktree_path).then((status) => {
      // Merge git fields atomically, preserving whatever PR data exists
      useStore.setState((state) => ({
        gitStatuses: {
          ...state.gitStatuses,
          [activeTask.id]: {
            ...status,
            pr: state.gitStatuses[activeTask.id]?.pr ?? null,
          },
        },
      }));
    });
  };
  const pollPr = (forceRefresh = false) => {
    if (!activeTask?.worktree_path) return Promise.resolve();
    if (prInFlightRef.current && !forceRefresh) return Promise.resolve();
    prInFlightRef.current = true;
    return getGitStatusWithPr(activeTask.worktree_path, undefined, {
      forcePrRefresh: forceRefresh,
    })
      .then((status) => {
        setGitStatus(activeTask.id, status);
        // Stop polling once checks are settled (nothing pending)
        if (status.pr && status.pr.ciPending === 0 && prIntervalRef.current) {
          clearInterval(prIntervalRef.current);
          prIntervalRef.current = null;
        }
      })
      .finally(() => {
        prInFlightRef.current = false;
      });
  };

  const startPolling = () => {
    if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
    if (prIntervalRef.current) clearInterval(prIntervalRef.current);
    pollGit();
    pollPr();
    gitIntervalRef.current = setInterval(pollGit, 5000);
    prIntervalRef.current = setInterval(pollPr, 30000);
  };

  useEffect(() => {
    if (!activeTask?.worktree_path) return;
    startPolling();
    return () => {
      if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
      if (prIntervalRef.current) clearInterval(prIntervalRef.current);
    };
  }, [activeTask?.id]);

  // Pause/resume polling when copy mode toggles
  useEffect(() => {
    if (copyMode) {
      if (gitIntervalRef.current) {
        clearInterval(gitIntervalRef.current);
        gitIntervalRef.current = null;
      }
      if (prIntervalRef.current) {
        clearInterval(prIntervalRef.current);
        prIntervalRef.current = null;
      }
    } else if (activeTask?.worktree_path) {
      startPolling();
    }
  }, [copyMode]);

  const handleOpenLinearIssue = () => {
    const issueId = activeTask?.linear_issue_id?.trim();
    if (!issueId) return;
    const team = activeRepo
      ? getProjectLinearTeam(activeRepo.project_id).trim() || "hnt-labs"
      : "hnt-labs";
    const url = `https://linear.app/${team}/issue/${issueId}`;
    try {
      Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {}
  };

  const handlePush = async (force = false) => {
    if (!activeTask?.worktree_path) return;
    const repoPath = activeTask.worktree_path;
    setActionError("");
    setBusyLabel(force ? "Force pushing" : "Pushing");
    setFetching(true);
    try {
      const branch = await getCurrentBranch(repoPath);
      if (force) {
        await $`git -C ${repoPath} push --force-with-lease -u origin ${branch}`.text();
      } else {
        await pushBranch(repoPath, branch);
      }
      await pollGit();
      await pollPr(true);
    } catch (e: any) {
      const stderr = e?.stderr?.toString?.()?.trim?.();
      setActionError(
        stderr || e?.message || (force ? "Force push failed" : "Push failed"),
      );
    } finally {
      setFetching(false);
      setBusyLabel("Fetching");
    }
  };

  const openOpenMenu = () => {
    const pr = activeTask ? gitStatuses[activeTask.id]?.pr : null;
    const hasLinearIssue = !!activeTask?.linear_issue_id?.trim();
    const hasWorktree = !!activeTask?.worktree_path;

    setModal({
      type: "hotkeyMenu",
      title: "open",
      items: [
        {
          key: "p",
          label: "Pull request in browser",
          disabled: !pr,
          onSelect: () => {
            void handleOpenPrInBrowser();
          },
        },
        {
          key: "l",
          label: "Linear issue in browser",
          disabled: !hasLinearIssue,
          onSelect: handleOpenLinearIssue,
        },
        {
          key: "c",
          label: "Cursor",
          disabled: !hasWorktree,
          onSelect: () => {
            void handleOpenCursor();
          },
        },
        {
          key: "t",
          label: "Tower",
          disabled: !hasWorktree,
          onSelect: () => {
            void handleOpenTower();
          },
        },
      ],
    });
  };

  const openGitMenu = async () => {
    const hasWorktree = !!activeTask?.worktree_path;
    const gitStatus = activeTask ? gitStatuses[activeTask.id] : undefined;
    const pr = gitStatus?.pr ?? null;
    const branch = gitStatus?.branch ?? "";
    const changedFiles = gitStatus?.changedFiles ?? 0;
    const behindMain = gitStatus?.behindMain ?? 0;

    const isNonMainBranch =
      branch !== "main" && branch !== "master" && branch.length > 0;
    let remoteBranchExists = false;
    let aheadRemote = 0;
    let behindRemote = 0;
    if (hasWorktree && isNonMainBranch && activeTask?.worktree_path) {
      try {
        await $`git -C ${activeTask.worktree_path} rev-parse --verify --quiet refs/remotes/origin/${branch}`.text();
        remoteBranchExists = true;
      } catch {}

      if (remoteBranchExists) {
        try {
          const revList =
            await $`git -C ${activeTask.worktree_path} rev-list --left-right --count ${branch}...origin/${branch} 2>/dev/null`.text();
          const parts = revList.trim().split(/\s+/);
          if (parts.length === 2) {
            aheadRemote = parseInt(parts[0], 10) || 0;
            behindRemote = parseInt(parts[1], 10) || 0;
          }
        } catch {}
      }
    }

    const localMatchesRemote =
      remoteBranchExists && aheadRemote === 0 && behindRemote === 0;
    const canCreatePr =
      hasWorktree &&
      !pr &&
      isNonMainBranch &&
      (!remoteBranchExists || localMatchesRemote);
    const canPush =
      hasWorktree &&
      remoteBranchExists &&
      aheadRemote > 0 &&
      behindRemote === 0;
    const canForcePush =
      hasWorktree && remoteBranchExists && aheadRemote > 0 && behindRemote > 0;

    const primaryLabel = canForcePush
      ? "Force push"
      : canPush
        ? "Push"
        : canCreatePr
          ? "Make pull request"
          : "No push/pr action available";
    const primaryDisabled = !(canForcePush || canPush || canCreatePr);

    setModal({
      type: "hotkeyMenu",
      title: "git",
      items: [
        {
          key: "c",
          label: "Commit files",
          disabled: !hasWorktree || changedFiles <= 0,
          onSelect: () => {
            void handleGenerateCommit();
          },
        },
        {
          key: "p",
          label: primaryLabel,
          disabled: primaryDisabled,
          onSelect: () => {
            if (canForcePush) {
              void handlePush(true);
              return;
            }
            if (canPush) {
              void handlePush(false);
              return;
            }
            if (canCreatePr) {
              setView("createPr");
            }
          },
        },
        {
          key: "r",
          label: "Ask LLM to rebase",
          disabled: !hasWorktree || !activeTask?.model || behindMain <= 0,
          onSelect: () => {
            void handleRebase();
          },
        },
      ],
    });
  };

  const openConsoleModelMenu = () => {
    setModal({
      type: "hotkeyMenu",
      title: "console",
      items: [
        {
          key: "l",
          label: "New Claude session",
          onSelect: () => selectModel("claude"),
        },
        {
          key: "o",
          label: "New Codex session",
          onSelect: () => selectModel("codex"),
        },
      ],
    });
  };

  useInput((input, key) => {
    if (modal) return;

    // When a pane is focused, only Esc unfocuses
    if (focusPane !== "none") {
      if (key.escape) {
        setFocusPane("none");
        escCooldownRef.current = Date.now();
      }
      return;
    }

    // Copy mode: Esc or y exits copy mode (before any other handling)
    if (copyMode) {
      if (key.escape || input === "y") {
        setCopyMode(false);
      }
      return;
    }

    // Esc when nothing is focused → go back to task list
    // Guard: double-check store directly in case React subscription is stale
    // (EmbeddedTerminal's raw stdin handler may have already set focusPane to "none"
    //  before useInput fires, so we also check lastUnfocusTime)
    if (key.escape) {
      if (useStore.getState().focusPane !== "none") return;
      if (Date.now() - escCooldownRef.current < 150) return;
      if (Date.now() - lastUnfocusRef.current < 150) return;
      setView("tasks");
      return;
    }

    // Pane focus keys
    if (input === "i" && !key.super) {
      setFocusPane("notes");
      return;
    }

    if (input === "t" && !key.super) {
      setFocusPane("terminal");
      return;
    }

    if (input === "c" && !key.super) {
      if (!activeTask) return;
      if (!activeTask.model) {
        openConsoleModelMenu();
        return;
      }
      resetDeadConsoleSession();
      setFocusPane("console");
      markConsoleInteracted(activeTask.id);
      return;
    }

    if (input === "o" && !key.super) {
      openOpenMenu();
      return;
    }

    if (input === "g" && !key.super) {
      void openGitMenu();
      return;
    }

    // Refresh git + PR status and reset polling
    if (input === "r" && !key.super) {
      const taskId = activeTask?.id;
      const worktreePath = activeTask?.worktree_path;
      setActionError("");
      setBusyLabel("Fetching");
      setFetching(true);
      if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
      if (prIntervalRef.current) clearInterval(prIntervalRef.current);
      // Force-refresh global task statuses and git/PR status cache so every
      // view reads the same up-to-date source of truth immediately.
      Promise.resolve()
        .then(async () => {
          if (worktreePath) {
            await fetchLatestMain(worktreePath);
          }
        })
        .then(() => refreshAllTaskStatuses({ forcePrRefresh: true }))
        .finally(() => {
          setFetching(false);
          gitIntervalRef.current = setInterval(pollGit, 5000);
          // Only restart PR polling if checks are still pending
          if (taskId) {
            const pr = useStore.getState().gitStatuses[taskId]?.pr;
            if (!pr || pr.ciPending > 0) {
              prIntervalRef.current = setInterval(pollPr, 30000);
            }
          }
        });
      return;
    }

    // Close task
    if (input === "x" && !key.super && activeTask) {
      setModal({
        type: "confirm",
        message: `Close task '${activeTask.label}'? This will delete the worktree.`,
        onConfirm: () => handleCloseTask(),
      });
      return;
    }

    // View PR comments
    if (input === "v" && !key.super && activeTask?.worktree_path) {
      setView("prComments");
      return;
    }

    // Squash merge PR
    if (input === "s" && !key.super && activeTask?.worktree_path) {
      const pr = gitStatuses[activeTask.id]?.pr;
      if (
        pr &&
        pr.state === "open" &&
        !pr.hasConflicts &&
        pr.ciFailed === 0 &&
        pr.ciPending === 0 &&
        pr.unresolvedThreads === 0
      ) {
        setModal({
          type: "confirm",
          message: `Squash and merge PR #${pr.number}?`,
          onConfirm: () => handleSquashMerge(pr.number),
        });
      }
      return;
    }

    // Copy mode toggle
    if (input === "y" && !key.super) {
      setCopyMode(true);
      return;
    }
  });

  const handleSquashMerge = async (prNumber: number) => {
    if (!activeTask?.worktree_path) return;
    setModal(null);
    setFetching(true);
    try {
      const remoteUrl = (
        await $`git -C ${activeTask.worktree_path} remote get-url origin`.text()
      ).trim();
      await $`gh pr merge ${prNumber} --squash --repo ${remoteUrl}`;
      // Refresh PR status to show merged
      await pollPr();
    } catch {}
    setFetching(false);
  };

  const handleOpenPrInBrowser = async () => {
    if (!activeTask?.worktree_path) return;
    const pr = gitStatuses[activeTask.id]?.pr;
    if (!pr) return;
    try {
      const remoteUrl = (
        await $`git -C ${activeTask.worktree_path} remote get-url origin`.text()
      ).trim();
      const prJson =
        await $`gh pr view ${pr.number} --repo ${remoteUrl} --json url`.text();
      const { url } = JSON.parse(prJson) as { url?: string };
      if (url) {
        Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
      }
    } catch {}
  };

  const handleOpenTower = async () => {
    if (!activeTask?.worktree_path) return;
    try {
      const repoRoot = (
        await $`git -C ${activeTask.worktree_path} rev-parse --show-toplevel`.text()
      ).trim();
      if (repoRoot) {
        Bun.spawn(["gittower", repoRoot], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      }
    } catch {}
  };

  const handleOpenCursor = async () => {
    if (!activeTask?.worktree_path) return;
    try {
      Bun.spawn(["cursor", "."], {
        cwd: activeTask.worktree_path,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {}
  };

  const handleRebase = async () => {
    if (!activeTask?.worktree_path) return;
    const sessionName = `gladius-${activeTask.id}-console`;
    const prompt =
      "Please rebase this branch onto main and resolve any conflicts. Run: git fetch origin main && git rebase origin/main. If there are conflicts, resolve them and continue the rebase.";
    try {
      await $`tmux -L gladius send-keys -t ${sessionName} ${prompt} Enter`;
    } catch {}
  };

  const handleGenerateCommit = async () => {
    if (!activeTask?.worktree_path) return;

    const repoPath = activeTask.worktree_path;
    setActionError("");
    setBusyLabel("Committing");
    setFetching(true);

    try {
      const apiKey = getAppState("settings.openai_api_key");
      if (!apiKey) {
        setActionError(
          "OpenAI API key not set. Press 's' in Repo Selection to open Settings.",
        );
        return;
      }

      const status = await getGitStatus(repoPath);
      if (status.changedFiles <= 0) {
        setActionError("No uncommitted files.");
        return;
      }

      const [stagedDiff, unstagedDiff, untrackedNameOnly] = await Promise.all([
        $`git -C ${repoPath} diff --cached --`.text(),
        $`git -C ${repoPath} diff --`.text(),
        $`git -C ${repoPath} ls-files --others --exclude-standard`.text(),
      ]);

      const diffSections: string[] = [];
      if (stagedDiff.trim()) {
        diffSections.push(
          `### Staged diff (HEAD..index)\n${stagedDiff.trim()}`,
        );
      }
      if (unstagedDiff.trim()) {
        diffSections.push(
          `### Unstaged diff (index..working tree)\n${unstagedDiff.trim()}`,
        );
      }

      const untrackedFiles = untrackedNameOnly
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (untrackedFiles.length > 0) {
        const patches: string[] = [];
        for (const relPath of untrackedFiles.slice(
          0,
          MAX_UNTRACKED_FILES_IN_PROMPT,
        )) {
          try {
            const patch =
              await $`git -C ${repoPath} diff --no-index -- /dev/null ${relPath}`.text();
            if (patch.trim()) patches.push(patch.trim());
          } catch (e: any) {
            // `git diff --no-index` exits 1 when differences exist; Bun throws
            // on non-zero exit, but stdout still contains the patch we need.
            const patch = e?.stdout?.toString?.() || "";
            if (patch.trim()) patches.push(patch.trim());
          }
        }
        if (patches.length > 0) {
          diffSections.push(
            `### Untracked file patches\n${patches.join("\n\n")}`,
          );
        }
        if (untrackedFiles.length > MAX_UNTRACKED_FILES_IN_PROMPT) {
          diffSections.push(
            `[omitted ${untrackedFiles.length - MAX_UNTRACKED_FILES_IN_PROMPT} additional untracked files]`,
          );
        }
      }

      const combinedDiff = diffSections.join("\n\n");
      if (!combinedDiff.trim()) {
        setActionError("No commit content found.");
        return;
      }
      const boundedDiff =
        combinedDiff.length > MAX_DIFF_CHARS
          ? `${combinedDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`
          : combinedDiff;

      const recentPrompts = getRecentTaskPrompts(activeTask, 300);
      const promptLines: string[] = [];
      let promptChars = 0;
      for (let i = recentPrompts.length - 1; i >= 0; i--) {
        const prompt = recentPrompts[i];
        const line = `[${prompt.source} ${prompt.timestamp || "unknown"}] ${prompt.text}`;
        if (promptChars + line.length > MAX_PROMPTS_CHARS) break;
        promptLines.unshift(line);
        promptChars += line.length;
      }

      const description = (activeTask.description || "").trim();
      const boundedDescription =
        description.length > MAX_DESCRIPTION_CHARS
          ? description.slice(0, MAX_DESCRIPTION_CHARS)
          : description;

      const commitMsg = await generateCommitMessage(
        apiKey,
        boundedDescription,
        promptLines.join("\n"),
        boundedDiff,
      );

      await $`git -C ${repoPath} add -A --`.text();
      await $`git -C ${repoPath} commit -m ${commitMsg}`.text();
      const [commitSha, branch] = await Promise.all([
        $`git -C ${repoPath} rev-parse --short HEAD`.text(),
        $`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.text(),
      ]);
      addTaskEvent(activeTask.id, "commit", {
        action: "commit",
        source: "gc",
        model: COMMIT_MESSAGE_MODEL,
        message: commitMsg,
        commit_sha: commitSha.trim() || null,
        branch: branch.trim() || null,
        task_label: activeTask.label,
        generated_at: new Date().toISOString(),
      });
      await pollGit();
      await pollPr(true);
    } catch (e: any) {
      const stderr = e?.stderr?.toString?.()?.trim?.();
      setActionError(stderr || e?.message || "Auto-commit failed");
    } finally {
      setFetching(false);
      setBusyLabel("Fetching");
    }
  };

  const handleCloseTask = () => {
    if (!activeTask || !activeRepo) return;
    // Mark as closing immediately and navigate away
    const closingTask = { ...activeTask, status: "closing" as const };
    setTasks(
      useStore
        .getState()
        .tasks.map((t) => (t.id === activeTask.id ? closingTask : t)),
    );
    setActiveTask(null);
    setModal(null);
    setView("tasks");

    // Run slow cleanup in background
    (async () => {
      destroySession(`${activeTask.id}-terminal`);
      destroySession(`${activeTask.id}-console`);
      if (activeTask.worktree_path) {
        await deleteWorktree(
          activeRepo.path,
          activeTask.worktree_path,
          activeTask.branch_name,
        );
      }
      dbCloseTask(activeTask.id);
      useStore.getState().setTasks(getTasksForRepo(activeRepo.id));
    })();
  };

  if (!activeTask) return null;

  const gitStatus = gitStatuses[activeTask.id];
  const isEvenWithTracking =
    !!gitStatus &&
    gitStatus.hasTrackingBranch &&
    gitStatus.ahead === 0 &&
    gitStatus.behind === 0 &&
    !gitStatus.tracksMain;

  // Aggregate status dots for ALL tasks (including active)
  const allDots = { green: 0, red: 0, orange: 0, yellow: 0, purple: 0 };
  for (const [, color] of Object.entries(taskStatuses)) {
    if (color === "green") allDots.green++;
    else if (color === "red") allDots.red++;
    else if (color === "orange") allDots.orange++;
    else if (color === "yellow") allDots.yellow++;
    else if (color === "purple") allDots.purple++;
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text dimColor>
            {activeRepo ? `${activeRepo.name}/` : `${activeTask.label}`}
          </Text>
          {copyMode && (
            <Text bold color="yellow">
              {" "}
              COPY MODE
            </Text>
          )}
          {fetching ? (
            <Text dimColor> {busyLabel}...</Text>
          ) : (
            <>
              {gitStatus && (
                <>
                  <Text color="cyan"> {gitStatus.branch}</Text>
                  {(gitStatus.ahead > 0 ||
                    gitStatus.behind > 0 ||
                    gitStatus.tracksMain ||
                    isEvenWithTracking) && (
                    <Text color="cyan">
                      {" ("}
                      {isEvenWithTracking ? (
                        <Text color="yellow">=</Text>
                      ) : (
                        <>
                          <Text color="yellow">+{gitStatus.ahead}</Text>/
                          {!gitStatus.tracksMain && (
                            <Text color="yellow">-{gitStatus.behind}</Text>
                          )}
                          {gitStatus.tracksMain && <Text color="white">m</Text>}
                        </>
                      )}
                      {")"}
                    </Text>
                  )}
                  {gitStatus.behindMain > 0 && (
                    <Text color="cyan"> [-{gitStatus.behindMain}]</Text>
                  )}
                  {gitStatus.changedFiles > 0 && (
                    <Text color="yellow">
                      {" "}
                      {gitStatus.changedFiles} file
                      {gitStatus.changedFiles !== 1 ? "s" : ""}
                    </Text>
                  )}
                </>
              )}
              {gitStatus?.pr && (
                <Text
                  color={
                    gitStatus.pr.ciPending > 0
                      ? "yellow"
                      : gitStatus.pr.hasConflicts ||
                          gitStatus.pr.ciFailed > 0 ||
                          gitStatus.pr.unresolvedThreads > 0
                        ? "red"
                        : gitStatus.pr.state === "merged"
                          ? "magenta"
                          : "green"
                  }
                >
                  {" "}
                  {formatPrStatus(gitStatus.pr)}
                </Text>
              )}
            </>
          )}
        </Box>
        <Box gap={1}>
          <StatusDots {...allDots} />
          <Text dimColor color="yellow">
            o: Open g: Git c: Console
          </Text>
        </Box>
      </Box>

      {actionError && (
        <Box marginBottom={1}>
          <Text color="red">{actionError}</Text>
        </Box>
      )}

      {/* Notes Pane (20%) */}
      <NotesPane />

      {/* Status Pane */}
      <TaskStatusPane task={activeTask} />

      {/* Terminal Pane */}
      <TerminalPane
        type="terminal"
        label="Terminal"
        focusKey="t"
        paused={copyMode}
        layout="task"
      />

      {/* Console Pane */}
      <TerminalPane
        type="console"
        label="Console"
        focusKey="c"
        paused={copyMode}
        layout="task"
      />

      {/* Confirm Modal */}
      {modal?.type === "confirm" && (
        <ConfirmModal
          message={modal.message}
          onConfirm={modal.onConfirm}
          onCancel={() => setModal(null)}
        />
      )}
    </Box>
  );
}
