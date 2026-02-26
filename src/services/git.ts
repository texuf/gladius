import { $ } from "bun";
import type {
  GitStatus,
  PrStatus,
  ReviewThread,
  CiCheckFailure,
} from "../store/types.js";

const PR_STATUS_CACHE_TTL_MS = 30_000;
const PR_STATUS_ERROR_TTL_MS = 5_000;

type PrStatusCacheEntry = {
  expiresAt: number;
  byBranch: Map<string, PrStatus>;
};

const prStatusCacheByRemote = new Map<string, PrStatusCacheEntry>();
const prStatusInFlightByRemote = new Map<
  string,
  Promise<Map<string, PrStatus>>
>();

/**
 * Get git status information for a given repo path.
 */
export async function getGitStatus(
  repoPath: string,
  branchName?: string,
): Promise<GitStatus> {
  const branch = branchName || (await getCurrentBranch(repoPath));

  let ahead = 0;
  let behind = 0;
  let behindMain = 0;
  let changedFiles = 0;

  try {
    // Ahead/behind remote tracking branch
    const revList =
      await $`git -C ${repoPath} rev-list --left-right --count ${branch}...origin/${branch} 2>/dev/null`.text();
    const parts = revList.trim().split(/\s+/);
    if (parts.length === 2) {
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  } catch {
    // No remote tracking branch yet
  }

  try {
    // Behind main
    const behindMainResult =
      await $`git -C ${repoPath} rev-list --count HEAD..origin/main 2>/dev/null`.text();
    behindMain = parseInt(behindMainResult.trim(), 10) || 0;
  } catch {
    // No origin/main
  }

  try {
    // Changed files
    const status = await $`git -C ${repoPath} status --porcelain`.text();
    changedFiles = status
      .trim()
      .split("\n")
      .filter((l) => l.length > 0).length;
  } catch {
    // Not a git repo
  }

  return { branch, ahead, behind, behindMain, changedFiles, pr: null };
}

/**
 * Get git status + PR status together. PR fetch is separate so a slow/failing
 * gh call doesn't block the core git status.
 */
export async function getGitStatusWithPr(
  repoPath: string,
  branchName?: string,
): Promise<GitStatus> {
  const status = await getGitStatus(repoPath, branchName);
  status.pr = await getPrStatus(repoPath, status.branch);
  return status;
}

/**
 * Get PR status for a branch using gh CLI.
 */
async function getPrStatus(
  repoPath: string,
  branch: string,
): Promise<PrStatus | null> {
  try {
    const remoteUrl = (
      await $`git -C ${repoPath} remote get-url origin`.text()
    ).trim();
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return null;

    const byBranch = await getOpenPrStatusesForRepo(
      remoteUrl,
      parsed.owner,
      parsed.repo,
    );
    return byBranch.get(branch) || null;
  } catch {
    return null;
  }
}

/**
 * Fetch and cache open PR statuses for a repository in one GraphQL call.
 */
async function getOpenPrStatusesForRepo(
  remoteUrl: string,
  owner: string,
  repo: string,
): Promise<Map<string, PrStatus>> {
  const now = Date.now();
  const cached = prStatusCacheByRemote.get(remoteUrl);
  if (cached && cached.expiresAt > now) {
    return cached.byBranch;
  }

  const inFlight = prStatusInFlightByRemote.get(remoteUrl);
  if (inFlight) {
    return inFlight;
  }

  const query = `query {
    repository(owner: "${owner}", name: "${repo}") {
      pullRequests(first: 100, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          state
          headRefName
          statusCheckRollup {
            contexts(first: 100) {
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                }
                ... on StatusContext {
                  context
                  state
                }
              }
            }
          }
          reviewThreads(first: 100) {
            nodes {
              isResolved
            }
          }
        }
      }
    }
  }`;

  const fetchPromise = (async () => {
    try {
      const raw = await $`gh api graphql -f query=${query}`.text();
      const data = JSON.parse(raw);
      const prs = data?.data?.repository?.pullRequests?.nodes || [];
      const byBranch = new Map<string, PrStatus>();

      for (const pr of prs) {
        const headRefName = pr?.headRefName;
        if (!headRefName || typeof pr?.number !== "number") continue;

        const checks = extractCiCheckNodes(pr?.statusCheckRollup);
        const { ciPassed, ciFailed, ciPending } = summarizeCiChecks(checks);
        const threads = Array.isArray(pr?.reviewThreads?.nodes)
          ? pr.reviewThreads.nodes
          : [];
        const unresolvedThreads = threads.filter(
          (t: any) => !t?.isResolved,
        ).length;

        byBranch.set(headRefName, {
          number: pr.number,
          state: normalizePrState(pr?.state),
          unresolvedThreads,
          ciPassed,
          ciFailed,
          ciPending,
        });
      }

      prStatusCacheByRemote.set(remoteUrl, {
        expiresAt: Date.now() + PR_STATUS_CACHE_TTL_MS,
        byBranch,
      });

      return byBranch;
    } catch {
      // Avoid hammering the API on repeated failures.
      const empty = new Map<string, PrStatus>();
      prStatusCacheByRemote.set(remoteUrl, {
        expiresAt: Date.now() + PR_STATUS_ERROR_TTL_MS,
        byBranch: empty,
      });
      return empty;
    } finally {
      prStatusInFlightByRemote.delete(remoteUrl);
    }
  })();

  prStatusInFlightByRemote.set(remoteUrl, fetchPromise);
  return fetchPromise;
}

function extractCiCheckNodes(statusCheckRollup: any): any[] {
  const nodes = statusCheckRollup?.contexts?.nodes;
  if (Array.isArray(nodes)) return nodes;
  if (Array.isArray(statusCheckRollup)) return statusCheckRollup;
  return [];
}

function summarizeCiChecks(checks: any[]): {
  ciPassed: number;
  ciFailed: number;
  ciPending: number;
} {
  let ciPassed = 0;
  let ciFailed = 0;
  let ciPending = 0;

  for (const check of checks) {
    if (!check) continue;

    const typename =
      typeof check.__typename === "string" ? check.__typename : "";
    if (typename === "CheckRun") {
      const conclusion = String(check.conclusion || "").toUpperCase();
      if (conclusion === "FAILURE") {
        ciFailed += 1;
      } else if (conclusion === "SUCCESS") {
        ciPassed += 1;
      } else if (conclusion !== "SKIPPED") {
        ciPending += 1;
      }
      continue;
    }

    if (typename === "StatusContext") {
      const state = String(check.state || "").toUpperCase();
      if (state === "SUCCESS") {
        ciPassed += 1;
      } else if (state === "FAILURE" || state === "ERROR") {
        ciFailed += 1;
      } else {
        ciPending += 1;
      }
      continue;
    }

    // Fallback path for unexpected payload shapes.
    const conclusion = String(check.conclusion || "").toUpperCase();
    const state = String(check.state || check.status || "").toUpperCase();
    if (conclusion === "FAILURE" || state === "FAILURE" || state === "ERROR") {
      ciFailed += 1;
    } else if (conclusion === "SUCCESS" || state === "SUCCESS") {
      ciPassed += 1;
    } else if (conclusion !== "SKIPPED") {
      ciPending += 1;
    }
  }

  return { ciPassed, ciFailed, ciPending };
}

function normalizePrState(state: string): "open" | "closed" | "merged" {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    const result =
      await $`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.text();
    return result.trim();
  } catch {
    return "unknown";
  }
}

/**
 * Format git status as a display string.
 * Example: "ae/fix-auth-0223 (+5/-4) [-15] 3 files"
 */
export function formatGitStatus(status: GitStatus): string {
  const parts = [status.branch];

  if (status.ahead > 0 || status.behind > 0) {
    parts.push(`(+${status.ahead}/-${status.behind})`);
  }

  if (status.behindMain > 0) {
    parts.push(`[-${status.behindMain}]`);
  }

  if (status.changedFiles > 0) {
    parts.push(
      `${status.changedFiles} file${status.changedFiles !== 1 ? "s" : ""}`,
    );
  }

  return parts.join(" ");
}

/**
 * Parse owner/repo from a git remote URL (ssh or https).
 */
function parseOwnerRepo(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Strip cursor bugbot noise and HTML from a comment body.
 */
function cleanCommentBody(body: string): string {
  // If description markers exist, extract between them
  const descMatch = body.match(
    /<!-- DESCRIPTION START -->([\s\S]*?)<!-- DESCRIPTION END -->/,
  );
  const extracted = descMatch?.[1]?.trim();
  if (extracted) {
    body = extracted;
  }

  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, "") // HTML comments
    // Strip container tags but keep their inner text (some bots put useful text in <details>/<summary>)
    .replace(/<\/?(details|summary|picture|a)\b[^>]*>/gi, "")
    .replace(/<\/?[^>]+>/g, "") // remaining HTML tags
    .replace(/\n{3,}/g, "\n\n") // collapse blank lines
    .trim();

  return cleaned;
}

/**
 * Fetch unresolved PR review threads with full comment bodies.
 */
export async function getPrComments(
  repoPath: string,
  branch?: string,
): Promise<ReviewThread[]> {
  try {
    const branchName = branch || (await getCurrentBranch(repoPath));
    const remoteUrl = (
      await $`git -C ${repoPath} remote get-url origin`.text()
    ).trim();
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return [];

    // Get PR number first
    const prJson =
      await $`gh pr view ${branchName} --repo ${remoteUrl} --json number`.text();
    const { number: prNumber } = JSON.parse(prJson);

    const query = `query {
      repository(owner: "${parsed.owner}", name: "${parsed.repo}") {
        pullRequest(number: ${prNumber}) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              startLine
              comments(last: 50) {
                nodes {
                  body
                  author { login }
                  createdAt
                }
              }
            }
          }
        }
      }
    }`;

    const gql = await $`gh api graphql -f query=${query}`.text();
    const data = JSON.parse(gql);
    const threads =
      data?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];

    return threads
      .filter((t: any) => !t.isResolved)
      .map((t: any) => ({
        id: t.id,
        path: t.path || "",
        line: t.line || 0,
        startLine: t.startLine || null,
        comments: (t.comments?.nodes || []).map((c: any) => ({
          body: cleanCommentBody(c.body || ""),
          author: c.author?.login || "unknown",
          createdAt: c.createdAt || "",
        })),
      }));
  } catch {
    return [];
  }
}

/**
 * Resolve a PR review thread via GraphQL mutation.
 */
export async function resolveThread(threadId: string): Promise<boolean> {
  try {
    await $`gh api graphql -f query=${'mutation { resolveReviewThread(input: { threadId: "' + threadId + '" }) { thread { id isResolved } } }'}`.text();
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the log output for a failed step from raw job logs.
 * Strategy: find the ##[error] line for this step, then grab the preceding
 * lines of output (the tail). This works well for large steps (like turbo build)
 * where the error is at the end after hundreds of lines of sub-task output.
 */
function extractFailedStepLog(rawLog: string, stepName: string): string {
  const sanitizeLogLine = (line: string): string => {
    return (
      line
        // ANSI CSI sequences
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
        // ANSI OSC sequences
        .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
        // Remaining control chars (except tab)
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    );
  };

  const lines = rawLog.split("\n");
  const stepLower = stepName.toLowerCase();

  // Find the step's ##[group] start and the ##[error] that ends it
  let stepStart = -1;
  let errorLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (stepStart === -1) {
      if (
        line.includes("##[group]") &&
        line.toLowerCase().includes(stepLower)
      ) {
        stepStart = i;
      }
      continue;
    }
    // Find the last ##[error] within this step's range
    // (before the next top-level step, identified by ##[group]Run or end of log)
    if (line.includes("##[error]")) {
      errorLine = i;
    }
    // Stop at the next step's "Run" group (top-level step boundary)
    if (i > stepStart && line.includes("##[group]Run ")) break;
  }

  // Fallback: step name (e.g. "Run CI Integration Tests") doesn't match any
  // ##[group] marker (which may use the actual command like "Run bun run test:ci").
  // Instead, anchor on the last meaningful ##[error] line in the log.
  if (stepStart === -1) {
    const lastGenericError = "Process completed with exit code";
    let lastMeaningfulError = -1;
    let lastError = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("##[error]")) {
        lastError = i;
        if (!lines[i].includes(lastGenericError)) {
          lastMeaningfulError = i;
        }
      }
    }
    errorLine = lastMeaningfulError !== -1 ? lastMeaningfulError : lastError;
    if (errorLine === -1) return "";
    stepStart = 0;
  }

  // Determine the range to extract: up to 60 lines before the error, through lines after
  const end =
    errorLine !== -1 ? Math.min(errorLine + 20, lines.length) : lines.length;
  const tailStart =
    errorLine !== -1
      ? Math.max(stepStart + 1, errorLine - 60)
      : Math.max(stepStart + 1, end - 60);

  const result: string[] = [];
  for (let i = tailStart; i < end; i++) {
    const line = lines[i];
    // Skip group/endgroup markers from sub-tasks
    if (line.includes("##[group]") || line.includes("##[endgroup]")) continue;
    // Strip timestamp prefix
    let stripped = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");
    if (stripped.startsWith("##[error]")) {
      stripped = stripped.replace("##[error]", "").trim();
    }
    result.push(sanitizeLogLine(stripped));
  }

  return result.join("\n").trimEnd();
}

/**
 * Fetch CI check failures with log output for a PR.
 * Uses the Actions API to get workflow runs → jobs → failed steps → logs.
 */
export async function getCiFailures(
  repoPath: string,
  branch?: string,
): Promise<CiCheckFailure[]> {
  try {
    const branchName = branch || (await getCurrentBranch(repoPath));
    const remoteUrl = (
      await $`git -C ${repoPath} remote get-url origin`.text()
    ).trim();
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return [];

    // Get head SHA from PR
    const prJson =
      await $`gh pr view ${branchName} --repo ${remoteUrl} --json headRefOid`.text();
    const { headRefOid: sha } = JSON.parse(prJson);

    // Get failed workflow runs for this commit
    const runsEndpoint = `repos/${parsed.owner}/${parsed.repo}/actions/runs?head_sha=${sha}&status=failure`;
    const runsJson = await $`gh api ${runsEndpoint}`.text();
    const { workflow_runs: runs } = JSON.parse(runsJson);
    if (!runs || runs.length === 0) return [];

    // Get failed jobs across all failed runs in parallel
    const jobResults = await Promise.all(
      (runs as any[]).map(async (run: any) => {
        const jobsJson =
          await $`gh api repos/${parsed.owner}/${parsed.repo}/actions/runs/${run.id}/jobs`.text();
        const { jobs } = JSON.parse(jobsJson);
        return (jobs || [])
          .filter((j: any) => j.conclusion === "failure")
          .map((j: any) => ({
            ...j,
            runUrl: run.html_url,
          }));
      }),
    );
    const failedJobs = jobResults.flat();

    // Fetch logs for each failed job in parallel
    const results: CiCheckFailure[] = await Promise.all(
      failedJobs.map(async (job: any): Promise<CiCheckFailure> => {
        const failedStep = (job.steps || []).find(
          (s: any) => s.conclusion === "failure",
        );
        let log = "";

        if (failedStep) {
          try {
            const rawLog =
              await $`gh api repos/${parsed.owner}/${parsed.repo}/actions/jobs/${job.id}/logs`.text();
            log = extractFailedStepLog(rawLog, failedStep.name);
          } catch {}
        }

        return {
          name: job.name || "",
          failedStep: failedStep?.name || null,
          detailsUrl: job.html_url || job.runUrl || "",
          log,
        };
      }),
    );

    return results;
  } catch {
    return [];
  }
}

/**
 * Detect the main branch name from the remote HEAD.
 */
export async function getMainBranch(repoPath: string): Promise<string> {
  try {
    const ref =
      await $`git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD`.text();
    // refs/remotes/origin/main → main
    return ref.trim().replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

/**
 * Get commit log messages between main and HEAD.
 */
export async function getCommitLog(
  repoPath: string,
  mainBranch?: string,
): Promise<string> {
  const main = mainBranch || (await getMainBranch(repoPath));
  try {
    return (
      await $`git -C ${repoPath} log origin/${main}..HEAD --pretty=format:%s%n%b`.text()
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Get diff stat between main and HEAD.
 */
export async function getDiffStat(
  repoPath: string,
  mainBranch?: string,
): Promise<string> {
  const main = mainBranch || (await getMainBranch(repoPath));
  try {
    return (
      await $`git -C ${repoPath} diff --stat origin/${main}..HEAD`.text()
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Stage all changes and commit with the given message.
 */
export async function stageAndCommit(
  repoPath: string,
  message: string,
): Promise<void> {
  await $`git -C ${repoPath} add .`;
  await $`git -C ${repoPath} commit -m ${message}`;
}

/**
 * Push the current branch to origin, setting upstream.
 */
export async function pushBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  await $`git -C ${repoPath} push -u origin ${branchName}`;
}

/**
 * Create a pull request using gh CLI. Returns the PR number and URL.
 */
export async function createPullRequest(
  repoPath: string,
  title: string,
  body: string,
  reviewers: string[],
): Promise<{ number: number; url: string }> {
  const remoteUrl = (
    await $`git -C ${repoPath} remote get-url origin`.text()
  ).trim();
  // Build reviewer args: ["--reviewer", "user1", "--reviewer", "user2"]
  const reviewerArgs: string[] = [];
  for (const r of reviewers) {
    reviewerArgs.push("--reviewer", r);
  }
  const allArgs = [
    "pr",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--repo",
    remoteUrl,
    ...reviewerArgs,
  ];
  const result = await $`gh ${allArgs}`.cwd(repoPath).text();
  // gh pr create outputs the PR URL on the last line
  const url = result.trim().split("\n").pop()!.trim();
  const numMatch = url.match(/\/pull\/(\d+)/);
  return { number: numMatch ? parseInt(numMatch[1], 10) : 0, url };
}

export function formatPrStatus(pr: PrStatus): string {
  const state =
    pr.state === "open" ? "OPEN" : pr.state === "merged" ? "MERGED" : "CLOSED";
  const parts = [`PR #${pr.number} ${state}`];
  const total = pr.ciPassed + pr.ciFailed + pr.ciPending;
  if (total > 0) {
    if (pr.ciFailed > 0) {
      parts.push(`CI ${pr.ciPassed}/${total}`);
    } else if (pr.ciPending > 0) {
      parts.push(`CI ${pr.ciPassed}/${total}...`);
    } else {
      parts.push(`CI ✓`);
    }
  }
  if (pr.unresolvedThreads > 0) {
    parts.push(`${pr.unresolvedThreads} unresolved`);
  }
  return parts.join(" ");
}
