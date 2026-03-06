import { homedir } from "os";
import { join } from "path";
import { readdirSync, existsSync, statSync } from "fs";

function encodeClaudeProjectPath(worktreePath: string): string {
  return worktreePath.replaceAll("/", "-").replaceAll(".", "-");
}

export interface ClaudeSessionInfo {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

export function getClaudeProjectDir(worktreePath: string): string | null {
  const encodedCandidates = [
    encodeClaudeProjectPath(worktreePath),
    worktreePath.replaceAll("/", "-"),
  ];
  const projectsRoot = join(homedir(), ".claude", "projects");

  return (
    encodedCandidates
      .map((encoded) => join(projectsRoot, encoded))
      .find((candidate) => existsSync(candidate)) ?? null
  );
}

/**
 * Find the most recently modified .jsonl file in a directory.
 * Returns the session info or null.
 */
function findMostRecentSession(dir: string): ClaudeSessionInfo | null {
  try {
    if (!existsSync(dir)) return null;
    let newest: ClaudeSessionInfo | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const filePath = join(dir, f);
      const mtimeMs = statSync(filePath).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = {
          sessionId: f.replace(/\.jsonl$/, ""),
          filePath,
          mtimeMs,
        };
      }
    }
    return newest;
  } catch {
    return null;
  }
}

export function getLatestClaudeSession(
  worktreePath: string,
): ClaudeSessionInfo | null {
  const claudeProjectDir = getClaudeProjectDir(worktreePath);
  if (!claudeProjectDir) return null;
  return findMostRecentSession(claudeProjectDir);
}

/**
 * Watch for a new Claude session ID by polling ~/.claude/projects/<encoded-path>/
 * for new .jsonl files that appear after we start watching.
 * Also checks for existing sessions on first call (handles missed captures).
 */
export function watchForClaudeSessionId(
  worktreePath: string,
  callback: (sessionId: string) => void,
  backfillExisting = false,
): () => void {
  const encodedCandidates = [
    encodeClaudeProjectPath(worktreePath),
    worktreePath.replaceAll("/", "-"),
  ];
  const projectsRoot = join(homedir(), ".claude", "projects");
  const claudeProjectDir =
    getClaudeProjectDir(worktreePath) ??
    join(projectsRoot, encodedCandidates[0]);

  // If backfilling, immediately return the most recent existing session
  if (backfillExisting) {
    const existing = findMostRecentSession(claudeProjectDir);
    if (existing) {
      // Use setTimeout to allow cleanup ref to be set before callback fires
      setTimeout(() => callback(existing.sessionId), 0);
      return () => {};
    }
  }

  // Snapshot existing files
  const existingFiles = new Set<string>();
  try {
    if (existsSync(claudeProjectDir)) {
      for (const f of readdirSync(claudeProjectDir)) {
        if (f.endsWith(".jsonl")) existingFiles.add(f);
      }
    }
  } catch {}

  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    try {
      if (!existsSync(claudeProjectDir)) return;
      for (const f of readdirSync(claudeProjectDir)) {
        if (f.endsWith(".jsonl") && !existingFiles.has(f)) {
          const sessionId = f.replace(/\.jsonl$/, "");
          stopped = true;
          clearInterval(interval);
          callback(sessionId);
          return;
        }
      }
    } catch {}
  }, 2000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/**
 * Watch for a new Codex session ID by polling ~/.codex/sessions/<year>/<month>/<day>/
 * for rollout-*-<uuid>.jsonl files.
 */
export function watchForCodexSessionId(
  callback: (sessionId: string) => void,
): () => void {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const sessionsDir = join(homedir(), ".codex", "sessions", year, month, day);

  // Snapshot existing files
  const existingFiles = new Set<string>();
  try {
    if (existsSync(sessionsDir)) {
      for (const f of readdirSync(sessionsDir)) {
        if (f.endsWith(".jsonl")) existingFiles.add(f);
      }
    }
  } catch {}

  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    try {
      if (!existsSync(sessionsDir)) return;
      for (const f of readdirSync(sessionsDir)) {
        if (f.endsWith(".jsonl") && !existingFiles.has(f)) {
          // Extract UUID from rollout-*-<uuid>.jsonl
          const match = f.match(/([0-9a-f-]{36})\.jsonl$/);
          const sessionId = match ? match[1] : f.replace(/\.jsonl$/, "");
          stopped = true;
          clearInterval(interval);
          callback(sessionId);
          return;
        }
      }
    } catch {}
  }, 2000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/**
 * Build the command array to spawn an LLM CLI, optionally resuming a prior session.
 */
export function buildLlmCommand(
  model: "claude" | "codex",
  sessionId?: string | null,
  cwd?: string,
): string[] {
  if (model === "claude") {
    if (sessionId) return ["claude", "--resume", sessionId];
    return ["claude"];
  }
  // codex — needs explicit -C <dir> to set working root
  const base = cwd ? ["codex", "-C", cwd] : ["codex"];
  if (sessionId) return ["codex", "resume", sessionId];
  return base;
}
