import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import { TerminalPane } from "../components/TerminalPane.js";
import {
  getAllRepos,
  getAppState,
  getProjectById,
  isProjectLinearEnabled,
  refreshProjectRepos,
  setAppState,
  setProjectLinearEnabled,
  touchProject,
} from "../services/db.js";
import { destroySession } from "../services/terminalManager.js";
import { processChord } from "../utils/keyboard.js";

export function ProjectView() {
  const activeProject = useStore((s) => s.activeProject);
  const repos = useStore((s) => s.repos);
  const setRepos = useStore((s) => s.setRepos);
  const setView = useStore((s) => s.setView);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const chordBuffer = useStore((s) => s.chordBuffer);
  const setChordBuffer = useStore((s) => s.setChordBuffer);

  const [model, setModel] = useState<"claude" | "codex" | null>(null);
  const [linearEnabled, setLinearEnabled] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [error, setError] = useState("");
  const prevFocusPaneRef = useRef(focusPane);

  const workspaceId = activeProject ? `project-${activeProject.id}` : "";
  const projectRepos = useMemo(
    () => repos.filter((repo) => repo.project_id === activeProject?.id),
    [repos, activeProject?.id],
  );

  useEffect(() => {
    if (!activeProject) return;
    touchProject(activeProject.id);
    const saved = getAppState(`project.model.${activeProject.id}`);
    setModel(saved === "claude" || saved === "codex" ? saved : null);
    setLinearEnabled(isProjectLinearEnabled(activeProject.id));
  }, [activeProject?.id]);

  const selectModel = (nextModel: "claude" | "codex") => {
    if (!activeProject) return;
    if (model && model !== nextModel) {
      destroySession(`${workspaceId}-console`);
    }
    setModel(nextModel);
    setAppState(`project.model.${activeProject.id}`, nextModel);
    setChordBuffer("");
    setFocusPane("console");
  };

  const runRefresh = useCallback(() => {
    const projectId = activeProject?.id;
    if (!projectId) return;
    try {
      const result = refreshProjectRepos(projectId);
      const updatedRepos = getAllRepos();
      setRepos(updatedRepos);
      const updatedProject = getProjectById(projectId);
      if (updatedProject) {
        setActiveProject(updatedProject);
      }
      setError("");
      setRefreshStatus(
        `found ${result.discovered}, +${result.added} new, ${result.reassigned} reassigned`,
      );
    } catch (e: any) {
      setError(e.message || "Refresh failed");
    }
  }, [activeProject?.id, setActiveProject, setRepos]);

  const toggleLinear = () => {
    if (!activeProject) return;
    const next = !linearEnabled;
    setProjectLinearEnabled(activeProject.id, next);
    setLinearEnabled(next);
  };

  useEffect(() => {
    if (prevFocusPaneRef.current === "terminal" && focusPane === "none") {
      runRefresh();
    }
    prevFocusPaneRef.current = focusPane;
  }, [focusPane, runRefresh]);

  useInput((input, key) => {
    if (!activeProject) return;

    if (focusPane !== "none") {
      if (key.escape) {
        setFocusPane("none");
      }
      return;
    }

    if (key.escape) {
      setView("projects");
      return;
    }

    if (input === "i" && !key.super) {
      setFocusPane("notes");
      return;
    }

    if (input === "t" && !key.super) {
      setFocusPane("terminal");
      return;
    }

    if (input === "c" && !key.super && model) {
      setFocusPane("console");
      return;
    }

    if (input === "l" && !key.super && model) {
      selectModel("claude");
      return;
    }

    if (input === "o" && !key.super && model) {
      selectModel("codex");
      return;
    }

    if (input === "r" && !key.super) {
      runRefresh();
      return;
    }

    if (input === "y" && !key.super) {
      toggleLinear();
      return;
    }

    const { newBuffer, chord } = processChord(chordBuffer, input, key);
    setChordBuffer(newBuffer);
    if (!model && (chord === "cl" || chord === "co")) {
      selectModel(chord === "cl" ? "claude" : "codex");
    }
  });

  if (!activeProject) return null;

  const titleFocused = focusPane === "notes";

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle={titleFocused ? "double" : "single"}
        borderColor={titleFocused ? "green" : "gray"}
        paddingX={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={titleFocused ? "green" : undefined}>
            {activeProject.name}
          </Text>
          <Text dimColor>i: focus</Text>
        </Box>
        <Text>{activeProject.path}</Text>
        <Text dimColor>
          {projectRepos.length} repo{projectRepos.length === 1 ? "" : "s"}
          {refreshStatus ? ` | ${refreshStatus}` : ""}
          {model ? ` | model: ${model}` : " | cl: Claude co: Codex"}
          {` | linear: ${linearEnabled ? "on" : "off"} (y toggle)`}
        </Text>
        {error && <Text color="red">{error}</Text>}
      </Box>

      <TerminalPane
        type="terminal"
        label="Terminal"
        focusKey="t"
        layout="project"
        workspaceId={workspaceId}
        cwd={activeProject.path}
        captureSessionIds={false}
      />

      <TerminalPane
        type="console"
        label="Console"
        focusKey="c"
        layout="project"
        workspaceId={workspaceId}
        cwd={activeProject.path}
        model={model}
        captureSessionIds={false}
      />
    </Box>
  );
}
