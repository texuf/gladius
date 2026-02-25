import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { getAppState, setAppState } from "../services/db.js";

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
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [values, setValues] = useState<Record<string, string | null>>({});

  useEffect(() => {
    const loaded: Record<string, string | null> = {};
    for (const f of FIELDS) {
      loaded[f.key] = getAppState(f.key);
    }
    setValues(loaded);
  }, []);

  useInput((_input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
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
      setSelectedIndex(Math.min(FIELDS.length - 1, selectedIndex + 1));
    } else if (key.return) {
      setEditing(true);
      setEditValue("");
    }
  });

  const handleSubmit = (value: string) => {
    const field = FIELDS[selectedIndex];
    const trimmed = value.trim();
    if (trimmed) {
      setAppState(field.key, trimmed);
      setValues((prev) => ({ ...prev, [field.key]: trimmed }));
    }
    setEditing(false);
  };

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}GLADIUS{" "}
        </Text>
        <Text dimColor>  Settings</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>API Keys</Text>
      </Box>

      {FIELDS.map((field, i) => {
        const isSelected = i === selectedIndex;
        const isEditing = isSelected && editing;

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
                  onSubmit={handleSubmit}
                  mask="•"
                />
              ) : (
                <Text dimColor>{maskKey(values[field.key])}</Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
