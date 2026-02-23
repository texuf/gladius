import { create } from "zustand";
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
  chordBuffer: "",

  // Project Selection
  addingProject: false,

  // Cached data
  projects: [],
  tasks: [],
  gitStatuses: {},

  // Actions
  setView: (view) => set({ view, selectedIndex: 0 }),
  setActiveProject: (activeProject) => set({ activeProject }),
  setActiveTask: (activeTask) => set({ activeTask, focusPane: "none", chordBuffer: "" }),
  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
  setModal: (modal) => set({ modal }),
  setFocusPane: (focusPane) => set({ focusPane }),
  setChordBuffer: (chordBuffer) => set({ chordBuffer }),
  setAddingProject: (addingProject) => set({ addingProject }),
  setProjects: (projects) => set({ projects }),
  setTasks: (tasks) => set({ tasks }),
  setGitStatus: (taskId, status) =>
    set((state) => ({
      gitStatuses: { ...state.gitStatuses, [taskId]: status },
    })),
}));
