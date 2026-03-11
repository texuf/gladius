import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  checkBackendDependencies,
  resolveProjectBackend,
  type DependencyCheckResult,
} from "../services/projectBackend.js";
import { destroySession } from "../services/terminalManager.js";
import { processChord } from "../utils/keyboard.js";

export function ProjectView() {
  const activeProject = useStore((s) => s.activeProject);
  const repos = useStore((s) => s.repos);
  const setRepos = useStore((s) => s.setRepos);
  const setView = useStore((s) => s.setView);
  const setModal = useStore((s) => s.setModal);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const backendReachability = useStore((s) => s.backendReachability);
  const setBackendReachability = useStore((s) => s.setBackendReachability);
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const chordBuffer = useStore((s) => s.chordBuffer);
  const setChordBuffer = useStore((s) => s.setChordBuffer);

  const [model, setModel] = useState<"claude" | "codex" | null>(null);
  const [linearEnabled, setLinearEnabled] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [dependencyStatus, setDependencyStatus] = useState("");
  const [dependencyResult, setDependencyResult] =
    useState<DependencyCheckResult | null>(null);
  const [checkingDependencies, setCheckingDependencies] = useState(false);
  const [error, setError] = useState("");
  const prevFocusPaneRef = useRef(focusPane);

  const workspaceId = activeProject ? `project-${activeProject.id}` : "";
  const backend = activeProject ? resolveProjectBackend(activeProject) : null;
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
    setRefreshStatus("");
    setDependencyStatus("");
    setDependencyResult(null);
    setError("");
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

  const openConsoleModelMenu = () => {
    setModal({
      type: "hotkeyMenu",
      title: "console",
      items: [
        {
          key: "l",
          label: "New Claude session",
          onSelect: () => selectModel("claude"),
        },
        {
          key: "o",
          label: "New Codex session",
          onSelect: () => selectModel("codex"),
        },
      ],
    });
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
      setBackendReachability(projectId, "online");
      setError("");
      setRefreshStatus(
        `found ${result.discovered}, +${result.added} new, ${result.reassigned} reassigned`,
      );
    } catch (e: any) {
      if (activeProject?.backend_kind === "ssh") {
        setBackendReachability(projectId, "offline");
      }
      setError(e.message || "Refresh failed");
    }
  }, [
    activeProject?.backend_kind,
    activeProject?.id,
    setActiveProject,
    setBackendReachability,
    setRepos,
  ]);

  const toggleLinear = () => {
    if (!activeProject) return;
    const next = !linearEnabled;
    setProjectLinearEnabled(activeProject.id, next);
    setLinearEnabled(next);
  };

  const runDependencyCheck = useCallback(() => {
    if (!backend || checkingDependencies) return;
    setCheckingDependencies(true);
    setDependencyStatus(`Checking ${backend.kind} dependencies...`);
    setError("");
    try {
      const result = checkBackendDependencies(backend);
      if (activeProject) {
        setBackendReachability(
          activeProject.id,
          result.items.some(
            (item) => item.tool === "ssh" && item.status === "warning",
          )
            ? "offline"
            : "online",
        );
      }
      setDependencyResult(result);
      const problemCount = result.items.filter(
        (item) => item.status !== "ok",
      ).length;
      setDependencyStatus(
        problemCount === 0
          ? "All checked dependencies are available."
          : `${problemCount} dependency issue${problemCount === 1 ? "" : "s"} found.`,
      );
    } catch (e: any) {
      setError(e.message || "Dependency check failed");
    } finally {
      setCheckingDependencies(false);
    }
  }, [activeProject, backend, checkingDependencies, setBackendReachability]);

  useEffect(() => {
    if (prevFocusPaneRef.current === "terminal" && focusPane === "none") {
      runRefresh();
    }
    prevFocusPaneRef.current = focusPane;
  }, [focusPane, runRefresh]);

  useInput((input, key) => {
    if (useStore.getState().modal?.type === "hotkeyMenu") return;
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

    if (input === "c" && !key.super) {
      if (model) {
        setFocusPane("console");
      } else {
        openConsoleModelMenu();
      }
      return;
    }

    if (input === "l" && !key.super) {
      selectModel("claude");
      return;
    }

    if (input === "o" && !key.super) {
      selectModel("codex");
      return;
    }

    if (input === "r" && !key.super) {
      runRefresh();
      return;
    }

    if (input === "d" && !key.super) {
      runDependencyCheck();
      return;
    }

    if (input === "y" && !key.super) {
      toggleLinear();
      return;
    }

    const { newBuffer, chord } = processChord(chordBuffer, input, key);
    setChordBuffer(newBuffer);
    if (chord === "cl" || chord === "co") {
      selectModel(chord === "cl" ? "claude" : "codex");
    }
  });

  if (!activeProject) return null;
  if (!backend) return null;

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
        <Text>
          {backend.kind === "ssh"
            ? `${backend.target}:${backend.basePath}`
            : activeProject.path}
        </Text>
        <Text dimColor>
          {projectRepos.length} repo{projectRepos.length === 1 ? "" : "s"}
          {refreshStatus ? ` | ${refreshStatus}` : ""}
          {dependencyStatus ? ` | ${dependencyStatus}` : ""}
          {model ? ` | model: ${model}` : " | cl: Claude co: Codex"}
          {` | linear: ${linearEnabled ? "on" : "off"} (y toggle)`}
        </Text>
        <Text dimColor>
          backend: {backend.kind}
          {backend.target ? ` | target: ${backend.target}` : ""}
          {backend.kind === "ssh" ? ` | base: ${backend.basePath}` : ""}
          {backendReachability[activeProject.id]
            ? ` | ${backendReachability[activeProject.id]}`
            : ""}
        </Text>
        {checkingDependencies && (
          <Text dimColor>Running dependency checks...</Text>
        )}
        {error && <Text color="red">{error}</Text>}
      </Box>

      {dependencyResult && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          <Text bold>
            Dependency Check
            <Text dimColor>{` (${dependencyResult.backend.displayName})`}</Text>
          </Text>
          {dependencyResult.items.map((item) => (
            <Text
              key={`${item.tool}-${item.requiredFor}`}
              color={
                item.status === "ok"
                  ? "green"
                  : item.status === "warning"
                    ? "yellow"
                    : "red"
              }
            >
              {item.tool.padEnd(6)} {item.status.toUpperCase()} [{item.requiredFor}]{" "}
              <Text color="gray">{item.detail}</Text>
            </Text>
          ))}
        </Box>
      )}

      <TerminalPane
        type="terminal"
        label="Terminal"
        focusKey="t"
        layout="project"
        workspaceId={workspaceId}
        cwd={backend.basePath}
        captureSessionIds={false}
      />

      <TerminalPane
        type="console"
        label="Console"
        focusKey="c"
        layout="project"
        workspaceId={workspaceId}
        cwd={backend.basePath}
        model={model}
        captureSessionIds={false}
      />
    </Box>
  );
}
