import { $ } from "bun";
import {
  getAppState,
  setAppState,
  getTasksActiveDuringWindow,
  getTaskEventsSince,
} from "./db.js";
import {
  getCommitsSince,
  getCommitsSinceOnBranch,
  getMergedPrsSince,
  getPrsCreatedSince,
  getMainBranch,
  formatPrStatus,
} from "./git.js";
import type { MergedPr, OpenedPr } from "./git.js";
import { generateStandupSummary } from "./llm.js";
import { useStore } from "../store/index.js";
import type { PrStatus, TaskEvent } from "../store/types.js";

const MAX_COMMIT_EVENTS_PER_TASK = 8;
const MAX_COMMIT_MESSAGE_CHARS = 1_500;
const MAX_PR_BODY_CHARS = 500;

interface CommitEventMetadata {
  action?: string;
  source?: string;
  model?: string;
  message?: string;
  commit_sha?: string | null;
  branch?: string | null;
  generated_at?: string;
}

export interface StandupCommitEvent {
  action: string;
  source: string | null;
  model: string | null;
  message: string;
  commitSha: string | null;
  branch: string | null;
  createdAt: string;
}

export interface StandupTaskData {
  taskId: string; // internal short id (legacy "label")
  taskDescription: string; // human-readable task label (legacy "description")
  taskStatus: string;
  branchName: string | null;
  branchCommits: string;
  commitEvents: StandupCommitEvent[];
  prTitle: string | null;
  prBody: string | null;
  prState: OpenedPr["state"] | null;
  prStatus: string | null;
}

export interface StandupRepoData {
  projectName: string;
  repoName: string;
  repoPath: string;
  mainCommits: string;
  authoredCommits: string;
  openedPrs: OpenedPr[];
  mergedPrs: MergedPr[];
  tasks: StandupTaskData[];
}

export interface StandupProjectData {
  projectName: string;
  repos: StandupRepoData[];
}

export function getStandupWindowStart(): string {
  const saved = getAppState("standup.last_generated_at");
  if (!saved) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const savedMs = Date.parse(saved);
  if (!Number.isFinite(savedMs)) {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(savedMs).toISOString();
}

function getStandupWindowDays(sinceISO: string): number {
  const sinceMs = Date.parse(sinceISO);
  if (!Number.isFinite(sinceMs)) return 1;
  const deltaMs = Math.max(0, Date.now() - sinceMs);
  return Math.max(1, Math.ceil(deltaMs / (24 * 60 * 60 * 1000)));
}

function parseTaskEventMetadata(raw: string | null): CommitEventMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as CommitEventMetadata;
  } catch {
    return null;
  }
}

function toStandupCommitEvent(event: TaskEvent): StandupCommitEvent | null {
  const metadata = parseTaskEventMetadata(event.metadata);
  const action = String(metadata?.action || "").toLowerCase();
  const isCommitEvent = event.event_type === "commit" || action === "commit";
  if (!isCommitEvent) return null;

  const message = String(metadata?.message || "").trim();
  if (!message) return null;

  return {
    action: "commit",
    source: metadata?.source ? String(metadata.source) : null,
    model: metadata?.model ? String(metadata.model) : null,
    message:
      message.length > MAX_COMMIT_MESSAGE_CHARS
        ? `${message.slice(0, MAX_COMMIT_MESSAGE_CHARS)}...`
        : message,
    commitSha:
      metadata?.commit_sha !== undefined && metadata?.commit_sha !== null
        ? String(metadata.commit_sha)
        : null,
    branch:
      metadata?.branch !== undefined && metadata?.branch !== null
        ? String(metadata.branch)
        : null,
    createdAt: event.created_at,
  };
}

async function getRepoAuthorFilter(repoPath: string): Promise<string | null> {
  try {
    const email = (await $`git -C ${repoPath} config user.email`.text()).trim();
    if (email) return email;
  } catch {
    // ignore
  }
  try {
    const name = (await $`git -C ${repoPath} config user.name`.text()).trim();
    if (name) return name;
  } catch {
    // ignore
  }
  return null;
}

function groupReposByProject(repos: StandupRepoData[]): StandupProjectData[] {
  const byProject = new Map<string, StandupProjectData>();

  for (const repo of repos) {
    if (!byProject.has(repo.projectName)) {
      byProject.set(repo.projectName, {
        projectName: repo.projectName,
        repos: [],
      });
    }
    byProject.get(repo.projectName)!.repos.push(repo);
  }

  const projects = Array.from(byProject.values()).sort((a, b) =>
    a.projectName.localeCompare(b.projectName),
  );

  for (const project of projects) {
    project.repos.sort((a, b) => a.repoName.localeCompare(b.repoName));
  }

  return projects;
}

export async function gatherStandupData(): Promise<StandupProjectData[]> {
  const sinceISO = getStandupWindowStart();
  const tasks = getTasksActiveDuringWindow(sinceISO);
  const gitStatuses = useStore.getState().gitStatuses;

  const repoMap = new Map<
    string,
    {
      projectName: string;
      repoName: string;
      repoPath: string;
      tasks: typeof tasks;
    }
  >();

  for (const task of tasks) {
    const key = `${task.project_name}::${task.repo_name}`;
    if (!repoMap.has(key)) {
      repoMap.set(key, {
        projectName: task.project_name,
        repoName: task.repo_name,
        repoPath: task.repo_path,
        tasks: [],
      });
    }
    repoMap.get(key)!.tasks.push(task);
  }

  const repoData = await Promise.all(
    Array.from(repoMap.values()).map(async (repo) => {
      const [mainBranch, authorFilter] = await Promise.all([
        getMainBranch(repo.repoPath),
        getRepoAuthorFilter(repo.repoPath),
      ]);

      const [mainCommits, authoredCommits, mergedPrs, openedPrs] =
        await Promise.all([
          getCommitsSinceOnBranch(repo.repoPath, mainBranch, sinceISO),
          getCommitsSince(
            repo.repoPath,
            sinceISO,
            authorFilter ? { author: authorFilter } : undefined,
          ),
          getMergedPrsSince(repo.repoPath, sinceISO, { author: "@me" }),
          getPrsCreatedSince(repo.repoPath, sinceISO, { author: "@me" }),
        ]);

      const prByBranch = new Map<string, OpenedPr>();
      for (const pr of openedPrs) {
        if (!pr.headRefName) continue;
        const existing = prByBranch.get(pr.headRefName);
        const prCreatedAtMs = Date.parse(pr.createdAt || "") || 0;
        const existingCreatedAtMs = existing
          ? Date.parse(existing.createdAt || "") || 0
          : 0;
        if (!existing || prCreatedAtMs >= existingCreatedAtMs) {
          prByBranch.set(pr.headRefName, pr);
        }
      }

      const taskDataList = await Promise.all(
        repo.tasks.map(async (task) => {
          const branchCommits = task.branch_name
            ? await getCommitsSinceOnBranch(
                repo.repoPath,
                task.branch_name,
                sinceISO,
              )
            : "";

          const matchedPr = task.branch_name
            ? prByBranch.get(task.branch_name) ?? null
            : null;

          const cachedPr: PrStatus | null = gitStatuses[task.id]?.pr ?? null;
          const prStatusStr = cachedPr ? formatPrStatus(cachedPr) : null;
          const commitEvents = getTaskEventsSince(task.id, sinceISO)
            .map((event) => toStandupCommitEvent(event))
            .filter((event): event is StandupCommitEvent => event !== null)
            .slice(-MAX_COMMIT_EVENTS_PER_TASK);

          return {
            taskId: task.label,
            taskDescription: task.description,
            taskStatus: task.status,
            branchName: task.branch_name,
            branchCommits,
            commitEvents,
            prTitle: matchedPr?.title ?? null,
            prBody: matchedPr?.body ?? null,
            prState: matchedPr?.state ?? null,
            prStatus: prStatusStr,
          } satisfies StandupTaskData;
        }),
      );

      return {
        projectName: repo.projectName,
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        mainCommits,
        authoredCommits,
        openedPrs,
        mergedPrs,
        tasks: taskDataList,
      } satisfies StandupRepoData;
    }),
  );

  return groupReposByProject(repoData);
}

function truncate(text: string, maxChars = MAX_PR_BODY_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function indentLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatPrState(state: OpenedPr["state"]): string {
  return state === "merged"
    ? "MERGED"
    : state === "closed"
      ? "CLOSED"
      : "OPEN";
}

function formatRepoTaskContext(task: StandupTaskData): string {
  const description = task.taskDescription || "none";
  const taskId = task.taskId || "none";
  const branch = task.branchName || "none";

  let block = `Task: ${description} (id: ${taskId}) | status: ${task.taskStatus} | branch: ${branch}\n`;
  block += `Task branch commits in window:\n${task.branchCommits || "none"}\n`;

  if (task.commitEvents.length > 0) {
    block += "Commit notes captured by this app:\n";
    for (const event of task.commitEvents) {
      const tags = [
        event.createdAt ? `at ${event.createdAt}` : "",
        event.commitSha ? `sha ${event.commitSha}` : "",
        event.source ? `via ${event.source}` : "",
        event.model ? `model ${event.model}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      block += `- ${tags || "commit event"}\n`;
      block += `${indentLines(event.message, "  ")}\n`;
    }
  }

  if (task.prTitle) {
    block += `Related PR on this task branch: ${task.prTitle}`;
    if (task.prState) {
      block += ` (state: ${formatPrState(task.prState)})`;
    }
    block += "\n";
  }
  if (task.prBody) {
    block += `Related PR description:\n${truncate(task.prBody)}\n`;
  }
  if (task.prStatus) {
    block += `Current PR status: ${task.prStatus}\n`;
  }
  return block;
}

export function buildStandupProjectPrompt(
  project: StandupProjectData,
  sinceISO = getStandupWindowStart(),
): string {
  const windowDays = getStandupWindowDays(sinceISO);
  let prompt = `You are writing a standup update for exactly one project (which may contain multiple repositories).
Audience: engineering coworkers who need to know what changed and what they should watch for.
Output rules:
- Plain text only. No markdown. No emojis.
- Produce one standup update for this single project only.
- Use 4-12 concise bullets total.
- The first line must be: In the last ${windowDays} days:
- Start every bullet in this exact plain-text format (no square brackets):
  repo: <repo-name> | task: <task-description-or-none> | id: <task-id-or-none> | branch: <branch-or-none> - <update>
- Never output "[" or "]" characters anywhere in the response.
- Focus on what changed and what teammates should be aware of to do their jobs (behavior/API changes, schema/config shifts, rollout or migration risk, and required follow-up).
- If there was no meaningful work, output exactly one bullet saying that.

Time window: ${sinceISO} to now
Project: ${project.projectName}
`;

  for (const repo of project.repos) {
    prompt += `\n=== Repo: ${repo.repoName} ===\n`;

    prompt += `\nAuthored commits in this window (all branches):\n${repo.authoredCommits || "none"}\n`;

    prompt += `\nCommits that landed on main in this window:\n${repo.mainCommits || "none"}\n`;

    prompt += "\nPRs I opened in this window (all states):\n";
    if (repo.openedPrs.length === 0) {
      prompt += "none\n";
    } else {
      for (const pr of repo.openedPrs) {
        prompt += `PR #${pr.number} ${formatPrState(pr.state)} (${pr.headRefName || "none"}) created ${pr.createdAt}: ${pr.title}\n`;
        if (pr.mergedAt) {
          prompt += `merged at ${pr.mergedAt}\n`;
        }
        if (pr.body) {
          prompt += `${truncate(pr.body)}\n`;
        }
      }
    }

    prompt += "\nPRs I merged in this window:\n";
    if (repo.mergedPrs.length === 0) {
      prompt += "none\n";
    } else {
      for (const pr of repo.mergedPrs) {
        prompt += `PR #${pr.number} (${pr.headRefName || "none"}): ${pr.title}\n`;
        if (pr.body) {
          prompt += `${truncate(pr.body)}\n`;
        }
      }
    }

    prompt += "\nTasks in this repo (description first, id in parentheses):\n";
    if (repo.tasks.length === 0) {
      prompt += "none\n";
    } else {
      for (const task of repo.tasks) {
        prompt += `\n${formatRepoTaskContext(task)}`;
      }
    }
  }

  return prompt;
}

export function buildStandupPrompt(data: StandupProjectData[]): string {
  const sinceISO = getStandupWindowStart();
  return data
    .map((project) => buildStandupProjectPrompt(project, sinceISO))
    .join("\n\n-----\n\n");
}

export async function generateStandup(apiKey: string): Promise<string> {
  const data = await gatherStandupData();

  if (data.length === 0) {
    return "No task activity found in the current time window.";
  }

  const sinceISO = getStandupWindowStart();
  const sections: string[] = [];

  for (const project of data) {
    const prompt = buildStandupProjectPrompt(project, sinceISO);
    const projectSummary = (await generateStandupSummary(apiKey, prompt)).trim();
    sections.push(
      `${project.projectName}\n${projectSummary || "- No meaningful updates generated."}`,
    );
  }

  const summary = sections.join("\n\n");

  const now = new Date().toISOString();
  setAppState("standup.last_generated_at", now);
  setAppState("standup.last_summary", summary);

  return summary;
}
