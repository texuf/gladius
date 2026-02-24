import { homedir } from "os";
import { join } from "path";
import { readdirSync, existsSync } from "fs";

/**
 * Watch for a new Claude session ID by polling ~/.claude/projects/<encoded-path>/
 * for new .jsonl files that appear after we start watching.
 */
export function watchForClaudeSessionId(
  worktreePath: string,
  callback: (sessionId: string) => void
): () => void {
  // Claude encodes project paths by replacing / with -
  const encoded = worktreePath.replaceAll("/", "-");
  const claudeProjectDir = join(homedir(), ".claude", "projects", encoded);

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
  callback: (sessionId: string) => void
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
  cwd?: string
): string[] {
  if (model === "claude") {
    return sessionId ? ["claude", "--resume", sessionId] : ["claude"];
  }
  // codex — needs explicit -C <dir> to set working root
  const base = cwd ? ["codex", "-C", cwd] : ["codex"];
  return sessionId ? ["codex", "resume", sessionId] : base;
}
