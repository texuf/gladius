import { $ } from "bun";
import { getAllActiveTasks } from "./db.js";
import { getGitStatusWithPr } from "./git.js";
import { useStore } from "../store/index.js";
import type { GitStatus, TaskStatusColor } from "../store/types.js";

const TMUX_SOCKET = "gladius";

/**
 * Check if a tmux session exists and capture its pane content.
 */
async function captureTmuxPane(sessionName: string): Promise<string | null> {
  try {
    const content =
      await $`tmux -L ${TMUX_SOCKET} capture-pane -t ${sessionName} -p`.text();
    return content;
  } catch {
    return null;
  }
}

/**
 * Determine LLM status for a task by checking its console tmux session.
 * - "esc to interrupt" present → orange (working)
 * - Session alive but no indicator → red (needs input)
 * - No session → null (no LLM running)
 */
async function getLlmStatus(taskId: string): Promise<"orange" | "red" | null> {
  const sessionName = `gladius-${taskId}-console`;
  const content = await captureTmuxPane(sessionName);
  if (content === null) return null;

  if (content.includes("esc to interrupt")) {
    return "orange";
  }
  return "red";
}

/**
 * Compute status color for a single task.
 * Priority: yellow (user interacting / LLM processing after input) >
 *           orange (LLM working) > red (needs attention) > green (PR green) > none
 *
 * consoleInteracted = user recently focused the console for this task.
 * While interacted: orange (LLM working) → yellow (user just gave input, LLM processing).
 * When LLM becomes idle (red) → clear the flag, show red.
 */
export async function computeTaskStatus(
  taskId: string,
  worktreePath: string | null,
  branchName: string | null,
  model: string | null,
  consoleInteracted: boolean,
  consoleFocused: boolean,
): Promise<TaskStatusColor> {
  const llmStatus = model ? await getLlmStatus(taskId) : null;
  let gitStatus: GitStatus | null = null;
  if (worktreePath) {
    try {
      gitStatus = await getGitStatusWithPr(
        worktreePath,
        branchName || undefined,
      );
    } catch {
      gitStatus = null;
    }
  }
  return resolveTaskStatusColor(
    taskId,
    llmStatus,
    gitStatus,
    consoleInteracted,
    consoleFocused,
  );
}

/**
 * Compute statuses for all active tasks.
 */
export async function computeAllTaskStatuses(): Promise<
  Record<string, TaskStatusColor>
> {
  return refreshAllTaskStatuses();
}

/**
 * Refresh all active tasks from a single status pipeline:
 * - fetch git+PR status
 * - compute task color
 * - update store gitStatuses and taskStatuses together
 */
export async function refreshAllTaskStatuses(options?: {
  forcePrRefresh?: boolean;
}): Promise<Record<string, TaskStatusColor>> {
  const tasks = getAllActiveTasks();
  const state = useStore.getState();
  const interacted = state.consoleInteractedTasks;
  const focusedTaskId =
    state.focusPane === "console" ? state.activeTask?.id : null;
  const taskStatuses: Record<string, TaskStatusColor> = {};
  const gitStatuses: Record<string, GitStatus> = {};

  await Promise.all(
    tasks.map(async (task) => {
      const llmStatus = task.model ? await getLlmStatus(task.id) : null;
      let gitStatus: GitStatus | null = null;

      if (task.worktree_path) {
        try {
          gitStatus = await getGitStatusWithPr(
            task.worktree_path,
            task.branch_name || undefined,
            { forcePrRefresh: options?.forcePrRefresh === true },
          );
        } catch {
          gitStatus = null;
        }
      }

      if (gitStatus) {
        gitStatuses[task.id] = gitStatus;
      }

      taskStatuses[task.id] = resolveTaskStatusColor(
        task.id,
        llmStatus,
        gitStatus,
        interacted.has(task.id),
        task.id === focusedTaskId,
      );
    }),
  );

  useStore.setState((prev) => ({
    gitStatuses: { ...prev.gitStatuses, ...gitStatuses },
    taskStatuses,
  }));

  return taskStatuses;
}

function resolveTaskStatusColor(
  taskId: string,
  llmStatus: "orange" | "red" | null,
  gitStatus: GitStatus | null,
  consoleInteracted: boolean,
  consoleFocused: boolean,
): TaskStatusColor {
  if (consoleFocused) return "yellow";

  if (consoleInteracted) {
    if (llmStatus === "orange") return "yellow";
    useStore.getState().clearConsoleInteracted(taskId);
  }

  if (llmStatus === "orange") return "orange";

  const pr = gitStatus?.pr;
  if (pr) {
    if (pr.hasConflicts || pr.unresolvedThreads > 0 || pr.ciFailed > 0) {
      return "red";
    }
    if (pr.ciPending > 0) return "yellow";
    if (
      pr.state === "open" &&
      !pr.hasConflicts &&
      pr.ciFailed === 0 &&
      pr.unresolvedThreads === 0
    ) {
      return "green";
    }
  }

  if (llmStatus === "red") return "red";
  return "none";
}
