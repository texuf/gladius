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
  `);
}

// ── Project CRUD ──

export function getAllProjects(): Project[] {
  const db = getDb();
  return db
    .query("SELECT * FROM projects ORDER BY last_accessed_at DESC")
    .all() as Project[];
}

export function addProject(path: string): Project {
  const db = getDb();
  const name = path.replace(homedir(), "~").replace(/^~\//, "");
  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(),
    name,
    path,
    created_at: now,
    last_accessed_at: now,
  };

  db.query(
    "INSERT INTO projects (id, name, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)"
  ).run(project.id, project.name, project.path, project.created_at, project.last_accessed_at);

  return project;
}

export function touchProject(id: string) {
  const db = getDb();
  db.query("UPDATE projects SET last_accessed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
}

export function deleteProject(id: string) {
  const db = getDb();
  db.query("DELETE FROM projects WHERE id = ?").run(id);
}

// ── Task CRUD ──

export function getTasksForProject(projectId: string): Task[] {
  const db = getDb();
  return db
    .query(
      "SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order ASC, created_at DESC"
    )
    .all(projectId) as Task[];
}

export function getAllActiveTasks(): Task[] {
  const db = getDb();
  return db
    .query("SELECT * FROM tasks WHERE status = 'active' ORDER BY last_accessed_at DESC")
    .all() as Task[];
}

export function createTask(
  projectId: string,
  label: string,
  description: string,
  branchName: string,
  worktreePath: string
): Task {
  const db = getDb();
  const now = new Date().toISOString();

  // Get max sort_order for this project
  const maxOrder = db
    .query("SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks WHERE project_id = ?")
    .get(projectId) as { max_order: number };

  const task: Task = {
    id: uuid(),
    project_id: projectId,
    label,
    description,
    status: "active",
    model: null,
    session_id: null,
    worktree_path: worktreePath,
    branch_name: branchName,
    sort_order: maxOrder.max_order + 1,
    created_at: now,
    last_accessed_at: now,
    closed_at: null,
  };

  db.query(
    `INSERT INTO tasks (id, project_id, label, description, status, model, session_id, worktree_path, branch_name, sort_order, created_at, last_accessed_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id, task.project_id, task.label, task.description, task.status,
    task.model, task.session_id, task.worktree_path, task.branch_name,
    task.sort_order, task.created_at, task.last_accessed_at, task.closed_at
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
    "UPDATE tasks SET status = 'closed', closed_at = ?, last_accessed_at = ? WHERE id = ?"
  ).run(now, now, id);
  addTaskEvent(id, "closed");
}

export function reopenTask(id: string, worktreePath: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE tasks SET status = 'active', closed_at = NULL, worktree_path = ?, last_accessed_at = ? WHERE id = ?"
  ).run(worktreePath, now, id);
  addTaskEvent(id, "reopened");
}

export function swapTaskOrder(taskA: string, taskB: string) {
  const db = getDb();
  const a = db.query("SELECT sort_order FROM tasks WHERE id = ?").get(taskA) as { sort_order: number } | null;
  const b = db.query("SELECT sort_order FROM tasks WHERE id = ?").get(taskB) as { sort_order: number } | null;
  if (!a || !b) return;
  db.query("UPDATE tasks SET sort_order = ? WHERE id = ?").run(b.sort_order, taskA);
  db.query("UPDATE tasks SET sort_order = ? WHERE id = ?").run(a.sort_order, taskB);
}

export function touchTask(id: string) {
  const db = getDb();
  db.query("UPDATE tasks SET last_accessed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
}

// ── Task Events ──

export function addTaskEvent(taskId: string, eventType: string, metadata?: object) {
  const db = getDb();
  db.query(
    "INSERT INTO task_events (id, task_id, event_type, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(uuid(), taskId, eventType, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
}

export function getTaskEvents(taskId: string): TaskEvent[] {
  const db = getDb();
  return db
    .query("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC")
    .all(taskId) as TaskEvent[];
}
