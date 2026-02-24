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

  const pr = await getPrStatus(repoPath, branch);

  return { branch, ahead, behind, behindMain, changedFiles, pr };
}

/**
 * Get PR status for a branch using gh CLI.
 */
async function getPrStatus(repoPath: string, branch: string): Promise<PrStatus | null> {
  try {
    const json = await $`gh pr view ${branch} --repo $(git -C ${repoPath} remote get-url origin) --json number,state,comments,reviewDecision,reviews`.text();
    const data = JSON.parse(json);
    // Count unresolved review comments (comments on code)
    const reviewComments = Array.isArray(data.reviews)
      ? data.reviews.filter((r: any) => r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED").length
      : 0;
    return {
      number: data.number,
      state: data.state === "MERGED" ? "merged" : data.state === "CLOSED" ? "closed" : "open",
      comments: Array.isArray(data.comments) ? data.comments.length : 0,
      reviewComments,
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
  const totalComments = pr.comments + pr.reviewComments;
  const commentStr = totalComments > 0 ? ` ${totalComments} comment${totalComments !== 1 ? "s" : ""}` : "";
  return `PR #${pr.number} ${state}${commentStr}`;
}
