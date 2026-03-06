import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import {
  getAppState,
  getAppStatesByPrefix,
  setAppState,
} from "../services/db.js";
import type { Reviewer } from "../store/types.js";
import {
  normalizeReviewerHotkey,
  normalizeReviewers,
  parseStoredReviewers,
} from "../utils/reviewers.js";

const FIELDS = [
  { label: "Anthropic API Key", key: "settings.anthropic_api_key" },
  { label: "OpenAI API Key", key: "settings.openai_api_key" },
] as const;

function maskKey(value: string | null): string {
  if (!value) return "Not set";
  if (value.length <= 4) return "•".repeat(value.length);
  return "•".repeat(value.length - 4) + value.slice(-4);
}

export function Settings() {
  const setView = useStore((s) => s.setView);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [editingReviewer, setEditingReviewer] = useState<{
    index: number;
    step: "name" | "handle" | "hotkey";
    draftName: string;
    draftHandle: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [values, setValues] = useState<Record<string, string | null>>({});
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [error, setError] = useState("");

  const totalItems = FIELDS.length + reviewers.length;
  const selectedReviewerIndex = selectedIndex - FIELDS.length;
  const selectedReviewer =
    selectedReviewerIndex >= 0 ? reviewers[selectedReviewerIndex] : null;

  useEffect(() => {
    const loaded: Record<string, string | null> = {};
    for (const f of FIELDS) {
      loaded[f.key] = getAppState(f.key);
    }
    setValues(loaded);
    setReviewers(parseStoredReviewers(getAppState("reviewers.global")));
  }, []);

  useInput((_input, key) => {
    if (useStore.getState().modal?.type === "hotkeyMenu") return;
    if (editingFieldKey || editingReviewer) {
      if (key.escape) {
        setEditingFieldKey(null);
        setEditingReviewer(null);
        setEditValue("");
        setError("");
      }
      return;
    }

    if (key.escape) {
      setView("projects");
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(
        Math.min(Math.max(0, totalItems - 1), selectedIndex + 1),
      );
    } else if (key.return) {
      const selectedField =
        selectedIndex < FIELDS.length ? FIELDS[selectedIndex] : null;
      if (selectedField) {
        setEditingFieldKey(selectedField.key);
        setEditValue("");
        setError("");
      } else if (selectedReviewer) {
        setEditingReviewer({
          index: selectedReviewerIndex,
          step: "name",
          draftName: selectedReviewer.name,
          draftHandle: selectedReviewer.handle,
        });
        setEditValue(selectedReviewer.name);
        setError("");
      }
    }
  });

  useEffect(() => {
    setSelectedIndex((idx) => Math.min(idx, Math.max(0, totalItems - 1)));
  }, [totalItems]);

  const handleFieldSubmit = (value: string) => {
    if (!editingFieldKey) return;
    const trimmed = value.trim();
    if (trimmed) {
      setAppState(editingFieldKey, trimmed);
      setValues((prev) => ({ ...prev, [editingFieldKey]: trimmed }));
    }
    setEditingFieldKey(null);
    setEditValue("");
  };

  const migrateRepoReviewerDefaults = (
    oldHandle: string,
    newHandle: string,
  ) => {
    if (oldHandle === newHandle) return;
    const rows = getAppStatesByPrefix("reviewers.repo.");
    for (const row of rows) {
      if (!row.value) continue;
      try {
        const handles = JSON.parse(row.value) as string[];
        if (!Array.isArray(handles) || !handles.includes(oldHandle)) continue;
        const updated = [
          ...new Set(handles.map((h) => (h === oldHandle ? newHandle : h))),
        ];
        setAppState(row.key, JSON.stringify(updated));
      } catch {
        // Ignore malformed legacy values.
      }
    }
  };

  const handleReviewerNameSubmit = (value: string) => {
    if (!editingReviewer) return;
    const fallbackName = reviewers[editingReviewer.index]?.name || "";
    const draftName = value.trim() || fallbackName;
    setEditingReviewer({ ...editingReviewer, step: "handle", draftName });
    setEditValue(reviewers[editingReviewer.index]?.handle || "");
    setError("");
  };

  const handleReviewerHandleSubmit = (value: string) => {
    if (!editingReviewer) return;
    const normalized = value.trim().replace(/^@/, "");
    if (!normalized) {
      setError("Handle cannot be empty.");
      return;
    }

    const duplicate = reviewers.some(
      (r, i) =>
        i !== editingReviewer.index &&
        r.handle.toLowerCase() === normalized.toLowerCase(),
    );
    if (duplicate) {
      setError(`@${normalized} already exists.`);
      return;
    }

    setEditingReviewer({
      ...editingReviewer,
      step: "hotkey",
      draftHandle: normalized,
    });
    setEditValue(reviewers[editingReviewer.index]?.hotkey || "");
    setError("");
  };

  const handleReviewerHotkeySubmit = (value: string) => {
    if (!editingReviewer) return;
    const normalized = value.trim().toLowerCase();
    const hotkey = normalized ? normalizeReviewerHotkey(normalized) : null;
    if (normalized && !hotkey) {
      setError("Hotkey must be a single letter a-z, or empty to clear.");
      return;
    }

    const duplicate = reviewers.some(
      (r, i) =>
        i !== editingReviewer.index &&
        normalizeReviewerHotkey(r.hotkey) === hotkey,
    );
    if (hotkey && duplicate) {
      setError(`Hotkey '${hotkey}' is already assigned.`);
      return;
    }

    const next = [...reviewers];
    const prev = next[editingReviewer.index];
    if (!prev) {
      setEditingReviewer(null);
      setEditValue("");
      return;
    }

    next[editingReviewer.index] = {
      name: editingReviewer.draftName.trim() || editingReviewer.draftHandle,
      handle: editingReviewer.draftHandle,
      hotkey,
    };
    const normalizedReviewers = normalizeReviewers(next);
    setReviewers(normalizedReviewers);
    setAppState("reviewers.global", JSON.stringify(normalizedReviewers));
    migrateRepoReviewerDefaults(prev.handle, editingReviewer.draftHandle);
    setEditingReviewer(null);
    setEditValue("");
    setError("");
  };

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}
          GLADIUS{" "}
        </Text>
        <Text dimColor> Settings</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>API Keys</Text>
      </Box>

      {FIELDS.map((field, i) => {
        const isSelected = i === selectedIndex;
        const isEditing = isSelected && editingFieldKey === field.key;

        return (
          <Box key={field.key} paddingLeft={1} flexDirection="column">
            <Box>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "▸ " : "  "}
                {field.label}:{" "}
              </Text>
              {isEditing ? (
                <InkTextInput
                  value={editValue}
                  onChange={setEditValue}
                  onSubmit={handleFieldSubmit}
                  mask="•"
                />
              ) : (
                <Text dimColor>{maskKey(values[field.key])}</Text>
              )}
            </Box>
          </Box>
        );
      })}

      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text bold>Reviewers</Text>
      </Box>

      {reviewers.length === 0 && (
        <Box paddingLeft={1}>
          <Text dimColor>No global reviewers configured yet.</Text>
        </Box>
      )}

      {reviewers.map((reviewer, i) => {
        const globalIndex = FIELDS.length + i;
        const isSelected = globalIndex === selectedIndex;
        const isEditingName =
          isSelected &&
          editingReviewer?.index === i &&
          editingReviewer.step === "name";
        const isEditingHandle =
          isSelected &&
          editingReviewer?.index === i &&
          editingReviewer.step === "handle";
        const isEditingHotkey =
          isSelected &&
          editingReviewer?.index === i &&
          editingReviewer.step === "hotkey";

        return (
          <Box key={reviewer.handle} paddingLeft={1} flexDirection="column">
            <Box>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "▸ " : "  "}
                Reviewer:{" "}
              </Text>
              {!isEditingName && !isEditingHandle && (
                <Text>
                  {reviewer.name} <Text dimColor>@{reviewer.handle}</Text>
                  {reviewer.hotkey && (
                    <Text dimColor> [{reviewer.hotkey}]</Text>
                  )}
                </Text>
              )}
            </Box>

            {isEditingName && (
              <Box paddingLeft={3}>
                <Text>Name: </Text>
                <InkTextInput
                  value={editValue}
                  onChange={setEditValue}
                  onSubmit={handleReviewerNameSubmit}
                />
              </Box>
            )}

            {isEditingHandle && (
              <Box paddingLeft={3}>
                <Text>@</Text>
                <InkTextInput
                  value={editValue}
                  onChange={setEditValue}
                  onSubmit={handleReviewerHandleSubmit}
                />
              </Box>
            )}

            {isEditingHotkey && (
              <Box paddingLeft={3}>
                <Text>Hotkey: </Text>
                <InkTextInput
                  value={editValue}
                  onChange={setEditValue}
                  onSubmit={handleReviewerHotkeySubmit}
                />
              </Box>
            )}
          </Box>
        );
      })}

      {editingReviewer && (
        <Box marginTop={1}>
          <Text dimColor>
            {editingReviewer.step === "name"
              ? "Editing reviewer name (Enter to continue, Esc to cancel)"
              : editingReviewer.step === "handle"
                ? "Editing reviewer handle (Enter to continue, Esc to cancel)"
                : "Editing reviewer hotkey (a-z, blank clears, Enter to save, Esc to cancel)"}
          </Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
