export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  label: string;
  description: string;
  status: "active" | "closed";
  model: "claude" | "codex" | null;
  session_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  sort_order: number;
  created_at: string;
  last_accessed_at: string;
  closed_at: string | null;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  event_type: "created" | "started" | "paused" | "closed" | "reopened";
  metadata: string | null;
  created_at: string;
}

export interface PrStatus {
  number: number;
  state: "open" | "closed" | "merged";
  unresolvedThreads: number;
  ciPassed: number;
  ciFailed: number;
}

export type TaskStatusColor = "green" | "red" | "orange" | "none";

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  behindMain: number;
  changedFiles: number;
  pr: PrStatus | null;
}

export type ViewState = "projects" | "tasks" | "taskView" | "taskSwitcher";

export type FocusPane = "none" | "notes" | "terminal" | "console";

export type ModalState =
  | { type: "newTask" }
  | { type: "confirm"; message: string; onConfirm: () => void }
  | null;

export interface AppState {
  // Navigation
  view: ViewState;
  activeProject: Project | null;
  activeTask: Task | null;
  selectedIndex: number;

  // Modal
  modal: ModalState;

  // Task View
  focusPane: FocusPane;
  chordBuffer: string;

  // Project Selection
  addingProject: boolean;

  // Cached data
  projects: Project[];
  tasks: Task[];
  gitStatuses: Record<string, GitStatus>;
  taskStatuses: Record<string, TaskStatusColor>;

  // Actions
  setView: (view: ViewState) => void;
  setActiveProject: (project: Project | null) => void;
  setActiveTask: (task: Task | null) => void;
  setSelectedIndex: (index: number) => void;
  setModal: (modal: ModalState) => void;
  setFocusPane: (pane: FocusPane) => void;
  setChordBuffer: (chord: string) => void;
  setAddingProject: (adding: boolean) => void;
  setProjects: (projects: Project[]) => void;
  setTasks: (tasks: Task[]) => void;
  setGitStatus: (taskId: string, status: GitStatus) => void;
  setTaskStatuses: (statuses: Record<string, TaskStatusColor>) => void;
}
