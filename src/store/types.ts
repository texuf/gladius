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
  status: "active" | "closing" | "closed";
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
  ciPending: number;
}

export type TaskStatusColor = "green" | "red" | "orange" | "yellow" | "none";

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  behindMain: number;
  changedFiles: number;
  pr: PrStatus | null;
}

export type ViewState = "projects" | "tasks" | "taskView" | "taskSwitcher" | "prComments";

export type FocusPane = "none" | "notes" | "terminal" | "console";

export interface ReviewThread {
  id: string;
  path: string;
  line: number;
  startLine: number | null;
  comments: ReviewComment[];
}

export interface ReviewComment {
  body: string;
  author: string;
  createdAt: string;
}

export interface CiCheckFailure {
  name: string;              // Job name e.g. "Common_CI"
  failedStep: string | null; // Step name e.g. "Prettier"
  detailsUrl: string;
  log: string;               // Extracted log output for the failed step
}

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
  copyMode: boolean;

  // Project Selection
  addingProject: boolean;

  // Cached data
  projects: Project[];
  tasks: Task[];
  gitStatuses: Record<string, GitStatus>;
  taskStatuses: Record<string, TaskStatusColor>;
  consoleInteractedTasks: Set<string>;

  // Actions
  setView: (view: ViewState) => void;
  setActiveProject: (project: Project | null) => void;
  setActiveTask: (task: Task | null) => void;
  setSelectedIndex: (index: number) => void;
  setModal: (modal: ModalState) => void;
  setFocusPane: (pane: FocusPane) => void;
  setChordBuffer: (chord: string) => void;
  setCopyMode: (copyMode: boolean) => void;
  setAddingProject: (adding: boolean) => void;
  setProjects: (projects: Project[]) => void;
  setTasks: (tasks: Task[]) => void;
  setGitStatus: (taskId: string, status: GitStatus) => void;
  setTaskStatuses: (statuses: Record<string, TaskStatusColor>) => void;
  markConsoleInteracted: (taskId: string) => void;
  clearConsoleInteracted: (taskId: string) => void;
}
