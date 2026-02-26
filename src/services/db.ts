import { Database } from "bun:sqlite";
import { v4 as uuid } from "uuid";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { Project, Task, TaskEvent } from "../store/types.js";

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

function hasColumn(tableName: string, columnName: string): boolean {
  const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function migrateSchema() {
  const hasProjectGroupColumn = hasColumn("projects", "group_name");
  const hasClaudeSessionColumn = hasColumn("tasks", "claude_session_id");
  const hasCodexSessionColumn = hasColumn("tasks", "codex_session_id");
  const hasLegacySessionColumn = hasColumn("tasks", "session_id");

  if (!hasProjectGroupColumn) {
    db.exec("ALTER TABLE projects ADD COLUMN group_name TEXT;");
  }
  if (!hasClaudeSessionColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN claude_session_id TEXT;");
  }
  if (!hasCodexSessionColumn) {
    db.exec("ALTER TABLE tasks ADD COLUMN codex_session_id TEXT;");
  }

  // Backfill existing single-session rows into provider-specific columns.
  // Keep legacy session_id intact so no existing data is lost.
  if (hasLegacySessionColumn) {
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
  }

  // Backfill project groups for existing rows.
  const projects = db
    .query("SELECT id, path, group_name FROM projects")
    .all() as Array<{ id: string; path: string; group_name: string | null }>;
  const updateGroup = db.query(
    "UPDATE projects SET group_name = ? WHERE id = ?",
  );
  for (const project of projects) {
    const existing = project.group_name?.trim();
    if (existing) continue;
    updateGroup.run(deriveProjectGroup(project.path), project.id);
  }
}

// ── App State (key-value) ──

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

// ── Project CRUD ──

export function getAllProjects(): Project[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM projects ORDER BY group_name ASC, last_accessed_at DESC",
    )
    .all() as Project[];
}

export function addProject(path: string): Project {
  if (!existsSync(path)) {
    throw new Error(`Directory does not exist: ${path}`);
  }
  if (!existsSync(join(path, ".git"))) {
    throw new Error("Not a git repository");
  }
  const db = getDb();
  const name = path.replace(homedir(), "~").replace(/^~\//, "");
  const group_name = deriveProjectGroup(path);
  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(),
    name,
    path,
    group_name,
    created_at: now,
    last_accessed_at: now,
  };

  db.query(
    "INSERT INTO projects (id, name, path, group_name, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    project.id,
    project.name,
    project.path,
    project.group_name,
    project.created_at,
    project.last_accessed_at,
  );

  return project;
}

export function touchProject(id: string) {
  const db = getDb();
  db.query("UPDATE projects SET last_accessed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

export function getProjectById(id: string): Project | null {
  const db = getDb();
  return (
    (db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project) ?? null
  );
}

export function deleteProject(id: string) {
  const db = getDb();
  db.query("DELETE FROM projects WHERE id = ?").run(id);
}

export function updateProjectGroup(id: string, groupName: string) {
  const db = getDb();
  const normalized = groupName.trim();
  if (!normalized) {
    throw new Error("Group name cannot be empty");
  }
  db.query("UPDATE projects SET group_name = ? WHERE id = ?").run(
    normalized,
    id,
  );
}

function deriveProjectGroup(projectPath: string): string {
  const home = homedir();
  let normalized = projectPath.trim();

  if (normalized.startsWith(home + "/")) {
    normalized = normalized.slice(home.length + 1);
  } else if (normalized === home) {
    normalized = "";
  }

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments[0] || "default";
}

// ── Task CRUD ──

export function getTasksForProject(projectId: string): Task[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order ASC, created_at DESC",
    )
    .all(projectId) as Task[];
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
  projectId: string,
  label: string,
  description: string,
  branchName: string,
  worktreePath: string,
): Task {
  const db = getDb();
  const now = new Date().toISOString();

  // Get max sort_order for this project
  const maxOrder = db
    .query(
      "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks WHERE project_id = ?",
    )
    .get(projectId) as { max_order: number };

  const task: Task = {
    id: uuid(),
    project_id: projectId,
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
    `INSERT INTO tasks (id, project_id, label, description, status, model, claude_session_id, codex_session_id, session_id, worktree_path, branch_name, sort_order, created_at, last_accessed_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.project_id,
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

// ── Task Events ──

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
  Task & { project_name: string; group_name: string; project_path: string }
> {
  const db = getDb();
  return db
    .query(
      `SELECT t.*, p.name AS project_name, p.group_name, p.path AS project_path
       FROM tasks t
       JOIN projects p ON t.project_id = p.id
       WHERE t.created_at <= datetime('now')
         AND (t.status = 'active' OR t.closed_at >= ?)
       ORDER BY p.group_name ASC, t.sort_order ASC`,
    )
    .all(sinceISO) as Array<
    Task & { project_name: string; group_name: string; project_path: string }
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
