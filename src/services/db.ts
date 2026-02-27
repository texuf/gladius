import { Database } from "bun:sqlite";
import { v4 as uuid } from "uuid";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import type { Project, Repo, Task, TaskEvent } from "../store/types.js";

const GLADIUS_DIR = join(homedir(), ".gladius");
const DB_PATH = join(GLADIUS_DIR, "gladius.db");

let db: Database;

export function getDb(): Database {
  if (db) return db;

  if (!existsSync(GLADIUS_DIR)) {
    mkdirSync(GLADIUS_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema();
  return db;
}

function initSchema() {
  // Keep legacy bootstrap DDL so brand-new installs and historical DBs both
  // pass through the same migration pipeline to the current schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      group_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      claude_session_id TEXT,
      codex_session_id TEXT,
      session_id TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  migrateSchema();
}

function hasTable(tableName: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  return !!row;
}

function hasColumn(tableName: string, columnName: string): boolean {
  if (!hasTable(tableName)) return false;
  const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function uniqueProjectName(baseName: string, taken: Set<string>): string {
  const base = baseName.trim() || "default";
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  let index = 2;
  let candidate = `${base}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  taken.add(candidate);
  return candidate;
}

function migrateLegacyProjectModel(): void {
  const hasLegacyProjectsTable = hasTable("projects") && hasColumn("projects", "path");
  const hasLegacyTasksProjectId = hasTable("tasks") && hasColumn("tasks", "project_id");

  if (!hasLegacyProjectsTable || !hasLegacyTasksProjectId) {
    return;
  }

  const hasClaudeSessionColumn = hasColumn("tasks", "claude_session_id");
  const hasCodexSessionColumn = hasColumn("tasks", "codex_session_id");
  const hasLegacySessionColumn = hasColumn("tasks", "session_id");

  if (!hasClaudeSessionColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN claude_session_id TEXT;");
  }
  if (!hasCodexSessionColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN codex_session_id TEXT;");
  }
  if (!hasLegacySessionColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT;");
  }

  const legacyRepos = db
    .query(
      "SELECT id, name, path, group_name, created_at, last_accessed_at FROM projects",
    )
    .all() as Array<{
    id: string;
    name: string;
    path: string;
    group_name: string | null;
    created_at: string;
    last_accessed_at: string;
  }>;

  const projectIdByPath = new Map<string, string>();
  const projectRows: Project[] = [];
  const takenProjectNames = new Set<string>();

  for (const repo of legacyRepos) {
    const projectPath = deriveProjectPath(repo.path);
    if (projectIdByPath.has(projectPath)) continue;

    const projectName = uniqueProjectName(
      repo.group_name?.trim() || deriveProjectName(projectPath),
      takenProjectNames,
    );

    const id = uuid();
    projectIdByPath.set(projectPath, id);
    projectRows.push({
      id,
      name: projectName,
      path: projectPath,
      created_at: repo.created_at,
      last_accessed_at: repo.last_accessed_at,
    });
  }

  if (projectRows.length === 0) {
    const now = new Date().toISOString();
    const fallbackPath = join(homedir(), "default");
    projectRows.push({
      id: uuid(),
      name: "default",
      path: fallbackPath,
      created_at: now,
      last_accessed_at: now,
    });
    projectIdByPath.set(fallbackPath, projectRows[0].id);
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN TRANSACTION;");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks_new (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        model TEXT,
        claude_session_id TEXT,
        codex_session_id TEXT,
        session_id TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);

    const insertProject = db.query(
      "INSERT INTO projects_new (id, name, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const project of projectRows) {
      insertProject.run(
        project.id,
        project.name,
        project.path,
        project.created_at,
        project.last_accessed_at,
      );
    }

    const insertRepo = db.query(
      "INSERT INTO repos (id, name, path, project_id, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const repo of legacyRepos) {
      const projectPath = deriveProjectPath(repo.path);
      const projectId =
        projectIdByPath.get(projectPath) ||
        projectRows[0].id;
      insertRepo.run(
        repo.id,
        repo.name,
        repo.path,
        projectId,
        repo.created_at,
        repo.last_accessed_at,
      );
    }

    db.exec(`
      INSERT INTO tasks_new (
        id, repo_id, label, description, status, model,
        claude_session_id, codex_session_id, session_id,
        worktree_path, branch_name, sort_order,
        created_at, last_accessed_at, closed_at
      )
      SELECT
        id, project_id, label, description, status, model,
        claude_session_id, codex_session_id, session_id,
        worktree_path, branch_name, sort_order,
        created_at, last_accessed_at, closed_at
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
    `);

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function migrateSchema() {
  migrateLegacyProjectModel();

  if (!hasTable("projects")) {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
    `);
  }

  if (!hasTable("repos")) {
    db.exec(`
      CREATE TABLE repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
    `);
  }

  if (!hasColumn("projects", "path")) {
    db.exec("ALTER TABLE projects ADD COLUMN path TEXT;");
  }

  const projectsMissingPath = db
    .query(
      "SELECT id, name FROM projects WHERE path IS NULL OR TRIM(path) = '' ORDER BY created_at ASC",
    )
    .all() as Array<{ id: string; name: string }>;
  if (projectsMissingPath.length > 0) {
    const repoRows = db
      .query("SELECT project_id, path FROM repos ORDER BY last_accessed_at DESC")
      .all() as Array<{ project_id: string; path: string }>;
    const projectPathFromRepos = new Map<string, string>();
    for (const row of repoRows) {
      if (!projectPathFromRepos.has(row.project_id)) {
        projectPathFromRepos.set(row.project_id, deriveProjectPath(row.path));
      }
    }

    const takenPaths = new Set(
      (
        db
          .query(
            "SELECT path FROM projects WHERE path IS NOT NULL AND TRIM(path) <> ''",
          )
          .all() as Array<{ path: string }>
      ).map((row) => normalizePath(row.path)),
    );

    const updatePath = db.query("UPDATE projects SET path = ? WHERE id = ?");
    for (const project of projectsMissingPath) {
      const preferred =
        projectPathFromRepos.get(project.id) ||
        join(homedir(), project.name || "default");

      let candidate = normalizePath(preferred);
      if (takenPaths.has(candidate)) {
        let index = 2;
        let next = `${candidate}-${index}`;
        while (takenPaths.has(next)) {
          index += 1;
          next = `${candidate}-${index}`;
        }
        candidate = next;
      }
      takenPaths.add(candidate);
      updatePath.run(candidate, project.id);
    }
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path);",
  );

  if (!hasTable("tasks")) {
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        model TEXT,
        claude_session_id TEXT,
        codex_session_id TEXT,
        session_id TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);
  }

  if (hasColumn("tasks", "project_id") && !hasColumn("tasks", "repo_id")) {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN TRANSACTION;");
    try {
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL REFERENCES repos(id),
          label TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          model TEXT,
          claude_session_id TEXT,
          codex_session_id TEXT,
          session_id TEXT,
          worktree_path TEXT,
          branch_name TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          closed_at TEXT
        );

        INSERT INTO tasks_new (
          id, repo_id, label, description, status, model,
          claude_session_id, codex_session_id, session_id,
          worktree_path, branch_name, sort_order,
          created_at, last_accessed_at, closed_at
        )
        SELECT
          id, project_id, label, description, status, model,
          claude_session_id, codex_session_id, session_id,
          worktree_path, branch_name, sort_order,
          created_at, last_accessed_at, closed_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
      `);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  if (!hasColumn("tasks", "claude_session_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN claude_session_id TEXT;");
  }
  if (!hasColumn("tasks", "codex_session_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN codex_session_id TEXT;");
  }
  if (!hasColumn("tasks", "session_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT;");
  }

  db.exec(`
    UPDATE tasks
    SET claude_session_id = session_id
    WHERE model = 'claude'
      AND session_id IS NOT NULL
      AND claude_session_id IS NULL;

    UPDATE tasks
    SET codex_session_id = session_id
    WHERE model = 'codex'
      AND session_id IS NOT NULL
      AND codex_session_id IS NULL;
  `);

  // In case repos were created without project bindings, assign a default.
  const orphaned = db
    .query("SELECT id, path FROM repos WHERE project_id IS NULL OR project_id = ''")
    .all() as Array<{ id: string; path: string }>;
  if (orphaned.length > 0) {
    const defaultProject = resolveProjectByPath(join(homedir(), "default"), "default");

    const updateRepoProject = db.query(
      "UPDATE repos SET project_id = ? WHERE id = ?",
    );
    for (const repo of orphaned) {
      updateRepoProject.run(defaultProject.id, repo.id);
    }
  }

  // Migrate app_state keys from project-based naming to repo-based naming.
  const navRepo = db
    .query("SELECT value FROM app_state WHERE key = 'nav.repo_id'")
    .get() as { value: string | null } | null;
  const navProject = db
    .query("SELECT value FROM app_state WHERE key = 'nav.project_id'")
    .get() as { value: string | null } | null;
  if ((!navRepo || !navRepo.value) && navProject?.value) {
    const repoExists = db
      .query("SELECT id FROM repos WHERE id = ?")
      .get(navProject.value) as { id: string } | null;
    if (repoExists) {
      db.query("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
        "nav.repo_id",
        navProject.value,
      );
    }
  }

  const legacyReviewerRows = db
    .query("SELECT key, value FROM app_state WHERE key LIKE 'reviewers.project.%'")
    .all() as Array<{ key: string; value: string | null }>;
  const upsertState = db.query(
    "INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)",
  );
  for (const row of legacyReviewerRows) {
    const repoKey = row.key.replace(/^reviewers\\.project\\./, "reviewers.repo.");
    const existing = db
      .query("SELECT value FROM app_state WHERE key = ?")
      .get(repoKey) as { value: string | null } | null;
    if (!existing) {
      upsertState.run(repoKey, row.value);
    }
  }
  db.query("DELETE FROM app_state WHERE key LIKE 'reviewers.project.%'").run();
}

function resolveProjectByPath(projectPath: string, preferredName?: string): Project {
  const db = getDb();
  const normalizedPath = normalizePath(projectPath);

  const existing = db
    .query("SELECT * FROM projects WHERE path = ?")
    .get(normalizedPath) as Project | null;
  if (existing) {
    return existing;
  }

  const rawName = (preferredName?.trim() || deriveProjectName(normalizedPath)).trim();
  const normalizedName = rawName || "default";
  let name = normalizedName;
  let index = 2;
  while (
    db.query("SELECT id FROM projects WHERE name = ?").get(name) as
      | { id: string }
      | null
  ) {
    name = `${normalizedName}-${index}`;
    index += 1;
  }

  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(),
    name,
    path: normalizedPath,
    created_at: now,
    last_accessed_at: now,
  };

  db.query(
    "INSERT INTO projects (id, name, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    project.id,
    project.name,
    project.path,
    project.created_at,
    project.last_accessed_at,
  );

  return project;
}

function resolveProjectByName(projectName: string): Project {
  const db = getDb();
  const normalized = projectName.trim();
  const existing = db
    .query("SELECT * FROM projects WHERE name = ?")
    .get(normalized) as Project | null;
  if (existing) return existing;
  return resolveProjectByPath(join(homedir(), normalized), normalized);
}

function touchProjectInternal(id: string): void {
  const db = getDb();
  db.query("UPDATE projects SET last_accessed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

// -- App State (key-value) --

export function getAppState(key: string): string | null {
  const db = getDb();
  const row = db
    .query("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string } | null;
  return row ? row.value : null;
}

export function setAppState(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.query("DELETE FROM app_state WHERE key = ?").run(key);
  } else {
    db.query("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
      key,
      value,
    );
  }
}

export function getAppStatesByPrefix(
  prefix: string,
): Array<{ key: string; value: string | null }> {
  const db = getDb();
  return db
    .query("SELECT key, value FROM app_state WHERE key LIKE ? ORDER BY key ASC")
    .all(`${prefix}%`) as Array<{ key: string; value: string | null }>;
}

// -- Project CRUD --

export function getAllProjects(): Project[] {
  const db = getDb();
  return db
    .query(
      "SELECT id, name, path, created_at, last_accessed_at FROM projects ORDER BY last_accessed_at DESC, name ASC",
    )
    .all() as Project[];
}

export function getProjectById(id: string): Project | null {
  const db = getDb();
  return (
    (db
      .query(
        "SELECT id, name, path, created_at, last_accessed_at FROM projects WHERE id = ?",
      )
      .get(id) as Project) ?? null
  );
}

export function touchProject(id: string): void {
  touchProjectInternal(id);
}

// -- Repo CRUD --

export function getAllRepos(): Repo[] {
  const db = getDb();
  return db
    .query(
      `SELECT r.id, r.name, r.path, r.project_id, p.name AS project_name, p.path AS project_path,
              r.created_at, r.last_accessed_at
       FROM repos r
       JOIN projects p ON r.project_id = p.id
       ORDER BY p.name ASC, r.last_accessed_at DESC`,
    )
    .all() as Repo[];
}

export function addRepo(path: string, projectNameOrPath?: string): Repo {
  const normalizedPath = normalizePath(path);

  if (!existsSync(normalizedPath)) {
    throw new Error(`Directory does not exist: ${normalizedPath}`);
  }
  if (!existsSync(join(normalizedPath, ".git"))) {
    throw new Error("Not a git repository");
  }

  const db = getDb();
  const name = normalizedPath.replace(homedir(), "~").replace(/^~\//, "");
  const projectHint = projectNameOrPath?.trim() || "";

  const derivedProjectPath = deriveProjectPath(normalizedPath);
  const projectPath = !projectHint
    ? derivedProjectPath
    : projectHint.startsWith("/") || projectHint.startsWith("~")
      ? normalizePath(projectHint)
      : deriveProjectName(derivedProjectPath).toLowerCase() ===
          projectHint.toLowerCase()
        ? derivedProjectPath
        : normalizePath(join(homedir(), projectHint));
  const project = resolveProjectByPath(
    projectPath,
    projectHint || deriveProjectName(projectPath),
  );
  const now = new Date().toISOString();

  const repo: Repo = {
    id: uuid(),
    name,
    path: normalizedPath,
    project_id: project.id,
    project_name: project.name,
    project_path: project.path,
    created_at: now,
    last_accessed_at: now,
  };

  db.query(
    "INSERT INTO repos (id, name, path, project_id, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    repo.id,
    repo.name,
    repo.path,
    repo.project_id,
    repo.created_at,
    repo.last_accessed_at,
  );

  touchProjectInternal(project.id);

  return repo;
}

export function touchRepo(id: string): void {
  const db = getDb();
  db.query("UPDATE repos SET last_accessed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );

  const row = db
    .query("SELECT project_id FROM repos WHERE id = ?")
    .get(id) as { project_id: string } | null;
  if (row?.project_id) {
    touchProjectInternal(row.project_id);
  }
}

export function getRepoById(id: string): Repo | null {
  const db = getDb();
  return (
    (db
      .query(
        `SELECT r.id, r.name, r.path, r.project_id, p.name AS project_name, p.path AS project_path,
                r.created_at, r.last_accessed_at
         FROM repos r
         JOIN projects p ON r.project_id = p.id
         WHERE r.id = ?`,
      )
      .get(id) as Repo) ?? null
  );
}

export function deleteRepo(id: string): void {
  const db = getDb();

  const row = db
    .query("SELECT project_id FROM repos WHERE id = ?")
    .get(id) as { project_id: string } | null;

  // Remove tasks and events tied to this repo.
  db.query(
    "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)",
  ).run(id);
  db.query("DELETE FROM tasks WHERE repo_id = ?").run(id);

  db.query("DELETE FROM repos WHERE id = ?").run(id);

  if (row?.project_id) {
    const remaining = db
      .query("SELECT COUNT(*) AS count FROM repos WHERE project_id = ?")
      .get(row.project_id) as { count: number };
    if (remaining.count === 0) {
      db.query("DELETE FROM projects WHERE id = ?").run(row.project_id);
    }
  }
}

export function updateRepoProject(repoId: string, projectName: string): void {
  const normalized = projectName.trim();
  if (!normalized) {
    throw new Error("Project name cannot be empty");
  }

  const db = getDb();
  const old = db
    .query("SELECT project_id FROM repos WHERE id = ?")
    .get(repoId) as { project_id: string } | null;
  const project = resolveProjectByName(normalized);

  db.query("UPDATE repos SET project_id = ? WHERE id = ?").run(
    project.id,
    repoId,
  );
  touchProjectInternal(project.id);

  // Remove now-empty old project if needed.
  if (old?.project_id && old.project_id !== project.id) {
    const remaining = db
      .query("SELECT COUNT(*) AS count FROM repos WHERE project_id = ?")
      .get(old.project_id) as { count: number };
    if (remaining.count === 0) {
      db.query("DELETE FROM projects WHERE id = ?").run(old.project_id);
    }
  }
}

export function refreshProjectRepos(projectId: string): {
  discovered: number;
  added: number;
  reassigned: number;
} {
  const db = getDb();
  const project = getProjectById(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  if (!existsSync(project.path)) {
    throw new Error(`Project path does not exist: ${project.path}`);
  }

  const now = new Date().toISOString();
  const discoveredPaths = discoverGitRepos(project.path);
  const getRepoByPath = db.query(
    "SELECT id, project_id FROM repos WHERE path = ?",
  );
  const insertRepo = db.query(
    "INSERT INTO repos (id, name, path, project_id, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const reassignRepo = db.query(
    "UPDATE repos SET project_id = ?, last_accessed_at = ? WHERE id = ?",
  );

  let added = 0;
  let reassigned = 0;

  for (const repoPath of discoveredPaths) {
    const existing = getRepoByPath.get(repoPath) as
      | { id: string; project_id: string }
      | null;
    if (!existing) {
      const name = repoPath.replace(homedir(), "~").replace(/^~\//, "");
      insertRepo.run(uuid(), name, repoPath, projectId, now, now);
      added += 1;
      continue;
    }
    if (existing.project_id !== projectId) {
      reassignRepo.run(projectId, now, existing.id);
      reassigned += 1;
    }
  }

  touchProjectInternal(projectId);
  return { discovered: discoveredPaths.length, added, reassigned };
}

function normalizePath(pathValue: string): string {
  const home = homedir();
  const expanded = pathValue.trim().replace(/^~(?=$|[\\/])/, home);
  return resolve(expanded || home);
}

function deriveProjectPath(repoPath: string): string {
  return dirname(normalizePath(repoPath));
}

function deriveProjectName(projectPath: string): string {
  const normalized = normalizePath(projectPath);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] || "default";
}

function discoverGitRepos(projectPath: string): string[] {
  const root = normalizePath(projectPath);
  const repos = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const maxDepth = 4;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (existsSync(join(current.dir, ".git"))) {
      repos.add(current.dir);
      continue;
    }
    if (current.depth >= maxDepth) continue;

    let entries:
      | Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>
      | null = null;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
      }>;
    } catch {
      entries = null;
    }
    if (!entries) continue;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = join(current.dir, entry.name);
      stack.push({ dir: child, depth: current.depth + 1 });
    }
  }

  return [...repos].sort();
}

// -- Task CRUD --

export function getTasksForRepo(repoId: string): Task[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM tasks WHERE repo_id = ? ORDER BY sort_order ASC, created_at DESC",
    )
    .all(repoId) as Task[];
}

export function getAllActiveTasks(): Task[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM tasks WHERE status = 'active' ORDER BY last_accessed_at DESC",
    )
    .all() as Task[];
}

export function createTask(
  repoId: string,
  label: string,
  description: string,
  branchName: string,
  worktreePath: string,
): Task {
  const db = getDb();
  const now = new Date().toISOString();

  const maxOrder = db
    .query(
      "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks WHERE repo_id = ?",
    )
    .get(repoId) as { max_order: number };

  const task: Task = {
    id: uuid(),
    repo_id: repoId,
    label,
    description,
    status: "active",
    model: null,
    claude_session_id: null,
    codex_session_id: null,
    session_id: null,
    worktree_path: worktreePath,
    branch_name: branchName,
    sort_order: maxOrder.max_order + 1,
    created_at: now,
    last_accessed_at: now,
    closed_at: null,
  };

  db.query(
    `INSERT INTO tasks (id, repo_id, label, description, status, model, claude_session_id, codex_session_id, session_id, worktree_path, branch_name, sort_order, created_at, last_accessed_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.repo_id,
    task.label,
    task.description,
    task.status,
    task.model,
    task.claude_session_id,
    task.codex_session_id,
    task.session_id,
    task.worktree_path,
    task.branch_name,
    task.sort_order,
    task.created_at,
    task.last_accessed_at,
    task.closed_at,
  );

  addTaskEvent(task.id, "created");

  return task;
}

export function updateTask(id: string, updates: Partial<Task>) {
  const db = getDb();
  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(", ");
  const values = Object.values(updates);
  db.query(`UPDATE tasks SET ${fields} WHERE id = ?`).run(...values, id);
}

export function closeTask(id: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE tasks SET status = 'closed', closed_at = ?, last_accessed_at = ? WHERE id = ?",
  ).run(now, now, id);
  addTaskEvent(id, "closed");
}

export function reopenTask(id: string, worktreePath: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE tasks SET status = 'active', closed_at = NULL, worktree_path = ?, last_accessed_at = ? WHERE id = ?",
  ).run(worktreePath, now, id);
  addTaskEvent(id, "reopened");
}

export function swapTaskOrder(taskA: string, taskB: string) {
  const db = getDb();
  const a = db
    .query("SELECT sort_order FROM tasks WHERE id = ?")
    .get(taskA) as { sort_order: number } | null;
  const b = db
    .query("SELECT sort_order FROM tasks WHERE id = ?")
    .get(taskB) as { sort_order: number } | null;
  if (!a || !b) return;
  db.query("UPDATE tasks SET sort_order = ? WHERE id = ?").run(
    b.sort_order,
    taskA,
  );
  db.query("UPDATE tasks SET sort_order = ? WHERE id = ?").run(
    a.sort_order,
    taskB,
  );
}

export function touchTask(id: string) {
  const db = getDb();
  db.query("UPDATE tasks SET last_accessed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

// -- Task Events --

export function addTaskEvent(
  taskId: string,
  eventType: string,
  metadata?: object,
) {
  const db = getDb();
  db.query(
    "INSERT INTO task_events (id, task_id, event_type, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    uuid(),
    taskId,
    eventType,
    metadata ? JSON.stringify(metadata) : null,
    new Date().toISOString(),
  );
}

export function getTaskEvents(taskId: string): TaskEvent[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC",
    )
    .all(taskId) as TaskEvent[];
}

export function getTasksActiveDuringWindow(
  sinceISO: string,
): Array<
  Task & { repo_name: string; project_name: string; repo_path: string }
> {
  const db = getDb();
  return db
    .query(
      `SELECT t.*, r.name AS repo_name, p.name AS project_name, r.path AS repo_path
       FROM tasks t
       JOIN repos r ON t.repo_id = r.id
       JOIN projects p ON r.project_id = p.id
       WHERE t.created_at <= datetime('now')
         AND (t.status = 'active' OR t.closed_at >= ?)
       ORDER BY p.name ASC, t.sort_order ASC`,
    )
    .all(sinceISO) as Array<
    Task & { repo_name: string; project_name: string; repo_path: string }
  >;
}

export function getTaskEventsSince(
  taskId: string,
  sinceISO: string,
): TaskEvent[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM task_events WHERE task_id = ? AND created_at >= ? ORDER BY created_at ASC",
    )
    .all(taskId, sinceISO) as TaskEvent[];
}
