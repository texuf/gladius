import { $ } from "bun";
import { getAllActiveTasks } from "./db.js";
import { getGitStatusWithPr } from "./git.js";
import type { TaskStatusColor } from "../store/types.js";

const TMUX_SOCKET = "gladius";

/**
 * Check if a tmux session exists and capture its pane content.
 */
async function captureTmuxPane(sessionName: string): Promise<string | null> {
  try {
    const content = await $`tmux -L ${TMUX_SOCKET} capture-pane -t ${sessionName} -p`.text();
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
 * Priority: orange (LLM working) > red (needs attention) > green (PR green) > none
 */
export async function computeTaskStatus(
  taskId: string,
  worktreePath: string | null,
  branchName: string | null,
  model: string | null
): Promise<TaskStatusColor> {
  // Check LLM status if model is set
  let llmStatus: "orange" | "red" | null = null;
  if (model) {
    llmStatus = await getLlmStatus(taskId);
  }

  if (llmStatus === "orange") return "orange";

  // Check PR status
  if (worktreePath) {
    try {
      const gitStatus = await getGitStatusWithPr(worktreePath, branchName || undefined);
      if (gitStatus.pr) {
        if (gitStatus.pr.unresolvedThreads > 0 || gitStatus.pr.ciFailed > 0) return "red";
        if (gitStatus.pr.state === "open" && gitStatus.pr.ciFailed === 0 && gitStatus.pr.unresolvedThreads === 0) return "green";
      }
    } catch {}
  }

  if (llmStatus === "red") return "red";

  return "none";
}

/**
 * Compute statuses for all active tasks.
 */
export async function computeAllTaskStatuses(): Promise<Record<string, TaskStatusColor>> {
  const tasks = getAllActiveTasks();
  const results: Record<string, TaskStatusColor> = {};

  await Promise.all(
    tasks.map(async (task) => {
      results[task.id] = await computeTaskStatus(
        task.id,
        task.worktree_path,
        task.branch_name,
        task.model
      );
    })
  );

  return results;
}
