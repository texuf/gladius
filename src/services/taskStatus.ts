import { $ } from "bun";
import { getAllActiveTasks, updateTask } from "./db.js";
import { getGitStatusWithPr } from "./git.js";
import { getRecentTaskConversation } from "./taskPrompt.js";
import { useStore } from "../store/index.js";
import type {
  GitStatus,
  GitWorkStatus,
  LlmActivityStatus,
  PrReadiness,
  Task,
  TaskStatusColor,
} from "../store/types.js";

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

type LlmContext = Pick<
  Task,
  "id" | "model" | "worktree_path" | "claude_session_id" | "codex_session_id"
>;

function toTimestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getGitWorkStatus(gitStatus: GitStatus | null): GitWorkStatus {
  return (gitStatus?.changedFiles ?? 0) > 0 ? "dirty" : "clean";
}

function inferLlmWorkingFromPane(content: string): boolean {
  const recent = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ")
    .toLowerCase();

  if (!recent) return false;
  return (
    recent.includes("running…") ||
    recent.includes("running...") ||
    recent.includes("thinking") ||
    recent.includes("processing")
  );
}

function inferLlmNeedsInputFromPane(content: string): boolean {
  const recent = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-20)
    .join(" ")
    .toLowerCase();

  if (!recent) return false;
  return (
    recent.includes("do you want to proceed?") ||
    (recent.includes("1. yes") && recent.includes("2. no")) ||
    recent.includes("esc to cancel") ||
    recent.includes("tab to amend") ||
    recent.includes("ctrl+e to explain")
  );
}

function inferLlmStatusFromPane(content: string): LlmActivityStatus {
  if (inferLlmNeedsInputFromPane(content)) return "needsInput";
  if (inferLlmWorkingFromPane(content)) return "working";
  return "idle";
}

function toPromptTask(context: LlmContext): Task {
  return {
    id: context.id,
    repo_id: "",
    label: "",
    description: "",
    linear_issue_id: null,
    linear_issue_started_at: null,
    status: "active",
    model: context.model,
    claude_session_id: context.claude_session_id,
    codex_session_id: context.codex_session_id,
    worktree_path: context.worktree_path,
    branch_name: null,
    sort_order: 0,
    created_at: "",
    last_accessed_at: "",
    closed_at: null,
  };
}

async function getLlmActivityStatus(
  task: LlmContext,
): Promise<LlmActivityStatus> {
  if (task.model !== "claude" && task.model !== "codex") return "idle";

  const paneContent = await captureTmuxPane(`gladius-${task.id}-console`);
  const paneStatus = paneContent ? inferLlmStatusFromPane(paneContent) : "idle";
  if (paneStatus === "needsInput") return "needsInput";

  const messages = getRecentTaskConversation(
    toPromptTask(task),
    task.model,
    80,
  );
  if (messages.length > 0) {
    let lastUserMs = 0;
    let lastAssistantMs = 0;
    for (const msg of messages) {
      const ts = toTimestampMs(msg.timestamp);
      if (msg.role === "user") lastUserMs = Math.max(lastUserMs, ts);
      if (msg.role === "assistant")
        lastAssistantMs = Math.max(lastAssistantMs, ts);
    }
    if (lastUserMs > lastAssistantMs) {
      return paneStatus === "idle" ? "working" : paneStatus;
    }
    return paneStatus === "working" ? "working" : "idle";
  }

  // Fallback for sessions with no parseable message history yet.
  return paneStatus;
}

function resolveCombinedTaskColor(params: {
  prReadiness: PrReadiness;
  gitStatus: GitWorkStatus;
  llmStatus: LlmActivityStatus;
  consoleInteracted: boolean;
  consoleFocused: boolean;
}): TaskStatusColor {
  if (params.llmStatus === "working") return "yellow";
  if (params.llmStatus === "needsInput") return "red";
  if (params.prReadiness === "merged") return "purple";
  if (params.prReadiness === "attentionNeeded") return "red";
  if (params.prReadiness === "ciPending") return "yellow";
  if (params.gitStatus === "dirty") return "orange";
  if (params.prReadiness === "readyToMerge") return "green";
  return "red";
}

/**
 * Compute status color for a single task.
 * Final color is derived from explicit PR/Git/LLM states.
 */
export async function computeTaskStatus(
  taskId: string,
  worktreePath: string | null,
  branchName: string | null,
  model: string | null,
  consoleInteracted: boolean,
  consoleFocused: boolean,
): Promise<TaskStatusColor> {
  const normalizedModel =
    model === "claude" || model === "codex" ? model : null;
  const llmStatus = await getLlmActivityStatus({
    id: taskId,
    model: normalizedModel,
    worktree_path: worktreePath,
    claude_session_id: null,
    codex_session_id: null,
  });
  let gitStatus: GitStatus | null = null;
  if (worktreePath) {
    try {
      gitStatus = await getGitStatusWithPr(worktreePath, undefined);
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
      const llmStatus = await getLlmActivityStatus(task);
      let gitStatus: GitStatus | null = null;

      if (task.worktree_path) {
        try {
          gitStatus = await getGitStatusWithPr(task.worktree_path, undefined, {
            forcePrRefresh: options?.forcePrRefresh === true,
          });
        } catch {
          gitStatus = null;
        }
      }

      if (gitStatus && gitStatus.branch !== task.branch_name) {
        updateTask(task.id, { branch_name: gitStatus.branch });
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

/**
 * Refresh status color for a single task using current store state and optional
 * pre-fetched git status, then update the taskStatuses map in place.
 */
export async function refreshTaskStatus(
  task: Task,
  gitStatusOverride?: GitStatus | null,
): Promise<TaskStatusColor> {
  const state = useStore.getState();
  const llmStatus = await getLlmActivityStatus(task);
  const gitStatus = gitStatusOverride ?? state.gitStatuses[task.id] ?? null;
  const isConsoleFocused =
    state.focusPane === "console" && state.activeTask?.id === task.id;

  const color = resolveTaskStatusColor(
    task.id,
    llmStatus,
    gitStatus,
    state.consoleInteractedTasks.has(task.id),
    isConsoleFocused,
  );

  useStore.setState((prev) => ({
    taskStatuses: { ...prev.taskStatuses, [task.id]: color },
  }));

  return color;
}

function resolveTaskStatusColor(
  taskId: string,
  llmStatus: LlmActivityStatus,
  gitStatus: GitStatus | null,
  consoleInteracted: boolean,
  consoleFocused: boolean,
): TaskStatusColor {
  let interacted = consoleInteracted;
  if (interacted && llmStatus !== "working") {
    useStore.getState().clearConsoleInteracted(taskId);
    interacted = false;
  }

  const prCleared = useStore.getState().clearedPrTasks.has(taskId);
  const pr = gitStatus?.pr;
  let prReadiness: PrReadiness = pr?.readiness ?? "none";
  if (pr?.state === "open" && prCleared) {
    useStore.getState().clearPrCleared(taskId);
  }
  if (prCleared && prReadiness === "merged") {
    prReadiness = "none";
  }

  return resolveCombinedTaskColor({
    prReadiness,
    gitStatus: getGitWorkStatus(gitStatus),
    llmStatus,
    consoleInteracted: interacted,
    consoleFocused,
  });
}
