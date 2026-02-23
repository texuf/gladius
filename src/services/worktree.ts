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
  label: string
): Promise<string> {
  const branchName = `${BRANCH_PREFIX}/${label}`;
  const projectName = basename(projectPath);
  const worktreeDir = join(homedir(), ".gladius", "worktrees", projectName);
  const worktreePath = join(worktreeDir, label);

  // Ensure worktree directory exists
  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true });
  }

  // Create worktree — reuse existing branch or create new one
  const branchExists = await $`git -C ${projectPath} rev-parse --verify ${branchName}`.quiet().then(() => true, () => false);
  if (branchExists) {
    await $`git -C ${projectPath} worktree add ${worktreePath} ${branchName}`;
  } else {
    await $`git -C ${projectPath} worktree add ${worktreePath} -b ${branchName}`;
  }

  // Copy .env files
  copyEnvFiles(projectPath, worktreePath);

  return worktreePath;
}

/**
 * Delete a git worktree.
 */
export async function deleteWorktree(
  projectPath: string,
  worktreePath: string
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
}

/**
 * Recursively find and copy .env* files from source to destination,
 * maintaining relative paths.
 */
function copyEnvFiles(src: string, dest: string) {
  const files = findEnvFiles(src);
  for (const file of files) {
    const relativePath = file.slice(src.length);
    const destPath = join(dest, relativePath);
    const destDir = destPath.slice(0, destPath.lastIndexOf("/"));
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    try {
      copyFileSync(file, destPath);
    } catch {
      // Skip files we can't copy
    }
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
