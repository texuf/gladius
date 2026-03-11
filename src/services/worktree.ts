import { basename, dirname, join, posix as posixPath } from "path";
import { homedir } from "os";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { spawnSync } from "child_process";
import type { Repo } from "../store/types.js";
import {
  quoteShell,
  resolveProjectBackend,
  runBackendCommand,
} from "./projectBackend.js";
import { BRANCH_PREFIX } from "../utils/constants.js";

type RepoBackendContext = Pick<
  Repo,
  | "path"
  | "name"
  | "project_backend_kind"
  | "project_backend_target"
  | "project_backend_base_path"
  | "project_backend_display_name"
  | "project_path"
  | "project_name"
>;

function resolveRepoBackend(repo: RepoBackendContext) {
  return resolveProjectBackend({
    backend_kind: repo.project_backend_kind,
    backend_target: repo.project_backend_target,
    backend_base_path: repo.project_backend_base_path,
    backend_display_name: repo.project_backend_display_name,
    path: repo.project_path,
    name: repo.project_name,
  });
}

function getLocalWorktreePath(repoPath: string, label: string): string {
  return join(homedir(), ".wt", basename(repoPath), label);
}

function getRemoteWorktreePathScript(repoPath: string, label: string): string {
  const repoName = posixPath.basename(repoPath);
  return [
    `worktree_dir="$HOME/.wt/${repoName}"`,
    `mkdir -p "$worktree_dir"`,
    `worktree_path="$worktree_dir/${label}"`,
    `printf '%s\\n' "$worktree_path"`,
  ].join("; ");
}

function requireSuccess(stderr: string, stdout: string, exitCode: number, fallback: string): void {
  if (exitCode === 0) return;
  const detail = (stderr || stdout).trim();
  throw new Error(detail || fallback);
}

function copyIgnoredEnvFiles(repo: RepoBackendContext, worktreePath: string): void {
  const backend = resolveRepoBackend(repo);
  if (backend.kind === "local") {
    copyIgnoredLocalEnvFiles(repo.path, worktreePath);
    return;
  }

  const command = [
    "find . \\(",
    "-path './node_modules' -o",
    "-path './.git' -o",
    "-path './.gladius' -o",
    "-path './dist' -o",
    "-path './build'",
    "\\) -prune -o -type f -name '.env*' -print |",
    "while IFS= read -r rel; do",
    '  rel="${rel#./}"',
    '  [ -n "$rel" ] || continue',
    `  if git check-ignore "$rel" >/dev/null 2>&1; then`,
    `    mkdir -p ${quoteShell(worktreePath)}/"$(dirname "$rel")"`,
    `    cp "$rel" ${quoteShell(worktreePath)}/"$rel"`,
    "  fi",
    "done",
  ].join(" ");
  const result = runBackendCommand(backend, command, { cwd: repo.path });
  requireSuccess(
    result.stderr,
    result.stdout,
    result.exitCode,
    "Failed to copy ignored .env files.",
  );
}

function copyIgnoredLocalEnvFiles(repoPath: string, worktreePath: string): void {
  const envFiles = findEnvFiles(repoPath);
  if (envFiles.length === 0) return;

  const relativePaths = envFiles.map((filePath) => filePath.slice(repoPath.length + 1));
  const ignoredPaths = getIgnoredPaths(repoPath, relativePaths);

  for (const relativePath of relativePaths) {
    if (!ignoredPaths.has(relativePath)) continue;

    const sourcePath = join(repoPath, relativePath);
    const destinationPath = join(worktreePath, relativePath);
    const destinationDir = dirname(destinationPath);
    if (!existsSync(destinationDir)) {
      mkdirSync(destinationDir, { recursive: true });
    }
    copyFileSync(sourcePath, destinationPath);
  }
}

function getIgnoredPaths(repoPath: string, relativePaths: string[]): Set<string> {
  if (relativePaths.length === 0) return new Set<string>();

  const result = spawnSync(
    "git",
    ["-C", repoPath, "check-ignore", "--stdin"],
    {
      input: relativePaths.join("\n"),
      encoding: "utf8",
    },
  );

  const exitCode = result.status ?? 1;
  if (exitCode > 1) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || "Failed to determine ignored .env files.");
  }

  return new Set(
    (result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function findEnvFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return [];

  const results: string[] = [];
  let entries:
    | Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    | null = null;

  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    entries = null;
  }
  if (!entries) return results;

  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".gladius" ||
      entry.name === "dist" ||
      entry.name === "build"
    ) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    try {
      const stats = statSync(fullPath);
      if (stats.isFile() && entry.name.startsWith(".env")) {
        results.push(fullPath);
      } else if (stats.isDirectory()) {
        results.push(...findEnvFiles(fullPath, depth + 1));
      }
    } catch {
      continue;
    }
  }

  return results;
}

function createOrAttachWorktree(
  repo: RepoBackendContext,
  label: string,
  branchName: string,
  mode: "new" | "adopt",
): string {
  const backend = resolveRepoBackend(repo);
  const worktreePath =
    backend.kind === "ssh"
      ? (() => {
          const result = runBackendCommand(
            backend,
            getRemoteWorktreePathScript(repo.path, label),
            { cwd: repo.path },
          );
          requireSuccess(
            result.stderr,
            result.stdout,
            result.exitCode,
            "Failed to prepare remote worktree directory.",
          );
          return result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
        })()
      : getLocalWorktreePath(repo.path, label);

  if (!worktreePath) {
    throw new Error("Failed to resolve worktree path.");
  }
  if (backend.kind === "local") {
    const worktreeDir = dirname(worktreePath);
    if (!existsSync(worktreeDir)) {
      mkdirSync(worktreeDir, { recursive: true });
    }
  }

  const command =
    mode === "new"
      ? [
          "git fetch origin >/dev/null 2>&1 || true",
          "main_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's#refs/remotes/origin/##')",
          'if [ -z "$main_branch" ]; then',
          '  if git rev-parse --verify origin/main >/dev/null 2>&1; then',
          '    main_branch=main',
          '  elif git rev-parse --verify origin/master >/dev/null 2>&1; then',
          '    main_branch=master',
          "  fi",
          "fi",
          '[ -n "$main_branch" ] || { echo "Could not determine default branch from origin/HEAD, origin/main, or origin/master." >&2; exit 1; }',
          `if git rev-parse --verify ${quoteShell(branchName)} >/dev/null 2>&1; then`,
          `  git worktree add ${quoteShell(worktreePath)} ${quoteShell(branchName)}`,
          "else",
          `  git worktree add ${quoteShell(worktreePath)} -b ${quoteShell(branchName)} origin/"$main_branch"`,
          "fi",
        ].join("\n")
      : [
          "git fetch origin >/dev/null 2>&1 || true",
          `if git rev-parse --verify ${quoteShell(branchName)} >/dev/null 2>&1; then`,
          `  git worktree add ${quoteShell(worktreePath)} ${quoteShell(branchName)}`,
          "else",
          `  git worktree add ${quoteShell(worktreePath)} -b ${quoteShell(branchName)} ${quoteShell(`origin/${branchName}`)}`,
          "fi",
        ].join("\n");

  const result = runBackendCommand(backend, command, { cwd: repo.path });
  requireSuccess(
    result.stderr,
    result.stdout,
    result.exitCode,
    "Failed to create git worktree.",
  );

  copyIgnoredEnvFiles(repo, worktreePath);
  return worktreePath;
}

export async function createWorktree(
  repo: RepoBackendContext,
  label: string,
): Promise<string> {
  const branchName = `${BRANCH_PREFIX}/${label}`;
  return createOrAttachWorktree(repo, label, branchName, "new");
}

export async function adoptBranch(
  repo: RepoBackendContext,
  remoteBranch: string,
  label: string,
): Promise<string> {
  return createOrAttachWorktree(repo, label, remoteBranch, "adopt");
}

export async function deleteWorktree(
  repo: RepoBackendContext,
  worktreePath: string,
  branchName?: string | null,
): Promise<void> {
  const backend = resolveRepoBackend(repo);
  const command = [
    `git worktree remove ${quoteShell(worktreePath)} --force >/dev/null 2>&1 || true`,
    "git worktree prune >/dev/null 2>&1 || true",
    branchName
      ? `git branch -D ${quoteShell(branchName)} >/dev/null 2>&1 || true`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  runBackendCommand(backend, command, { cwd: repo.path });
}
