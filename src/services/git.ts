import { $ } from "bun";
import type { GitStatus, PrStatus } from "../store/types.js";

/**
 * Get git status information for a given repo path.
 */
export async function getGitStatus(repoPath: string, branchName?: string): Promise<GitStatus> {
  const branch = branchName || (await getCurrentBranch(repoPath));

  let ahead = 0;
  let behind = 0;
  let behindMain = 0;
  let changedFiles = 0;

  try {
    // Ahead/behind remote tracking branch
    const revList = await $`git -C ${repoPath} rev-list --left-right --count ${branch}...origin/${branch} 2>/dev/null`.text();
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
    const behindMainResult = await $`git -C ${repoPath} rev-list --count HEAD..origin/main 2>/dev/null`.text();
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
export async function getGitStatusWithPr(repoPath: string, branchName?: string): Promise<GitStatus> {
  const status = await getGitStatus(repoPath, branchName);
  status.pr = await getPrStatus(repoPath, status.branch);
  return status;
}

/**
 * Get PR status for a branch using gh CLI.
 */
async function getPrStatus(repoPath: string, branch: string): Promise<PrStatus | null> {
  try {
    const remoteUrl = (await $`git -C ${repoPath} remote get-url origin`.text()).trim();
    const json = await $`gh pr view ${branch} --repo ${remoteUrl} --json number,state,statusCheckRollup`.text();
    const data = JSON.parse(json);

    // CI check counts
    const checks = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
    const ciFailed = checks.filter((c: any) => c.conclusion === "FAILURE").length;
    const ciPassed = checks.filter((c: any) => c.conclusion === "SUCCESS").length;

    // Unresolved review threads via GraphQL
    let unresolvedThreads = 0;
    try {
      // Parse owner/repo from remote URL (ssh or https)
      const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) {
        const [, owner, repo] = match;
        const gql = await $`gh api graphql -f query=${'query { repository(owner: "' + owner + '", name: "' + repo + '") { pullRequest(number: ' + data.number + ') { reviewThreads(first: 100) { nodes { isResolved } } } } }'}`.text();
        const gqlData = JSON.parse(gql);
        const threads = gqlData?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
        unresolvedThreads = threads.filter((t: any) => !t.isResolved).length;
      }
    } catch {}

    return {
      number: data.number,
      state: data.state === "MERGED" ? "merged" : data.state === "CLOSED" ? "closed" : "open",
      unresolvedThreads,
      ciPassed,
      ciFailed,
    };
  } catch {
    return null;
  }
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    const result = await $`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.text();
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
    parts.push(`${status.changedFiles} file${status.changedFiles !== 1 ? "s" : ""}`);
  }

  return parts.join(" ");
}

export function formatPrStatus(pr: PrStatus): string {
  const state = pr.state === "open" ? "OPEN" : pr.state === "merged" ? "MERGED" : "CLOSED";
  const parts = [`PR #${pr.number} ${state}`];
  const total = pr.ciPassed + pr.ciFailed;
  if (total > 0) {
    parts.push(pr.ciFailed > 0 ? `CI ${pr.ciPassed}/${total}` : `CI ✓`);
  }
  if (pr.unresolvedThreads > 0) {
    parts.push(`${pr.unresolvedThreads} unresolved`);
  }
  return parts.join(" ");
}
