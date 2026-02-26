import { create } from "zustand";
import { setAppState } from "../services/db.js";
import type { AppState } from "./types.js";

export const useStore = create<AppState>((set) => ({
  // Navigation
  view: "projects",
  activeProject: null,
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

  // Project Selection
  addingProject: false,

  // Cached data
  projects: [],
  tasks: [],
  gitStatuses: {},
  taskStatuses: {},
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
  setAddingProject: (addingProject) => set({ addingProject }),
  setProjects: (projects) => set({ projects }),
  setTasks: (tasks) => set({ tasks }),
  setGitStatus: (taskId, status) =>
    set((state) => ({
      gitStatuses: { ...state.gitStatuses, [taskId]: status },
    })),
  setTaskStatuses: (taskStatuses) => set({ taskStatuses }),
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
