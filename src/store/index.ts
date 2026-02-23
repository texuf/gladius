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
  chordBuffer: "",

  // Project Selection
  addingProject: false,

  // Cached data
  projects: [],
  tasks: [],
  gitStatuses: {},

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
    set({ activeTask, focusPane: "none", chordBuffer: "" });
  },
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
