export type ProjectBackendKind = "local" | "ssh";

export interface Project {
  id: string;
  name: string;
  path: string;
  backend_kind: ProjectBackendKind;
  backend_target: string | null;
  backend_base_path: string;
  backend_display_name: string | null;
  created_at: string;
  last_accessed_at: string;
}

export interface Repo {
  id: string;
  name: string;
  path: string;
  project_id: string;
  project_name: string;
  project_path: string;
  project_backend_kind: ProjectBackendKind;
  project_backend_target: string | null;
  project_backend_base_path: string;
  project_backend_display_name: string | null;
  created_at: string;
  last_accessed_at: string;
}

export interface Task {
  id: string;
  repo_id: string;
  label: string;
  description: string;
  linear_issue_id: string | null;
  linear_issue_started_at: string | null;
  status: "active" | "closing" | "closed";
  model: "claude" | "codex" | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
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
  event_type:
    | "created"
    | "started"
    | "paused"
    | "closed"
    | "reopened"
    | "commit";
  metadata: string | null;
  created_at: string;
}

export type PrReadiness =
  | "none"
  | "ciPending"
  | "attentionNeeded"
  | "readyToMerge"
  | "merged";

export type GitWorkStatus = "clean" | "dirty";
export type LlmActivityStatus = "working" | "needsInput" | "idle";

export interface PrStatus {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  readiness: PrReadiness;
  statusColor: TaskStatusColor;
  hasConflicts: boolean;
  unresolvedThreads: number;
  ciPassed: number;
  ciFailed: number;
  ciPending: number;
}

export type TaskStatusColor =
  | "green"
  | "red"
  | "orange"
  | "yellow"
  | "purple"
  | "gray"
  | "none";

export type BackendReachability = "online" | "offline";

export interface GitStatus {
  branch: string;
  hasTrackingBranch: boolean;
  tracksMain: boolean;
  ahead: number;
  behind: number;
  behindMain: number;
  changedFiles: number;
  pr: PrStatus | null;
}

export interface Reviewer {
  name: string;
  handle: string;
  hotkey?: string | null;
}

export type ViewState =
  | "projects"
  | "projectView"
  | "tasks"
  | "taskView"
  | "taskLazygit"
  | "taskSwitcher"
  | "prComments"
  | "settings"
  | "createPr"
  | "standup"
  | "adoptBranch"
  | "adoptCommit";

export type FocusPane = "none" | "notes" | "terminal" | "console";
export type PrCommentsSelectionKind = "none" | "ci" | "thread";

export interface ReviewThread {
  id: string;
  path: string;
  line: number;
  startLine: number | null;
  comments: ReviewComment[];
}

export interface ReviewComment {
  title: string | null;
  body: string;
  author: string;
  createdAt: string;
}

export interface CiCheckFailure {
  name: string; // Job name e.g. "Common_CI"
  failedStep: string | null; // Step name e.g. "Prettier"
  detailsUrl: string;
  log: string; // Extracted log output for the failed step
}

export type ModalState =
  | { type: "newTask" }
  | { type: "confirm"; message: string; onConfirm: () => void }
  | {
      type: "hotkeyMenu";
      title: string;
      items: Array<{
        key: string;
        label: string;
        disabled?: boolean;
        onSelect: () => void;
      }>;
      onCancel?: () => void;
    }
  | null;

export interface AppState {
  // Navigation
  view: ViewState;
  activeProject: Project | null;
  activeRepo: Repo | null;
  activeTask: Task | null;
  selectedIndex: number;

  // Modal
  modal: ModalState;

  // Task View
  focusPane: FocusPane;
  prCommentsSelectionKind: PrCommentsSelectionKind;
  prCommentsHasSelection: boolean;
  chordBuffer: string;
  copyMode: boolean;

  // Repo Selection
  addingRepo: boolean;

  // Cached data
  repos: Repo[];
  tasks: Task[];
  gitStatuses: Record<string, GitStatus>;
  taskStatuses: Record<string, TaskStatusColor>;
  backendReachability: Record<string, BackendReachability>;
  consoleInteractedTasks: Set<string>;
  clearedPrTasks: Set<string>;

  // Actions
  setView: (view: ViewState) => void;
  setActiveProject: (project: Project | null) => void;
  setActiveRepo: (repo: Repo | null) => void;
  setActiveTask: (task: Task | null) => void;
  setSelectedIndex: (index: number) => void;
  setModal: (modal: ModalState) => void;
  setFocusPane: (pane: FocusPane) => void;
  setPrCommentsSelectionKind: (kind: PrCommentsSelectionKind) => void;
  setPrCommentsHasSelection: (hasSelection: boolean) => void;
  setChordBuffer: (chord: string) => void;
  setCopyMode: (copyMode: boolean) => void;
  setAddingRepo: (adding: boolean) => void;
  setRepos: (repos: Repo[]) => void;
  setTasks: (tasks: Task[]) => void;
  setGitStatus: (taskId: string, status: GitStatus) => void;
  setTaskStatuses: (statuses: Record<string, TaskStatusColor>) => void;
  setBackendReachability: (
    projectId: string,
    status: BackendReachability,
  ) => void;
  markConsoleInteracted: (taskId: string) => void;
  clearConsoleInteracted: (taskId: string) => void;
  markPrCleared: (taskId: string) => void;
  clearPrCleared: (taskId: string) => void;
}
