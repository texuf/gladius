import { basename, dirname, join, posix as posixPath } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
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
    `    cp "$rel" ${quoteShell(worktreePath)}/"$rel" 2>/dev/null || true`,
    "  fi",
    "done",
  ].join(" ");
  runBackendCommand(backend, command, { cwd: repo.path });
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
          '[ -n "$main_branch" ] || main_branch=main',
          `if git rev-parse --verify ${quoteShell(branchName)} >/dev/null 2>&1; then`,
          `  git worktree add ${quoteShell(worktreePath)} ${quoteShell(branchName)}`,
          "else",
          `  git worktree add ${quoteShell(worktreePath)} -b ${quoteShell(branchName)} origin/"$main_branch"`,
          "fi",
        ].join("; ")
      : [
          "git fetch origin >/dev/null 2>&1 || true",
          `if git rev-parse --verify ${quoteShell(branchName)} >/dev/null 2>&1; then`,
          `  git worktree add ${quoteShell(worktreePath)} ${quoteShell(branchName)}`,
          "else",
          `  git worktree add ${quoteShell(worktreePath)} -b ${quoteShell(branchName)} ${quoteShell(`origin/${branchName}`)}`,
          "fi",
        ].join("; ");

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
