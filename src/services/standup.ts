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
  groupName: string;
  projectName: string;
  projectPath: string;
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

  // Dedupe projects from the task list
  const projectMap = new Map<
    string,
    {
      groupName: string;
      projectName: string;
      projectPath: string;
      tasks: typeof tasks;
    }
  >();

  for (const task of tasks) {
    const key = `${task.group_name}::${task.project_name}`;
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        groupName: task.group_name,
        projectName: task.project_name,
        projectPath: task.project_path,
        tasks: [],
      });
    }
    projectMap.get(key)!.tasks.push(task);
  }

  // Gather data per project in parallel
  const results = await Promise.all(
    Array.from(projectMap.values()).map(async (project) => {
      const mainBranch = await getMainBranch(project.projectPath);

      // Fetch main commits and merged PRs in parallel
      const [mainCommits, mergedPrs] = await Promise.all([
        getCommitsSinceOnBranch(
          project.projectPath,
          mainBranch,
          sinceISO,
        ),
        getMergedPrsSince(project.projectPath, sinceISO),
      ]);

      // Build a map of merged PRs by branch for matching to tasks
      const prByBranch = new Map<string, MergedPr>();
      for (const pr of mergedPrs) {
        if (pr.headRefName) {
          prByBranch.set(pr.headRefName, pr);
        }
      }

      // Fetch per-task branch commits in parallel
      const taskDataList = await Promise.all(
        project.tasks.map(async (task) => {
          const commits = task.branch_name
            ? await getCommitsSinceOnBranch(
                project.projectPath,
                task.branch_name,
                sinceISO,
              )
            : "";

          const matchedPr = task.branch_name
            ? prByBranch.get(task.branch_name) ?? null
            : null;

          const cachedPr: PrStatus | null =
            gitStatuses[task.id]?.pr ?? null;
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
        groupName: project.groupName,
        projectName: project.projectName,
        projectPath: project.projectPath,
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

  for (const project of data) {
    prompt += `\n=== ${project.groupName} / ${project.projectName} ===\n`;

    if (project.mainCommits) {
      prompt += `\nRecent commits on main:\n${project.mainCommits}\n`;
    }

    if (project.mergedPrs.length > 0) {
      prompt += `\nMerged PRs:\n`;
      for (const pr of project.mergedPrs) {
        prompt += `PR #${pr.number} (${pr.headRefName}): ${pr.title}\n`;
        if (pr.body) {
          const truncated =
            pr.body.length > 500 ? pr.body.slice(0, 500) + "..." : pr.body;
          prompt += `${truncated}\n`;
        }
      }
    }

    prompt += `\nActive tasks:\n`;
    for (const task of project.tasks) {
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
