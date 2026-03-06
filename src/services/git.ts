import { $ } from "bun";
import { getRepoForPath } from "./db.js";
import {
  quoteShell,
  resolveProjectBackend,
  runBackendCommand,
} from "./projectBackend.js";
import type {
  GitStatus,
  PrStatus,
  PrReadiness,
  TaskStatusColor,
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

type PrCandidate = PrStatus & {
  updatedAtMs: number;
};

function getBackendForPath(repoPath: string) {
  const repo = getRepoForPath(repoPath);
  if (!repo) return null;
  return resolveProjectBackend({
    backend_kind: repo.project_backend_kind,
    backend_target: repo.project_backend_target,
    backend_base_path: repo.project_backend_base_path,
    backend_display_name: repo.project_backend_display_name,
    path: repo.project_path,
    name: repo.project_name,
  });
}

export async function runGitCommand(
  repoPath: string,
  args: string[],
): Promise<string> {
  const backend = getBackendForPath(repoPath);
  if (backend?.kind === "ssh") {
    const command = `git ${args.map((arg) => quoteShell(arg)).join(" ")}`;
    const result = runBackendCommand(backend, command);
    if (result.exitCode !== 0) {
      const error = new Error(
        (result.stderr || result.stdout || "git command failed").trim(),
      ) as Error & { stdout?: string; stderr?: string; exitCode?: number };
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      error.exitCode = result.exitCode;
      throw error;
    }
    return result.stdout;
  }

  return await $`git ${args}`.text();
}

export async function runGhCommand(args: string[]): Promise<string> {
  return await $`gh ${args}`.text();
}

async function getRemoteUrl(repoPath: string): Promise<string> {
  return (
    await runGitCommand(repoPath, ["-C", repoPath, "remote", "get-url", "origin"])
  ).trim();
}

export async function getRepoSlugForPath(repoPath: string): Promise<string | null> {
  const parsed = parseOwnerRepo(await getRemoteUrl(repoPath));
  if (!parsed) return null;
  return `${parsed.owner}/${parsed.repo}`;
}

function getPrReadiness(pr: {
  state: "open" | "closed" | "merged";
  hasConflicts: boolean;
  unresolvedThreads: number;
  ciFailed: number;
  ciPending: number;
}): PrReadiness {
  if (pr.state === "merged") return "merged";
  if (pr.state !== "open") return "none";
  if (pr.ciPending > 0) return "ciPending";
  if (pr.hasConflicts || pr.unresolvedThreads > 0 || pr.ciFailed > 0) {
    return "attentionNeeded";
  }
  return "readyToMerge";
}

function prReadinessToColor(readiness: PrReadiness): TaskStatusColor {
  switch (readiness) {
    case "merged":
      return "purple";
    case "ciPending":
      return "yellow";
    case "attentionNeeded":
      return "red";
    case "readyToMerge":
      return "green";
    default:
      return "none";
  }
}

/**
 * Get git status information for a given repo path.
 */
export async function getGitStatus(
  repoPath: string,
  branchName?: string,
): Promise<GitStatus> {
  const branch = branchName || (await getCurrentBranch(repoPath));

  let hasTrackingBranch = false;
  let _tracksMain = false;
  let ahead = 0;
  let behind = 0;
  let behindMain = 0;
  let changedFiles = 0;

  let upstream = "";
  try {
    // Resolve upstream tracking branch (if configured for this branch)
    upstream = (
      await runGitCommand(repoPath, [
        "-C",
        repoPath,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        `${branch}@{upstream}`,
      ])
    ).trim();
  } catch {
    // No upstream configured
  }
  if (upstream) {
    const upstreamBranch = upstream.replace(/^origin\//, "");
    _tracksMain = upstreamBranch === "main" || upstreamBranch === "master";

    try {
      const revList = await runGitCommand(repoPath, [
        "-C",
        repoPath,
        "rev-list",
        "--left-right",
        "--count",
        `${branch}...${upstream}`,
      ]);
      const parts = revList.trim().split(/\s+/);
      if (parts.length === 2) {
        hasTrackingBranch = true;
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    } catch {
      // Upstream is configured but no longer resolves (e.g. remote branch deleted).
    }
  }

  try {
    // Behind main
    const main = await getMainBranch(repoPath);
    const behindMainResult = await runGitCommand(repoPath, [
      "-C",
      repoPath,
      "rev-list",
      "--count",
      `HEAD..origin/${main}`,
    ]);
    behindMain = parseInt(behindMainResult.trim(), 10) || 0;
  } catch {
    // No origin/<main>
  }

  try {
    // Changed files
    const status = await runGitCommand(repoPath, [
      "-C",
      repoPath,
      "status",
      "--porcelain",
    ]);
    changedFiles = status
      .trim()
      .split("\n")
      .filter((l) => l.length > 0).length;
  } catch {
    // Not a git repo
  }

  return {
    branch,
    hasTrackingBranch,
    tracksMain: _tracksMain,
    ahead,
    behind,
    behindMain,
    changedFiles,
    pr: null,
  };
}

/**
 * Get git status + PR status together. PR fetch is separate so a slow/failing
 * gh call doesn't block the core git status.
 */
export async function getGitStatusWithPr(
  repoPath: string,
  branchName?: string,
  options?: { forcePrRefresh?: boolean },
): Promise<GitStatus> {
  const status = await getGitStatus(repoPath, branchName);
  status.pr = await getPrStatus(
    repoPath,
    status.branch,
    options?.forcePrRefresh === true,
  );
  return status;
}

/**
 * Get PR status for a branch using gh CLI.
 */
async function getPrStatus(
  repoPath: string,
  branch: string,
  forceRefresh = false,
): Promise<PrStatus | null> {
  try {
    const remoteUrl = await getRemoteUrl(repoPath);
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return null;

    const byBranch = await getOpenPrStatusesForRepo(
      remoteUrl,
      parsed.owner,
      parsed.repo,
      forceRefresh,
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
  forceRefresh = false,
): Promise<Map<string, PrStatus>> {
  const now = Date.now();
  const cached = prStatusCacheByRemote.get(remoteUrl);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.byBranch;
  }

  const inFlight = prStatusInFlightByRemote.get(remoteUrl);
  if (!forceRefresh && inFlight) {
    return inFlight;
  }

  const query = `query {
    repository(owner: "${owner}", name: "${repo}") {
      pullRequests(first: 100, states: [OPEN, MERGED], orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          title
          updatedAt
          state
          mergeable
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
      const raw = await runGhCommand(["api", "graphql", "-f", `query=${query}`]);
      const data = JSON.parse(raw);
      const prs = data?.data?.repository?.pullRequests?.nodes || [];
      const openByBranch = new Map<string, PrCandidate>();
      const mergedByBranch = new Map<string, PrCandidate>();

      for (const pr of prs) {
        const headRefName = pr?.headRefName;
        if (!headRefName || typeof pr?.number !== "number") continue;

        const state = normalizePrState(pr?.state);
        const checks = extractCiCheckNodes(pr?.statusCheckRollup);
        const { ciPassed, ciFailed, ciPending } = summarizeCiChecks(checks);
        const threads = Array.isArray(pr?.reviewThreads?.nodes)
          ? pr.reviewThreads.nodes
          : [];
        const unresolvedThreads = threads.filter(
          (t: any) => !t?.isResolved,
        ).length;
        const hasConflicts = isConflicting(pr?.mergeable);
        const readiness = getPrReadiness({
          state,
          hasConflicts,
          unresolvedThreads,
          ciFailed,
          ciPending,
        });

        const candidate: PrCandidate = {
          number: pr.number,
          title: pr?.title ?? "",
          state,
          readiness,
          statusColor: prReadinessToColor(readiness),
          hasConflicts,
          unresolvedThreads,
          ciPassed,
          ciFailed,
          ciPending,
          updatedAtMs: Date.parse(pr?.updatedAt || "") || 0,
        };

        if (state === "open") {
          const existing = openByBranch.get(headRefName);
          if (!existing || candidate.updatedAtMs > existing.updatedAtMs) {
            openByBranch.set(headRefName, candidate);
          }
          continue;
        }

        if (state === "merged") {
          const existing = mergedByBranch.get(headRefName);
          if (!existing || candidate.updatedAtMs > existing.updatedAtMs) {
            mergedByBranch.set(headRefName, candidate);
          }
        }
      }

      const byBranch = new Map<string, PrStatus>();

      // Prefer open PRs for reused branch names.
      for (const [branch, candidate] of openByBranch) {
        const { updatedAtMs: _updatedAtMs, ...status } = candidate;
        byBranch.set(branch, status);
      }

      // Fall back to merged PR only when there is no open PR.
      for (const [branch, candidate] of mergedByBranch) {
        if (byBranch.has(branch)) continue;
        const { updatedAtMs: _updatedAtMs, ...status } = candidate;
        byBranch.set(branch, status);
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

export function clearPrCacheForBranch(repoPath: string, branch: string): void {
  for (const [, entry] of prStatusCacheByRemote) {
    entry.byBranch.delete(branch);
  }
}

function extractCiCheckNodes(statusCheckRollup: any): any[] {
  const nodes = statusCheckRollup?.contexts?.nodes;
  if (Array.isArray(nodes)) return nodes;
  if (Array.isArray(statusCheckRollup)) return statusCheckRollup;
  return [];
}

const CHECKRUN_FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

const CHECKRUN_PASS_CONCLUSIONS = new Set([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
]);

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
      const status = String(check.status || "").toUpperCase();
      const conclusion = String(check.conclusion || "").toUpperCase();

      // A run is pending only while it is not completed.
      if (status && status !== "COMPLETED") {
        ciPending += 1;
      } else if (CHECKRUN_FAIL_CONCLUSIONS.has(conclusion)) {
        ciFailed += 1;
      } else if (CHECKRUN_PASS_CONCLUSIONS.has(conclusion)) {
        ciPassed += 1;
      } else if (status === "COMPLETED") {
        // Completed checks with unknown conclusions should not block as pending.
        ciPassed += 1;
      } else {
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
    const status = String(check.status || "").toUpperCase();
    const conclusion = String(check.conclusion || "").toUpperCase();
    const state = String(check.state || "").toUpperCase();
    if (status && status !== "COMPLETED") {
      ciPending += 1;
    } else if (
      CHECKRUN_FAIL_CONCLUSIONS.has(conclusion) ||
      state === "FAILURE" ||
      state === "ERROR"
    ) {
      ciFailed += 1;
    } else if (
      CHECKRUN_PASS_CONCLUSIONS.has(conclusion) ||
      state === "SUCCESS"
    ) {
      ciPassed += 1;
    } else if (status === "COMPLETED") {
      ciPassed += 1;
    } else {
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

function isConflicting(mergeable: string): boolean {
  return String(mergeable || "").toUpperCase() === "CONFLICTING";
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    const result = await runGitCommand(repoPath, [
      "-C",
      repoPath,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
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

  if (status.ahead > 0 || status.behind > 0 || status.tracksMain) {
    if (status.tracksMain) {
      parts.push(`(+${status.ahead}/m)`);
    } else {
      parts.push(`(+${status.ahead}/-${status.behind})`);
    }
  } else if (status.hasTrackingBranch) {
    parts.push("(=)");
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

export async function fetchLatestMain(repoPath: string): Promise<void> {
  try {
    await runGitCommand(repoPath, ["-C", repoPath, "fetch", "--prune", "origin"]);
  } catch {}
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
    const remoteUrl = await getRemoteUrl(repoPath);
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return [];
    const repoSlug = `${parsed.owner}/${parsed.repo}`;

    // Get PR number first
    const prJson = await runGhCommand([
      "pr",
      "view",
      branchName,
      "--repo",
      repoSlug,
      "--json",
      "number",
    ]);
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

    const gql = await runGhCommand(["api", "graphql", "-f", `query=${query}`]);
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
    await runGhCommand([
      "api",
      "graphql",
      "-f",
      `query=mutation { resolveReviewThread(input: { threadId: "${threadId}" }) { thread { id isResolved } } }`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the log output for a failed step from raw job logs.
 * Strategy:
 * 1) Scope to the failed step window using step timestamps (fallback to marker matching).
 * 2) Anchor on the first substantive error signal inside that window.
 * 3) Return a focused slice around the anchor.
 */
function extractFailedStepLog(
  rawLog: string,
  stepName: string,
  failedStep?: { started_at?: string; completed_at?: string },
): string {
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

  const stripTimestamp = (line: string) =>
    line.replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");

  const parseLineTimestamp = (line: string): number | null => {
    const match = sanitizeLogLine(line).match(
      /^\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?/,
    );
    if (!match) return null;
    const parsed = Date.parse(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const genericErrorPatterns = [
    /process completed with exit code/i,
    /error: script ".*" exited with code/i,
    /\[error\] command finished with error/i,
    /run failed: command\s+exited/i,
    /error: "turbo" exited with code/i,
    /command .* exited \(\d+\)/i,
  ];
  const strongErrorPatterns = [
    /assertionerror/i,
    /\bpanic:/i,
    /\bfail\b/i,
    /❯/,
    /×/,
    /expected .* to be/i,
    /error:\s+unexpected http response/i,
  ];

  const isGenericErrorLine = (line: string): boolean =>
    genericErrorPatterns.some((pattern) => pattern.test(line));
  const isStrongErrorLine = (line: string): boolean =>
    strongErrorPatterns.some((pattern) => pattern.test(line));

  const lines = rawLog.split("\n");

  // First try to scope by the failed step's timestamps. This is the most
  // reliable way to isolate the right section when the log contains many
  // nested "Run ..." groups.
  let stepStart = -1;
  let stepEnd = -1;
  const startedAtMs = failedStep?.started_at
    ? Date.parse(failedStep.started_at)
    : NaN;
  const completedAtMs = failedStep?.completed_at
    ? Date.parse(failedStep.completed_at)
    : NaN;
  if (Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)) {
    const startBoundary = startedAtMs - 1_000;
    const endBoundary = completedAtMs + 1_000;
    for (let i = 0; i < lines.length; i++) {
      const timestamp = parseLineTimestamp(lines[i]);
      if (timestamp === null) continue;
      if (stepStart === -1 && timestamp >= startBoundary) {
        stepStart = i;
      }
      if (timestamp <= endBoundary) {
        stepEnd = i + 1;
      }
    }
  }

  // Preserve existing step-name scoping behavior as fallback.
  if (stepStart === -1 || stepEnd === -1 || stepEnd <= stepStart) {
    stepStart = -1;
    stepEnd = -1;
    const stepLower = stepName.toLowerCase();
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
      if (i > stepStart && line.includes("##[group]Run ")) {
        stepEnd = i;
        break;
      }
    }
  }

  if (stepStart === -1) stepStart = 0;
  if (stepEnd === -1) stepEnd = lines.length;

  let firstNonGenericError = -1;
  let firstStrongError = -1;
  let firstGenericError = -1;
  let firstErrorLike = -1;

  for (let i = stepStart; i < stepEnd; i++) {
    const raw = stripTimestamp(sanitizeLogLine(lines[i]));
    const lower = raw.toLowerCase();
    if (!lower) continue;

    // Skip lines that are passing/skipped results — test names can contain
    // words like "Fail" which would otherwise false-positive on strong patterns.
    const contentAfterMarkers = raw
      .replace(/^##\[(?:group|endgroup)\]\s*/, "")
      .trimStart();
    const isPassResult =
      /^---\s+PASS\b/i.test(contentAfterMarkers) ||
      /^(?:PASS|SKIP)\b/i.test(contentAfterMarkers);

    const isErrorMarker =
      lower.includes("##[error]") || lower.startsWith("error:");
    const isGeneric = isGenericErrorLine(raw);
    const isStrong = !isPassResult && isStrongErrorLine(raw);

    if (isStrong && firstStrongError === -1) {
      firstStrongError = i;
    }

    if (isErrorMarker) {
      if (!isGeneric && firstNonGenericError === -1) {
        firstNonGenericError = i;
      } else if (isGeneric && firstGenericError === -1) {
        firstGenericError = i;
      }
      continue;
    }

    if (lower.includes("error:") && firstErrorLike === -1) {
      firstErrorLike = i;
    }
  }

  const anchor =
    firstNonGenericError !== -1
      ? firstNonGenericError
      : firstStrongError !== -1
        ? firstStrongError
        : firstErrorLike !== -1
          ? firstErrorLike
          : firstGenericError !== -1
            ? firstGenericError
            : Math.max(stepStart, stepEnd - 1);

  const windowStart = Math.max(stepStart, anchor - 35);
  const windowEnd = Math.min(stepEnd, anchor + 45);

  const result: string[] = [];
  for (let i = windowStart; i < windowEnd; i++) {
    const line = lines[i];
    if (line.includes("##[group]") || line.includes("##[endgroup]")) continue;
    const sanitized = sanitizeLogLine(line);
    let stripped = stripTimestamp(sanitized);
    stripped = stripped.replace(/^##\[error\]\s*/, "").trimEnd();
    result.push(stripped);
  }

  while (result.length > 0 && result[0].trim().length === 0) result.shift();
  while (result.length > 0 && result[result.length - 1].trim().length === 0)
    result.pop();

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
    const remoteUrl = await getRemoteUrl(repoPath);
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) return [];
    const repoSlug = `${parsed.owner}/${parsed.repo}`;

    // Get head SHA from PR
    const prJson = await runGhCommand([
      "pr",
      "view",
      branchName,
      "--repo",
      repoSlug,
      "--json",
      "headRefOid",
    ]);
    const { headRefOid: sha } = JSON.parse(prJson);

    // Get failed workflow runs for this commit
    const runsEndpoint = `repos/${parsed.owner}/${parsed.repo}/actions/runs?head_sha=${sha}&status=failure`;
    const runsJson = await runGhCommand(["api", runsEndpoint]);
    const { workflow_runs: runs } = JSON.parse(runsJson);
    if (!runs || runs.length === 0) return [];

    // Get failed jobs across all failed runs in parallel
    const jobResults = await Promise.all(
      (runs as any[]).map(async (run: any) => {
        const jobsJson = await runGhCommand([
          "api",
          `repos/${parsed.owner}/${parsed.repo}/actions/runs/${run.id}/jobs`,
        ]);
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
            const rawLog = await runGhCommand([
              "api",
              `repos/${parsed.owner}/${parsed.repo}/actions/jobs/${job.id}/logs`,
            ]);
            log = extractFailedStepLog(rawLog, failedStep.name, failedStep);
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
    const ref = await runGitCommand(repoPath, [
      "-C",
      repoPath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
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
      await runGitCommand(repoPath, [
        "-C",
        repoPath,
        "log",
        `origin/${main}..HEAD`,
        "--pretty=format:%s%n%b",
      ])
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
      await runGitCommand(repoPath, [
        "-C",
        repoPath,
        "diff",
        "--stat",
        `origin/${main}..HEAD`,
      ])
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
  await runGitCommand(repoPath, ["-C", repoPath, "add", "."]);
  await runGitCommand(repoPath, ["-C", repoPath, "commit", "-m", message]);
}

/**
 * Push the current branch to origin, setting upstream.
 */
export async function pushBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  await runGitCommand(repoPath, [
    "-C",
    repoPath,
    "push",
    "-u",
    "origin",
    branchName,
  ]);
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
  const repoSlug = await getRepoSlugForPath(repoPath);
  if (!repoSlug) {
    throw new Error("Could not determine repo slug from origin remote.");
  }
  const branchName = await getCurrentBranch(repoPath);
  const baseBranch = await getMainBranch(repoPath);
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
    repoSlug,
    "--head",
    branchName,
    "--base",
    baseBranch,
    ...reviewerArgs,
  ];
  const result = await runGhCommand(allArgs);
  // gh pr create outputs the PR URL on the last line
  const url = result.trim().split("\n").pop()!.trim();
  const numMatch = url.match(/\/pull\/(\d+)/);
  return { number: numMatch ? parseInt(numMatch[1], 10) : 0, url };
}

/**
 * Get commits since a given timestamp for a repo path.
 */
export async function getCommitsSince(
  repoPath: string,
  sinceISO: string,
  options?: { author?: string },
): Promise<string> {
  try {
    const args = [
      "-C",
      repoPath,
      "log",
      "--all",
      `--since=${sinceISO}`,
      "--pretty=format:%h %s",
    ];
    const author = options?.author?.trim();
    if (author) {
      args.push(`--author=${author}`);
    }
    return (await runGitCommand(repoPath, args)).trim();
  } catch {
    return "";
  }
}

/**
 * Get commits since a given timestamp on a specific remote branch.
 * Works even if the worktree has been deleted — uses origin/<branch>.
 */
export async function getCommitsSinceOnBranch(
  repoPath: string,
  branch: string,
  sinceISO: string,
): Promise<string> {
  try {
    return (
      await runGitCommand(repoPath, [
        "-C",
        repoPath,
        "log",
        `origin/${branch}`,
        `--since=${sinceISO}`,
        "--pretty=format:%h %s",
      ])
    ).trim();
  } catch {
    return "";
  }
}

export interface MergedPr {
  number: number;
  title: string;
  body: string;
  headRefName: string;
}

export interface OpenedPr {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
  mergedAt: string | null;
}

/**
 * Get recently merged PRs since a given timestamp using gh CLI.
 */
export async function getMergedPrsSince(
  repoPath: string,
  sinceISO: string,
  options?: { author?: string },
): Promise<MergedPr[]> {
  try {
    const repoSlug = await getRepoSlugForPath(repoPath);
    if (!repoSlug) return [];
    const args = [
      "pr",
      "list",
      "--repo",
      repoSlug,
      "--state",
      "merged",
      "--search",
      `merged:>=${sinceISO.slice(0, 10)}`,
      "--json",
      "number,title,body,headRefName,mergedAt",
      "--limit",
      "50",
    ];
    const author = options?.author?.trim();
    if (author) {
      args.push("--author", author);
    }

    const raw = await runGhCommand(args);
    const prs = JSON.parse(raw);
    if (!Array.isArray(prs)) return [];
    const sinceMs = Date.parse(sinceISO);
    return prs
      .filter((pr: any) => {
        if (!Number.isFinite(sinceMs)) return true;
        const mergedMs = Date.parse(String(pr?.mergedAt || ""));
        if (!Number.isFinite(mergedMs)) return true;
        return mergedMs >= sinceMs;
      })
      .map((pr: any) => ({
        number: pr.number ?? 0,
        title: pr.title ?? "",
        body: pr.body ?? "",
        headRefName: pr.headRefName ?? "",
      }));
  } catch {
    return [];
  }
}

/**
 * Get PRs created in the time window (any state), optionally scoped to an author.
 */
export async function getPrsCreatedSince(
  repoPath: string,
  sinceISO: string,
  options?: { author?: string },
): Promise<OpenedPr[]> {
  try {
    const repoSlug = await getRepoSlugForPath(repoPath);
    if (!repoSlug) return [];
    const args = [
      "pr",
      "list",
      "--repo",
      repoSlug,
      "--state",
      "all",
      "--search",
      `created:>=${sinceISO.slice(0, 10)}`,
      "--json",
      "number,title,body,headRefName,state,createdAt,mergedAt",
      "--limit",
      "100",
    ];
    const author = options?.author?.trim();
    if (author) {
      args.push("--author", author);
    }

    const raw = await runGhCommand(args);
    const prs = JSON.parse(raw);
    if (!Array.isArray(prs)) return [];
    const sinceMs = Date.parse(sinceISO);
    return prs
      .filter((pr: any) => {
        if (!Number.isFinite(sinceMs)) return true;
        const createdMs = Date.parse(String(pr?.createdAt || ""));
        if (!Number.isFinite(createdMs)) return false;
        return createdMs >= sinceMs;
      })
      .map((pr: any) => ({
        number: pr.number ?? 0,
        title: pr.title ?? "",
        body: pr.body ?? "",
        headRefName: pr.headRefName ?? "",
        state: normalizePrState(String(pr?.state || "")),
        createdAt: pr.createdAt ?? "",
        mergedAt: pr.mergedAt ?? null,
      }));
  } catch {
    return [];
  }
}

export function formatPrStatus(pr: PrStatus): string {
  const state =
    pr.state === "open" ? "OPEN" : pr.state === "merged" ? "MERGED" : "CLOSED";
  const parts = [`PR #${pr.number} ${state}`];
  if (pr.hasConflicts) {
    parts.push("CONFLICTS");
  }
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
