import {
  getAppState,
  setAppState,
  getTasksActiveDuringWindow,
} from "./db.js";
import {
  getCommitsSinceOnBranch,
  getMergedPrsSince,
  getMainBranch,
  formatPrStatus,
} from "./git.js";
import type { MergedPr } from "./git.js";
import { generateStandupSummary } from "./llm.js";
import { useStore } from "../store/index.js";
import type { PrStatus } from "../store/types.js";

export interface StandupTaskData {
  taskLabel: string;
  taskStatus: string;
  branchName: string | null;
  commits: string;
  prTitle: string | null;
  prBody: string | null;
  prStatus: string | null;
}

export interface StandupProjectData {
  projectName: string;
  repoName: string;
  repoPath: string;
  mainCommits: string;
  mergedPrs: MergedPr[];
  tasks: StandupTaskData[];
}

export function getStandupWindowStart(): string {
  const saved = getAppState("standup.last_generated_at");
  if (saved) return saved;
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
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

  const results = await Promise.all(
    Array.from(repoMap.values()).map(async (repo) => {
      const mainBranch = await getMainBranch(repo.repoPath);

      const [mainCommits, mergedPrs] = await Promise.all([
        getCommitsSinceOnBranch(repo.repoPath, mainBranch, sinceISO),
        getMergedPrsSince(repo.repoPath, sinceISO),
      ]);

      const prByBranch = new Map<string, MergedPr>();
      for (const pr of mergedPrs) {
        if (pr.headRefName) {
          prByBranch.set(pr.headRefName, pr);
        }
      }

      const taskDataList = await Promise.all(
        repo.tasks.map(async (task) => {
          const commits = task.branch_name
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

          return {
            taskLabel: task.label,
            taskStatus: task.status,
            branchName: task.branch_name,
            commits,
            prTitle: matchedPr?.title ?? null,
            prBody: matchedPr?.body ?? null,
            prStatus: prStatusStr,
          } satisfies StandupTaskData;
        }),
      );

      return {
        projectName: repo.projectName,
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        mainCommits,
        mergedPrs,
        tasks: taskDataList,
      } satisfies StandupProjectData;
    }),
  );

  return results;
}

export function buildStandupPrompt(data: StandupProjectData[]): string {
  const sinceISO = getStandupWindowStart();
  let prompt = `Summarize my work for a standup update. Be concise — one or two sentences per item. Group by project. No emojis. Plain text, not markdown.

Time window: ${sinceISO} to now
`;

  for (const repo of data) {
    prompt += `\n=== ${repo.projectName} / ${repo.repoName} ===\n`;

    if (repo.mainCommits) {
      prompt += `\nRecent commits on main:\n${repo.mainCommits}\n`;
    }

    if (repo.mergedPrs.length > 0) {
      prompt += `\nMerged PRs:\n`;
      for (const pr of repo.mergedPrs) {
        prompt += `PR #${pr.number} (${pr.headRefName}): ${pr.title}\n`;
        if (pr.body) {
          const truncated =
            pr.body.length > 500 ? pr.body.slice(0, 500) + "..." : pr.body;
          prompt += `${truncated}\n`;
        }
      }
    }

    prompt += `\nActive tasks:\n`;
    for (const task of repo.tasks) {
      prompt += `- ${task.taskLabel} [${task.taskStatus}]`;
      if (task.branchName) {
        prompt += ` branch: ${task.branchName}`;
      }
      prompt += `\n`;
      prompt += `  Commits: ${task.commits || "none yet"}\n`;
      if (task.prTitle) {
        prompt += `  Merged PR: ${task.prTitle}\n`;
        if (task.prBody) {
          const truncated =
            task.prBody.length > 500
              ? task.prBody.slice(0, 500) + "..."
              : task.prBody;
          prompt += `  PR description: ${truncated}\n`;
        }
      }
      if (task.prStatus) {
        prompt += `  PR: ${task.prStatus}\n`;
      }
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
