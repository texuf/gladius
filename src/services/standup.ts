import {
  getAppState,
  setAppState,
  getTasksActiveDuringWindow,
  getTaskEventsSince,
} from "./db.js";
import { getCommitsSince, formatPrStatus } from "./git.js";
import { generateStandupSummary } from "./llm.js";
import { useStore } from "../store/index.js";
import type { TaskEvent, PrStatus } from "../store/types.js";

export interface StandupTaskData {
  taskLabel: string;
  taskDescription: string;
  taskStatus: string;
  branchName: string | null;
  commits: string;
  prStatus: string | null;
  events: TaskEvent[];
  createdAt: string;
  closedAt: string | null;
}

export interface StandupGroupData {
  groupName: string;
  projectName: string;
  tasks: StandupTaskData[];
}

export function getStandupWindowStart(): string {
  const saved = getAppState("standup.last_generated_at");
  if (saved) return saved;
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export async function gatherStandupData(): Promise<StandupGroupData[]> {
  const sinceISO = getStandupWindowStart();
  const tasks = getTasksActiveDuringWindow(sinceISO);
  const gitStatuses = useStore.getState().gitStatuses;

  const groupMap = new Map<string, StandupGroupData>();

  for (const task of tasks) {
    const commits = task.worktree_path
      ? await getCommitsSince(task.worktree_path, sinceISO)
      : "";

    const pr: PrStatus | null = gitStatuses[task.id]?.pr ?? null;
    const prStatusStr = pr ? formatPrStatus(pr) : null;
    const events = getTaskEventsSince(task.id, sinceISO);

    const taskData: StandupTaskData = {
      taskLabel: task.label,
      taskDescription: task.description,
      taskStatus: task.status,
      branchName: task.branch_name,
      commits,
      prStatus: prStatusStr,
      events,
      createdAt: task.created_at,
      closedAt: task.closed_at,
    };

    const key = `${task.group_name}::${task.project_name}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        groupName: task.group_name,
        projectName: task.project_name,
        tasks: [],
      });
    }
    groupMap.get(key)!.tasks.push(taskData);
  }

  return Array.from(groupMap.values());
}

export function buildStandupPrompt(data: StandupGroupData[]): string {
  const sinceISO = getStandupWindowStart();
  let prompt = `Rules:
- One sentence per task that was open during the time window.
- For tasks with commits, summarize what was committed.
- For tasks without commits, describe what is being worked on and its current state.
- If a PR exists, mention its status briefly.
- If a task was closed, note that.
- Group output by project group using the group name as a header.
- No emojis. Brief and professional. Plain text, not markdown.

Task data:
Time window: ${sinceISO} to now
`;

  for (const group of data) {
    prompt += `\n=== ${group.groupName} (${group.projectName}) ===\n`;
    for (const task of group.tasks) {
      prompt += `Task: ${task.taskLabel}\n`;
      if (task.taskDescription) {
        prompt += `Description: ${task.taskDescription}\n`;
      }
      prompt += `Status: ${task.taskStatus}\n`;
      if (task.branchName) {
        prompt += `Branch: ${task.branchName}\n`;
      }
      prompt += `Commits: ${task.commits || "none"}\n`;
      if (task.prStatus) {
        prompt += `PR: ${task.prStatus}\n`;
      }
      if (task.events.length > 0) {
        const eventStr = task.events
          .map((e) => `${e.event_type} at ${e.created_at}`)
          .join(", ");
        prompt += `Events: ${eventStr}\n`;
      }
      prompt += "\n";
    }
  }

  return prompt;
}

export async function generateStandup(apiKey: string): Promise<string> {
  const data = await gatherStandupData();

  if (data.length === 0) {
    return "No task activity found in the current time window.";
  }

  const prompt = buildStandupPrompt(data);
  const summary = await generateStandupSummary(apiKey, prompt);

  const now = new Date().toISOString();
  setAppState("standup.last_generated_at", now);
  setAppState("standup.last_summary", summary);

  return summary;
}
