import { $ } from "bun";
import type { GitStatus, PrStatus, ReviewThread } from "../store/types.js";

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

/**
 * Parse owner/repo from a git remote URL (ssh or https).
 */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Strip cursor bugbot noise and HTML from a comment body.
 */
function cleanCommentBody(body: string): string {
  // If description markers exist, extract between them
  const descMatch = body.match(/<!-- DESCRIPTION START -->([\s\S]*?)<!-- DESCRIPTION END -->/);
  if (descMatch) {
    body = descMatch[1].trim();
  }

  return body
    .replace(/<!--[\s\S]*?-->/g, "")                    // HTML comments
    .replace(/<details[\s\S]*?<\/details>/gi, "")        // <details> blocks
    .replace(/<picture[\s\S]*?<\/picture>/gi, "")        // <picture> blocks
    .replace(/<a\s+href="https?:\/\/cursor\.com[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "") // cursor links
    .replace(/<\/?[^>]+>/g, "")                          // remaining HTML tags
    .replace(/\n{3,}/g, "\n\n")                          // collapse blank lines
    .trim();
}

/**
 * Fetch unresolved PR review threads with full comment bodies.
 */
export async function getPrComments(repoPath: string, branch?: string): Promise<ReviewThread[]> {
  try {
    const branchName = branch || (await getCurrentBranch(repoPath));
    const remoteUrl = (await $`git -C ${repoPath} remote get-url origin`.text()).trim();
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return [];

    // Get PR number first
    const prJson = await $`gh pr view ${branchName} --repo ${remoteUrl} --json number`.text();
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
              comments(first: 10) {
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
    const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];

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
