import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { homedir } from "os";
import { join } from "path";
import {
  ensureSshBasePath,
  testSshConnection,
} from "../services/projectBackend.js";
import type { ProjectBackendKind } from "../store/types.js";

interface NewProjectDraft {
  backendKind: ProjectBackendKind;
  name: string;
  localPath: string;
  sshTarget: string;
  sshBasePath: string;
}

type NewProjectStep = "backend" | "name" | "target" | "path";

export interface NewProjectSubmit {
  name: string;
  path: string;
  backendKind: ProjectBackendKind;
  backendTarget?: string | null;
  backendBasePath?: string | null;
  backendDisplayName?: string | null;
}

interface NewProjectModalProps {
  onCancel: () => void;
  onSubmit: (draft: NewProjectSubmit) => string | null | Promise<string | null>;
}

export function NewProjectModal({
  onCancel,
  onSubmit,
}: NewProjectModalProps) {
  const [step, setStep] = useState<NewProjectStep>("backend");
  const [draft, setDraft] = useState<NewProjectDraft>({
    backendKind: "local",
    name: "",
    localPath: "",
    sshTarget: "",
    sshBasePath: "",
  });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [backendIndex, setBackendIndex] = useState(0);

  const backendOptions: Array<{
    key: string;
    kind: ProjectBackendKind;
    label: string;
    detail: string;
  }> = [
    {
      key: "l",
      kind: "local",
      label: "Local",
      detail: "Project and repos live on this machine.",
    },
    {
      key: "s",
      kind: "ssh",
      label: "SSH",
      detail: "Project lives on a VPS over SSH.",
    },
  ];

  useEffect(() => {
    if (!draft.localPath && draft.name.trim()) {
      setDraft((prev) => ({
        ...prev,
        localPath: join(homedir(), prev.name.trim()),
      }));
    }
  }, [draft.localPath, draft.name]);

  const currentTitle = useMemo(() => {
    if (step === "backend") return "Create Project";
    if (step === "name") return "Project Name";
    if (step === "target") return "SSH Target";
    return draft.backendKind === "local" ? "Local Path" : "Remote Base Path";
  }, [draft.backendKind, step]);

  const canGoBack = step !== "backend" && !busy;

  useInput((input, key) => {
    if (busy) return;

    if (step === "backend") {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || key.leftArrow) {
        setBackendIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || key.rightArrow) {
        setBackendIndex((prev) =>
          Math.min(backendOptions.length - 1, prev + 1),
        );
        return;
      }
      if (key.return) {
        const next = backendOptions[backendIndex];
        if (next) {
          setDraft((prev) => ({ ...prev, backendKind: next.kind }));
          setError("");
          setStatus("");
          setStep("name");
        }
        return;
      }
      const direct = backendOptions.find((option) => option.key === input);
      if (direct) {
        setBackendIndex(backendOptions.indexOf(direct));
        setDraft((prev) => ({ ...prev, backendKind: direct.kind }));
        setError("");
        setStatus("");
        setStep("name");
      }
      return;
    }

    if (key.escape) {
      setError("");
      setStatus("");
      if (step === "name") {
        setStep("backend");
        return;
      }
      if (step === "target") {
        setStep("name");
        return;
      }
      if (step === "path") {
        setStep(draft.backendKind === "local" ? "name" : "target");
        return;
      }
    }
  });

  const submitName = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Project name cannot be empty.");
      return;
    }
    if (/[\\/]/.test(trimmed)) {
      setError("Project name cannot include path separators.");
      return;
    }

    setDraft((prev) => ({
      ...prev,
      name: trimmed,
      localPath: prev.localPath.trim() || join(homedir(), trimmed),
      sshBasePath: prev.sshBasePath.trim() || `~/code/${trimmed}`,
    }));
    setError("");
    setStatus("");
    setStep(draft.backendKind === "local" ? "path" : "target");
  };

  const submitTarget = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("SSH target cannot be empty.");
      return;
    }

    setBusy(true);
    setError("");
    setStatus(`Testing ${trimmed}...`);
    setDraft((prev) => ({ ...prev, sshTarget: trimmed }));

    const result = testSshConnection(trimmed);
    setBusy(false);
    if (!result.ok) {
      setError(result.detail);
      setStatus("");
      return;
    }

    setStatus(result.detail);
    setStep("path");
  };

  const submitPath = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(
        draft.backendKind === "local"
          ? "Local path cannot be empty."
          : "Remote base path cannot be empty.",
      );
      return;
    }

    setError("");

    if (draft.backendKind === "local") {
      const submitError = await onSubmit({
        name: draft.name.trim(),
        path: trimmed,
        backendKind: "local",
        backendBasePath: trimmed,
      });
      if (submitError) {
        setError(submitError);
      }
      return;
    }

    setBusy(true);
    setStatus(`Preparing ${trimmed} on ${draft.sshTarget}...`);
    const result = ensureSshBasePath(draft.sshTarget, trimmed);
    setBusy(false);

    if (!result.ok || !result.resolvedPath) {
      setError(result.detail);
      setStatus("");
      return;
    }

    setStatus(result.detail);
    const submitError = await onSubmit({
      name: draft.name.trim(),
      path: result.resolvedPath,
      backendKind: "ssh",
      backendTarget: draft.sshTarget,
      backendBasePath: result.resolvedPath,
      backendDisplayName: `${draft.sshTarget}:${result.resolvedPath}`,
    });
    if (submitError) {
      setError(submitError);
      return;
    }
  };

  const modalWidth = Math.max(56, Math.min(92, (process.stdout.columns || 80) - 4));

  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        backgroundColor="black"
        width={modalWidth}
      >
        <Text bold color="cyan">
          {currentTitle}
        </Text>

        {step === "backend" && (
          <Box flexDirection="column" marginTop={1}>
            {backendOptions.map((option, index) => {
              const active = index === backendIndex;
              return (
                <Box key={option.kind} flexDirection="column" marginBottom={1}>
                  <Text color={active ? "cyan" : undefined} bold={active}>
                    {active ? "▸ " : "  "}
                    {option.key.toUpperCase()} {option.label}
                  </Text>
                  <Text dimColor>{option.detail}</Text>
                </Box>
              );
            })}
          </Box>
        )}

        {step === "name" && (
          <Box marginTop={1}>
            <Text>Name: </Text>
            <InkTextInput
              value={draft.name}
              onChange={(value) => setDraft((prev) => ({ ...prev, name: value }))}
              onSubmit={submitName}
            />
          </Box>
        )}

        {step === "target" && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Example: `deploy@my-vps`</Text>
            <Box marginTop={1}>
              <Text>Target: </Text>
              <InkTextInput
                value={draft.sshTarget}
                onChange={(value) =>
                  setDraft((prev) => ({ ...prev, sshTarget: value }))
                }
                onSubmit={submitTarget}
              />
            </Box>
          </Box>
        )}

        {step === "path" && (
          <Box flexDirection="column" marginTop={1}>
            {draft.backendKind === "local" ? (
              <Text dimColor>Folder Gladius should create or reuse locally.</Text>
            ) : (
              <Text dimColor>
                Base directory on the VPS where repos will be cloned.
              </Text>
            )}
            <Box marginTop={1}>
              <Text>{draft.backendKind === "local" ? "Path: " : "Base: "}</Text>
              <InkTextInput
                value={
                  draft.backendKind === "local"
                    ? draft.localPath
                    : draft.sshBasePath
                }
                onChange={(value) =>
                  setDraft((prev) =>
                    prev.backendKind === "local"
                      ? { ...prev, localPath: value }
                      : { ...prev, sshBasePath: value },
                  )
                }
                onSubmit={(value) => {
                  void submitPath(value);
                }}
              />
            </Box>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            backend: {draft.backendKind}
            {draft.name.trim() ? ` | name: ${draft.name.trim()}` : ""}
            {draft.backendKind === "ssh" && draft.sshTarget.trim()
              ? ` | target: ${draft.sshTarget.trim()}`
              : ""}
          </Text>
          {status && <Text color="green">{status}</Text>}
          {error && <Text color="red">{error}</Text>}
          {busy && <Text dimColor>Working...</Text>}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {step === "backend"
              ? "↑↓ Select l Local s SSH ⏎ Continue Esc Cancel"
              : `${canGoBack ? "Esc Back " : ""}⏎ Continue`}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
