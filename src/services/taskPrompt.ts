import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Task } from "../store/types.js";

type PromptSource = "claude" | "codex";

export interface TaskPrompt {
  text: string;
  timestamp: string;
  source: PromptSource;
}

const filePromptCache = new Map<string, { mtimeMs: number; prompt: TaskPrompt | null }>();
const codexSessionPathCache = new Map<string, string | null>();

function encodeClaudeProjectPath(worktreePath: string): string {
  // Claude project folder names replace path separators and dot-prefixed segments.
  return worktreePath.replaceAll("/", "-").replaceAll(".", "-");
}

function safeParseJson(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function safeListDirs(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter((entry) => {
      try {
        return statSync(join(dirPath, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function safeListFiles(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter((entry) => {
      try {
        return statSync(join(dirPath, entry)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function toTimestampMs(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function sanitizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractClaudeMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const text = sanitizePromptText(content);
    return text || null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const typedItem = item as Record<string, unknown>;
    if (typedItem.type === "tool_result") continue;

    const text =
      typeof typedItem.text === "string"
        ? typedItem.text
        : typeof typedItem.content === "string"
          ? typedItem.content
          : "";
    const cleaned = sanitizePromptText(text);
    if (cleaned) parts.push(cleaned);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractCodexMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const text = sanitizePromptText(content);
    return text || null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const typedItem = item as Record<string, unknown>;
    const type = String(typedItem.type || "");
    const text = typeof typedItem.text === "string" ? typedItem.text : "";
    const cleaned = sanitizePromptText(text);
    if (!cleaned) continue;
    if (type === "input_text" || type === "text") {
      parts.push(cleaned);
      continue;
    }
    // Some clients emit user message segments with text but without input_text.
    if (text) parts.push(cleaned);
  }

  // Skip framework scaffolding when there is a real user prompt in the same message.
  const userFacing = parts.filter(
    (part) =>
      !part.startsWith("# AGENTS.md instructions") &&
      !part.startsWith("<environment_context>"),
  );
  const selected = userFacing.length > 0 ? userFacing : parts;
  return selected.length > 0 ? selected.join(" ") : null;
}

function parseClaudePromptFile(filePath: string): TaskPrompt | null {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  let latest: TaskPrompt | null = null;
  let latestMs = 0;

  for (const line of lines) {
    if (!line) continue;
    const record = safeParseJson(line);
    if (!record || record.type !== "user") continue;
    if (record?.message?.role !== "user") continue;

    const text = extractClaudeMessageText(record.message.content);
    if (!text) continue;

    const timestamp = String(record.timestamp || "");
    const timestampMs = toTimestampMs(timestamp);
    if (timestampMs >= latestMs) {
      latest = { text, timestamp, source: "claude" };
      latestMs = timestampMs;
    }
  }
  return latest;
}

function parseCodexPromptFile(filePath: string): TaskPrompt | null {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  let latest: TaskPrompt | null = null;
  let latestMs = 0;

  for (const line of lines) {
    if (!line) continue;
    const record = safeParseJson(line);
    if (!record || record.type !== "response_item") continue;
    const payload = record.payload;
    if (!payload || payload.type !== "message" || payload.role !== "user") continue;

    const text = extractCodexMessageText(payload.content);
    if (!text) continue;

    const timestamp = String(record.timestamp || "");
    const timestampMs = toTimestampMs(timestamp);
    if (timestampMs >= latestMs) {
      latest = { text, timestamp, source: "codex" };
      latestMs = timestampMs;
    }
  }
  return latest;
}

function parsePromptFileCached(
  filePath: string,
  parser: (path: string) => TaskPrompt | null,
): TaskPrompt | null {
  try {
    const stats = statSync(filePath);
    const cached = filePromptCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.prompt;
    }
    const prompt = parser(filePath);
    filePromptCache.set(filePath, { mtimeMs: stats.mtimeMs, prompt });
    return prompt;
  } catch {
    return null;
  }
}

function findLatestClaudeSessionFile(worktreePath: string): string | null {
  const encodedCandidates = [
    encodeClaudeProjectPath(worktreePath),
    worktreePath.replaceAll("/", "-"),
  ];

  const projectDir = encodedCandidates
    .map((encodedPath) => join(homedir(), ".claude", "projects", encodedPath))
    .find((dir) => existsSync(dir));
  if (!projectDir) return null;

  let latestFile: string | null = null;
  let latestMtime = 0;

  for (const fileName of readdirSync(projectDir)) {
    if (!fileName.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, fileName);
    try {
      const mtime = statSync(filePath).mtimeMs;
      if (mtime >= latestMtime) {
        latestMtime = mtime;
        latestFile = filePath;
      }
    } catch {}
  }
  return latestFile;
}

function resolveClaudeSessionFile(task: Task): string | null {
  if (!task.worktree_path) return null;
  const encodedCandidates = [
    encodeClaudeProjectPath(task.worktree_path),
    task.worktree_path.replaceAll("/", "-"),
  ];
  const projectDir = encodedCandidates
    .map((encodedPath) => join(homedir(), ".claude", "projects", encodedPath))
    .find((dir) => existsSync(dir));
  if (!projectDir) return null;

  if (task.claude_session_id) {
    const directPath = join(projectDir, `${task.claude_session_id}.jsonl`);
    if (existsSync(directPath)) return directPath;
  }
  return findLatestClaudeSessionFile(task.worktree_path);
}

function resolveCodexSessionFile(task: Task): string | null {
  const sessionId = task.codex_session_id;
  if (!sessionId) return null;

  if (codexSessionPathCache.has(sessionId)) {
    const cached = codexSessionPathCache.get(sessionId) ?? null;
    if (!cached) return null;
    if (existsSync(cached)) return cached;
    codexSessionPathCache.delete(sessionId);
  }

  const sessionsRoot = join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsRoot)) return null;

  for (const year of safeListDirs(sessionsRoot)) {
    const yearPath = join(sessionsRoot, year);
    for (const month of safeListDirs(yearPath)) {
      const monthPath = join(yearPath, month);
      for (const day of safeListDirs(monthPath)) {
        const dayPath = join(monthPath, day);
        for (const fileName of safeListFiles(dayPath)) {
          if (!fileName.endsWith(".jsonl")) continue;
          if (!fileName.includes(sessionId)) continue;
          const filePath = join(dayPath, fileName);
          codexSessionPathCache.set(sessionId, filePath);
          return filePath;
        }
      }
    }
  }

  codexSessionPathCache.set(sessionId, null);
  return null;
}

export function getLatestTaskPrompt(task: Task): TaskPrompt | null {
  const candidates: TaskPrompt[] = [];

  const claudeFile = resolveClaudeSessionFile(task);
  if (claudeFile) {
    const prompt = parsePromptFileCached(claudeFile, parseClaudePromptFile);
    if (prompt) candidates.push(prompt);
  }

  const codexFile = resolveCodexSessionFile(task);
  if (codexFile) {
    const prompt = parsePromptFileCached(codexFile, parseCodexPromptFile);
    if (prompt) candidates.push(prompt);
  }

  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp),
  );
  return candidates[candidates.length - 1];
}
