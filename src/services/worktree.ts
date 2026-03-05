import { $ } from "bun";
import { join, basename } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "fs";
import { BRANCH_PREFIX } from "../utils/constants.js";

/**
 * Create a git worktree for a task.
 * @param projectPath - Absolute path to the project root
 * @param label - Task label (used for branch and worktree dir name)
 * @returns The absolute path to the worktree directory
 */
export async function createWorktree(
  projectPath: string,
  label: string,
): Promise<string> {
  const branchName = `${BRANCH_PREFIX}/${label}`;
  const projectName = basename(projectPath);
  const worktreeDir = join(homedir(), ".wt", projectName);
  const worktreePath = join(worktreeDir, label);

  // Ensure worktree directory exists
  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true });
  }

  // Fetch latest and resolve main branch
  await $`git -C ${projectPath} fetch origin`.quiet().nothrow();
  const mainBranch =
    await $`git -C ${projectPath} symbolic-ref refs/remotes/origin/HEAD`
      .quiet()
      .text()
      .then((ref) => ref.trim().replace("refs/remotes/origin/", ""))
      .catch(() => "main");

  // Create worktree — reuse existing branch or create new from origin/main
  const branchExists =
    await $`git -C ${projectPath} rev-parse --verify ${branchName}`
      .quiet()
      .then(
        () => true,
        () => false,
      );
  if (branchExists) {
    await $`git -C ${projectPath} worktree add ${worktreePath} ${branchName}`;
  } else {
    await $`git -C ${projectPath} worktree add ${worktreePath} -b ${branchName} origin/${mainBranch}`;
  }

  // Copy .env files that are gitignored (secrets only, not tracked .env.example etc.)
  await copyIgnoredEnvFiles(projectPath, worktreePath);

  return worktreePath;
}

/**
 * Adopt an existing remote branch into a new worktree.
 * Unlike createWorktree, this checks out the remote branch directly
 * instead of creating a new branch from origin/main.
 */
export async function adoptBranch(
  projectPath: string,
  remoteBranch: string,
  label: string,
): Promise<string> {
  const projectName = basename(projectPath);
  const worktreeDir = join(homedir(), ".wt", projectName);
  const worktreePath = join(worktreeDir, label);

  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true });
  }

  await $`git -C ${projectPath} fetch origin`.quiet().nothrow();

  const localExists =
    await $`git -C ${projectPath} rev-parse --verify ${remoteBranch}`
      .quiet()
      .then(
        () => true,
        () => false,
      );

  if (localExists) {
    await $`git -C ${projectPath} worktree add ${worktreePath} ${remoteBranch}`;
  } else {
    await $`git -C ${projectPath} worktree add ${worktreePath} -b ${remoteBranch} origin/${remoteBranch}`;
  }

  await copyIgnoredEnvFiles(projectPath, worktreePath);
  return worktreePath;
}

/**
 * Delete a git worktree.
 */
export async function deleteWorktree(
  projectPath: string,
  worktreePath: string,
  branchName?: string | null,
): Promise<void> {
  try {
    await $`git -C ${projectPath} worktree remove ${worktreePath} --force`;
  } catch {
    // Worktree may already be gone
  }
  try {
    await $`git -C ${projectPath} worktree prune`;
  } catch {
    // Ignore prune errors
  }
  if (branchName) {
    try {
      await $`git -C ${projectPath} branch -D ${branchName}`;
    } catch {
      // Branch may already be gone
    }
  }
}

/**
 * Copy .env* files that are gitignored from source to destination,
 * maintaining relative paths. Tracked files (e.g. .env.example) are skipped.
 */
async function copyIgnoredEnvFiles(src: string, dest: string) {
  const files = findEnvFiles(src);
  if (files.length === 0) return;

  // Ask git which of these files are ignored
  const relativePaths = files.map((f) => f.slice(src.length + 1));
  try {
    const result = await $`git -C ${src} check-ignore ${relativePaths}`
      .quiet()
      .nothrow()
      .text();
    const ignored = new Set(result.trim().split("\n").filter(Boolean));

    for (const rel of relativePaths) {
      if (!ignored.has(rel)) continue;
      const srcPath = join(src, rel);
      const destPath = join(dest, rel);
      const destDir = destPath.slice(0, destPath.lastIndexOf("/"));
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }
      try {
        copyFileSync(srcPath, destPath);
      } catch {
        // Skip files we can't copy
      }
    }
  } catch {
    // If git check-ignore fails, skip copying entirely
  }
}

/**
 * Find all .env* files in a directory (non-recursive into node_modules, .git, worktrees).
 */
function findEnvFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return []; // Don't go too deep

  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip directories we don't want to traverse
      if (
        entry === "node_modules" ||
        entry === ".git" ||
        entry === ".gladius" ||
        entry === "dist" ||
        entry === "build"
      ) {
        continue;
      }

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && entry.startsWith(".env")) {
          results.push(fullPath);
        } else if (stat.isDirectory()) {
          results.push(...findEnvFiles(fullPath, depth + 1));
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return results;
}
