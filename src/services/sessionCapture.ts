import { homedir } from "os";
import { join } from "path";
import {
  readdirSync,
  existsSync,
  statSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  cpSync,
} from "fs";

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
 * Copy a captured Claude session into the project dir for a new worktree path.
 * `claude --resume <id>` only looks in the project dir encoded from the current
 * cwd, so when gladius creates a fresh worktree (e.g. on reopen) the original
 * jsonl needs to be present there or Claude exits with "No session found".
 */
export function copyClaudeSessionToWorktree(
  oldWorktreePath: string,
  newWorktreePath: string,
  sessionId: string,
): boolean {
  if (!sessionId || !oldWorktreePath || !newWorktreePath) return false;
  if (oldWorktreePath === newWorktreePath) return true;

  const oldProjectDir = getClaudeProjectDir(oldWorktreePath);
  if (!oldProjectDir) return false;

  const oldJsonl = join(oldProjectDir, `${sessionId}.jsonl`);
  if (!existsSync(oldJsonl)) return false;

  const newProjectDir = join(
    homedir(),
    ".claude",
    "projects",
    encodeClaudeProjectPath(newWorktreePath),
  );

  try {
    mkdirSync(newProjectDir, { recursive: true });
    cpSync(oldJsonl, join(newProjectDir, `${sessionId}.jsonl`));

    // Tool results live in a sibling `<sessionId>/` directory; copy if present
    // so resumed sessions can re-render large outputs.
    const oldToolDir = join(oldProjectDir, sessionId);
    if (existsSync(oldToolDir) && statSync(oldToolDir).isDirectory()) {
      cpSync(oldToolDir, join(newProjectDir, sessionId), { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
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

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function readCodexSessionCwd(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const newline = content.indexOf("\n");
    const firstLine = newline === -1 ? content : content.slice(0, newline);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta") return null;
    const cwd = parsed?.payload?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * Watch for a new Codex session ID by polling ~/.codex/sessions/<year>/<month>/<day>/
 * for rollout-*-<uuid>.jsonl files. Only binds a session whose meta.cwd matches
 * the supplied workdir — codex stores all sessions globally, so without this
 * check a foreign codex run (e.g. Codex Desktop pointed at a different repo)
 * could be claimed by the wrong gladius task.
 */
export function watchForCodexSessionId(
  workdir: string,
  callback: (sessionId: string) => void,
): () => void {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const sessionsDir = join(homedir(), ".codex", "sessions", year, month, day);
  const expectedCwd = tryRealpath(workdir);

  // Files to ignore: those that existed before we started watching, or that
  // we've inspected and confirmed belong to a different cwd.
  const ignored = new Set<string>();
  try {
    if (existsSync(sessionsDir)) {
      for (const f of readdirSync(sessionsDir)) {
        if (f.endsWith(".jsonl")) ignored.add(f);
      }
    }
  } catch {}

  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    try {
      if (!existsSync(sessionsDir)) return;
      for (const f of readdirSync(sessionsDir)) {
        if (!f.endsWith(".jsonl") || ignored.has(f)) continue;

        const filePath = join(sessionsDir, f);
        const sessionCwd = readCodexSessionCwd(filePath);
        // Meta not yet flushed — leave it pending and retry on the next tick.
        if (!sessionCwd) continue;

        if (tryRealpath(sessionCwd) !== expectedCwd) {
          // Foreign session, never claim it.
          ignored.add(f);
          continue;
        }

        const match = f.match(/([0-9a-f-]{36})\.jsonl$/);
        const sessionId = match ? match[1] : f.replace(/\.jsonl$/, "");
        stopped = true;
        clearInterval(interval);
        callback(sessionId);
        return;
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
