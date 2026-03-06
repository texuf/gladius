import { create } from "zustand";
import { setAppState } from "../services/db.js";
import type { AppState } from "./types.js";

export const useStore = create<AppState>((set) => ({
  // Navigation
  view: "projects",
  activeProject: null,
  activeRepo: null,
  activeTask: null,
  selectedIndex: 0,

  // Modal
  modal: null,

  // Task View
  focusPane: "none",
  prCommentsSelectionKind: "none",
  prCommentsHasSelection: false,
  chordBuffer: "",
  copyMode: false,

  // Repo Selection
  addingRepo: false,

  // Cached data
  repos: [],
  tasks: [],
  gitStatuses: {},
  taskStatuses: {},
  backendReachability: {},
  consoleInteractedTasks: new Set<string>(),
  clearedPrTasks: new Set<string>(),

  // Actions
  setView: (view) => {
    setAppState("nav.view", view);
    set({ view, selectedIndex: 0 });
  },
  setActiveProject: (activeProject) => {
    setAppState("nav.project_id", activeProject?.id ?? null);
    set({ activeProject });
  },
  setActiveRepo: (activeRepo) => {
    setAppState("nav.repo_id", activeRepo?.id ?? null);
    set({ activeRepo });
  },
  setActiveTask: (activeTask) => {
    setAppState("nav.task_id", activeTask?.id ?? null);
    set({ activeTask, focusPane: "none", chordBuffer: "", copyMode: false });
  },
  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
  setModal: (modal) => set({ modal }),
  setFocusPane: (focusPane) => set({ focusPane }),
  setPrCommentsSelectionKind: (prCommentsSelectionKind) =>
    set({ prCommentsSelectionKind }),
  setPrCommentsHasSelection: (prCommentsHasSelection) =>
    set({ prCommentsHasSelection }),
  setChordBuffer: (chordBuffer) => set({ chordBuffer }),
  setCopyMode: (copyMode) => set({ copyMode }),
  setAddingRepo: (addingRepo) => set({ addingRepo }),
  setRepos: (repos) => set({ repos }),
  setTasks: (tasks) => set({ tasks }),
  setGitStatus: (taskId, status) =>
    set((state) => ({
      gitStatuses: { ...state.gitStatuses, [taskId]: status },
    })),
  setTaskStatuses: (taskStatuses) => set({ taskStatuses }),
  setBackendReachability: (projectId, status) =>
    set((state) => ({
      backendReachability: {
        ...state.backendReachability,
        [projectId]: status,
      },
    })),
  markConsoleInteracted: (taskId) =>
    set((state) => {
      const next = new Set(state.consoleInteractedTasks);
      next.add(taskId);
      return { consoleInteractedTasks: next };
    }),
  clearConsoleInteracted: (taskId) =>
    set((state) => {
      const next = new Set(state.consoleInteractedTasks);
      next.delete(taskId);
      return { consoleInteractedTasks: next };
    }),
  markPrCleared: (taskId) =>
    set((state) => {
      const next = new Set(state.clearedPrTasks);
      next.add(taskId);
      return { clearedPrTasks: next };
    }),
  clearPrCleared: (taskId) =>
    set((state) => {
      const next = new Set(state.clearedPrTasks);
      next.delete(taskId);
      return { clearedPrTasks: next };
    }),
}));
