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
  getRepoSlugForPath,
  pushBranch,
  runGhCommand,
  runGitCommand,
} from "../services/git.js";
import {
  refreshAllTaskStatuses,
  refreshTaskStatus,
} from "../services/taskStatus.js";
import {
  addTaskEvent,
  closeTask as dbCloseTask,
  getAppState,
  getProjectLinearTeam,
  updateTask,
  getTasksForRepo,
} from "../services/db.js";
import { deleteWorktree } from "../services/worktree.js";
import {
  destroySession,
  getSession,
  isSessionDead,
} from "../services/terminalManager.js";
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
  const shouldAutoPoll = activeRepo?.project_backend_kind !== "ssh";
  const [terminalResetVersion, setTerminalResetVersion] = useState(0);
  const [consoleResetVersion, setConsoleResetVersion] = useState(0);

  const markConsoleInteracted = (taskId: string) => {
    useStore.getState().markConsoleInteracted(taskId);
    if (activeTask && activeTask.id === taskId) {
      void refreshTaskStatus(activeTask);
    }
  };

  const resetDeadConsoleSession = () => {
    if (!activeTask?.model) return;
    const sessionKey = `${activeTask.id}-console`;
    if (!isSessionDead(sessionKey)) return;

    destroySession(sessionKey);
    setConsoleResetVersion((value) => value + 1);

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

  const resetDeadTerminalSession = () => {
    if (!activeTask) return;
    const sessionKey = `${activeTask.id}-terminal`;
    if (!isSessionDead(sessionKey)) return;
    destroySession(sessionKey);
    setTerminalResetVersion((value) => value + 1);
  };

  const resetTaskSessions = () => {
    if (!activeTask) return;

    destroySession(`${activeTask.id}-terminal`);
    destroySession(`${activeTask.id}-console`);
    destroySession(activeTask.id);
    setTerminalResetVersion((value) => value + 1);
    setConsoleResetVersion((value) => value + 1);

    const updates = {
      claude_session_id: null,
      codex_session_id: null,
    };
    updateTask(activeTask.id, updates);
    setActiveTask({ ...activeTask, ...updates });
    setTasks(
      useStore
        .getState()
        .tasks.map((t) => (t.id === activeTask.id ? { ...t, ...updates } : t)),
    );
    setFocusPane("none");
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
    if (
      activeTask &&
      prevFocusPaneRef.current === "console" &&
      focusPane === "none"
    ) {
      void refreshTaskStatus(activeTask);
    }
    if (prevFocusPaneRef.current !== "none" && focusPane === "none") {
      lastUnfocusRef.current = Date.now();
    }
    prevFocusPaneRef.current = focusPane;
  }, [activeTask, focusPane]);

  // Poll git status (fast) and PR status (slower, separate)
  const prInFlightRef = useRef(false);

  const pollGit = () => {
    if (!activeTask?.worktree_path) return Promise.resolve();
    return getGitStatus(activeTask.worktree_path).then((status) => {
      const mergedStatus = {
        ...status,
        pr: useStore.getState().gitStatuses[activeTask.id]?.pr ?? null,
      };
      // Merge git fields atomically, preserving whatever PR data exists
      useStore.setState((state) => ({
        gitStatuses: {
          ...state.gitStatuses,
          [activeTask.id]: mergedStatus,
        },
      }));
      return refreshTaskStatus(activeTask, mergedStatus).then(() => {});
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
        void refreshTaskStatus(activeTask, status);
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
    if (!shouldAutoPoll) return;
    if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
    if (prIntervalRef.current) clearInterval(prIntervalRef.current);
    pollGit();
    pollPr();
    gitIntervalRef.current = setInterval(pollGit, 5000);
    prIntervalRef.current = setInterval(pollPr, 30000);
  };

  useEffect(() => {
    if (!activeTask?.worktree_path || !shouldAutoPoll) return;
    startPolling();
    return () => {
      if (gitIntervalRef.current) clearInterval(gitIntervalRef.current);
      if (prIntervalRef.current) clearInterval(prIntervalRef.current);
    };
  }, [activeTask?.id, shouldAutoPoll]);

  // When opening a task, jump directly to console if an LLM session already exists.
  useEffect(() => {
    if (!activeTask) return;
    if (focusPane !== "none") return;
    if (!activeTask.model) return;

    const hasPersistedSession =
      (activeTask.model === "claude" && !!activeTask.claude_session_id) ||
      (activeTask.model === "codex" && !!activeTask.codex_session_id);
    const hasLiveSession = !!getSession(`${activeTask.id}-console`);

    if (hasPersistedSession || hasLiveSession) {
      setFocusPane("console");
      markConsoleInteracted(activeTask.id);
    }
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
    } else if (activeTask?.worktree_path && shouldAutoPoll) {
      startPolling();
    }
  }, [copyMode, shouldAutoPoll]);

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
        await runGitCommand(repoPath, [
          "-C",
          repoPath,
          "push",
          "--force-with-lease",
          "-u",
          "origin",
          branch,
        ]);
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
    const canOpenLocalTools =
      hasWorktree && activeRepo?.project_backend_kind !== "ssh";

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
          disabled: !canOpenLocalTools,
          onSelect: () => {
            void handleOpenCursor();
          },
        },
        {
          key: "t",
          label: "Tower",
          disabled: !canOpenLocalTools,
          onSelect: () => {
            void handleOpenTower();
          },
        },
      ],
    });
  };

  const openGitMenu = async () => {
    const hasWorktree = !!activeTask?.worktree_path;
    const worktreePath = activeTask?.worktree_path;
    const gitStatus = activeTask ? gitStatuses[activeTask.id] : undefined;
    const pr = gitStatus?.pr ?? null;
    const branch = gitStatus?.branch ?? "";
    const changedFiles = gitStatus?.changedFiles ?? 0;
    const behindMain = gitStatus?.behindMain ?? 0;
    const hasOpenPr = pr?.state === "open";

    const isNonMainBranch =
      branch !== "main" && branch !== "master" && branch.length > 0;
    let remoteBranchExists = false;
    let aheadRemote = 0;
    let behindRemote = 0;
    let aheadMain = 0;
    if (hasWorktree && isNonMainBranch && worktreePath) {
      try {
        await runGitCommand(worktreePath, [
          "-C",
          worktreePath,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${branch}`,
        ]);
        remoteBranchExists = true;
      } catch {}

      if (remoteBranchExists) {
        try {
          const revList = await runGitCommand(worktreePath, [
            "-C",
            worktreePath,
            "rev-list",
            "--left-right",
            "--count",
            `${branch}...origin/${branch}`,
          ]);
          const parts = revList.trim().split(/\s+/);
          if (parts.length === 2) {
            aheadRemote = parseInt(parts[0], 10) || 0;
            behindRemote = parseInt(parts[1], 10) || 0;
          }
        } catch {}
      }

      try {
        const aheadMainResult = await runGitCommand(worktreePath, [
          "-C",
          worktreePath,
          "rev-list",
          "--count",
          `origin/main..${branch}`,
        ]);
        aheadMain = parseInt(aheadMainResult.trim(), 10) || 0;
      } catch {
        try {
          const aheadMasterResult = await runGitCommand(worktreePath, [
            "-C",
            worktreePath,
            "rev-list",
            "--count",
            `origin/master..${branch}`,
          ]);
          aheadMain = parseInt(aheadMasterResult.trim(), 10) || 0;
        } catch {}
      }
    }

    const localMatchesRemote =
      remoteBranchExists && aheadRemote === 0 && behindRemote === 0;
    const hasCommitsForPr = aheadMain > 0;
    const canCreatePr =
      hasWorktree &&
      !hasOpenPr &&
      isNonMainBranch &&
      hasCommitsForPr &&
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
      resetDeadTerminalSession();
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

    if (input === "p" && !key.super) {
      setFocusPane("none");
      setView("taskTranscript");
      return;
    }

    if (input === "o" && !key.super) {
      openOpenMenu();
      return;
    }

    if (input === "l" && !key.super) {
      setFocusPane("none");
      setView("taskLazygit");
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
        .then(() =>
          refreshAllTaskStatuses({
            forcePrRefresh: true,
            includeRemote: true,
          }),
        )
        .finally(() => {
          setFetching(false);
          if (!shouldAutoPoll) return;
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

    if (input === "z" && !key.super) {
      resetTaskSessions();
      return;
    }
  });

  const handleSquashMerge = async (prNumber: number) => {
    if (!activeTask?.worktree_path) return;
    setModal(null);
    setFetching(true);
    try {
      const repoSlug = await getRepoSlugForPath(activeTask.worktree_path);
      if (!repoSlug) return;
      await runGhCommand([
        "pr",
        "merge",
        String(prNumber),
        "--squash",
        "--repo",
        repoSlug,
      ]);
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
      const repoSlug = await getRepoSlugForPath(activeTask.worktree_path);
      if (!repoSlug) return;
      const prJson = await runGhCommand([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoSlug,
        "--json",
        "url",
      ]);
      const { url } = JSON.parse(prJson) as { url?: string };
      if (url) {
        Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
      }
    } catch {}
  };

  const handleOpenTower = async () => {
    if (!activeTask?.worktree_path) return;
    if (activeRepo?.project_backend_kind === "ssh") return;
    try {
      const repoRoot = (
        await runGitCommand(activeTask.worktree_path, [
          "-C",
          activeTask.worktree_path,
          "rev-parse",
          "--show-toplevel",
        ])
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
    if (activeRepo?.project_backend_kind === "ssh") return;
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
        runGitCommand(repoPath, ["-C", repoPath, "diff", "--cached", "--"]),
        runGitCommand(repoPath, ["-C", repoPath, "diff", "--"]),
        runGitCommand(repoPath, [
          "-C",
          repoPath,
          "ls-files",
          "--others",
          "--exclude-standard",
        ]),
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
            const patch = await runGitCommand(repoPath, [
              "-C",
              repoPath,
              "diff",
              "--no-index",
              "--",
              "/dev/null",
              relPath,
            ]);
            if (patch.trim()) patches.push(patch.trim());
          } catch (e: any) {
            // `git diff --no-index` exits 1 when differences exist, but stdout
            // still contains the patch we need.
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

      await runGitCommand(repoPath, ["-C", repoPath, "add", "-A", "--"]);
      await runGitCommand(repoPath, [
        "-C",
        repoPath,
        "commit",
        "-m",
        commitMsg,
      ]);
      const [commitSha, branch] = await Promise.all([
        runGitCommand(repoPath, [
          "-C",
          repoPath,
          "rev-parse",
          "--short",
          "HEAD",
        ]),
        runGitCommand(repoPath, [
          "-C",
          repoPath,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]),
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
          activeRepo,
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
  const prTaskColor = gitStatus?.pr?.statusColor ?? "none";
  const isEvenWithTracking =
    !!gitStatus &&
    gitStatus.hasTrackingBranch &&
    gitStatus.ahead === 0 &&
    gitStatus.behind === 0 &&
    !gitStatus.tracksMain;

  // Aggregate status dots for ALL tasks (including active)
  const allDots = {
    green: 0,
    red: 0,
    orange: 0,
    yellow: 0,
    purple: 0,
    gray: 0,
  };
  for (const [, color] of Object.entries(taskStatuses)) {
    if (color === "green") allDots.green++;
    else if (color === "red") allDots.red++;
    else if (color === "orange") allDots.orange++;
    else if (color === "yellow") allDots.yellow++;
    else if (color === "purple") allDots.purple++;
    else if (color === "gray") allDots.gray++;
  }

  const taskHelpLines = [
    [
      "i Notes",
      "t Terminal",
      activeTask.model ? "c Console" : "c Console (choose model)",
    ],
    ["p Transcript", "o Open menu", "g Git menu", "l LazyGit"],
    ["r Refresh", "y Copy mode", "z Reset panes"],
    ["Esc Back", "x Close task"],
  ];

  if (prTaskColor === "red" || prTaskColor === "yellow") {
    taskHelpLines[3] = [...taskHelpLines[3], "v PR issues"];
  }
  if (prTaskColor === "green") {
    taskHelpLines[3] = [...taskHelpLines[3], "s Squash merge"];
  }

  const showIdleHelp = focusPane === "none" && !copyMode && !modal;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1} width="100%">
        <Box flexGrow={1} flexShrink={1} marginRight={1}>
          <Text wrap="truncate-end">
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
                            {gitStatus.tracksMain && (
                              <Text color="white">m</Text>
                            )}
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
                      prTaskColor === "purple"
                        ? "magenta"
                        : prTaskColor === "none"
                          ? "white"
                          : prTaskColor
                    }
                  >
                    {" "}
                    {formatPrStatus(gitStatus.pr)}
                  </Text>
                )}
              </>
            )}
          </Text>
        </Box>
        <Box gap={1} flexShrink={0}>
          <StatusDots {...allDots} />
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
        sessionResetVersion={terminalResetVersion}
      />

      {/* Console Pane */}
      <TerminalPane
        type="console"
        label="Console"
        focusKey="c"
        paused={copyMode}
        layout="task"
        sessionResetVersion={consoleResetVersion}
      />

      {showIdleHelp && (
        <Box
          position="absolute"
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
          pointerEvents="none"
        >
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="yellow"
            paddingX={2}
            paddingY={1}
            backgroundColor="black"
          >
            <Text bold color="yellow">
              Task Shortcuts
            </Text>
            <Box flexDirection="column" marginTop={1}>
              {taskHelpLines.map((line, index) => (
                <Text key={`task-help-${index}`}>{line.join("   ")}</Text>
              ))}
            </Box>
          </Box>
        </Box>
      )}

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
