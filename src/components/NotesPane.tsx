import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { updateTask } from "../services/db.js";

export function NotesPane() {
  const activeTask = useStore((s) => s.activeTask);
  const focusPane = useStore((s) => s.focusPane);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setTasks = useStore((s) => s.setTasks);
  const [editValue, setEditValue] = useState(activeTask?.description || "");
  const isEditing = focusPane === "notes";

  if (!activeTask) return null;

  const handleSubmit = () => {
    if (activeTask) {
      const updates = { description: editValue };
      updateTask(activeTask.id, updates);
      setActiveTask({ ...activeTask, ...updates });
      setTasks(useStore.getState().tasks.map((t) => t.id === activeTask.id ? { ...t, ...updates } : t));
    }
    setFocusPane("none");
  };

  if (isEditing) {
    return (
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor="cyan"
        paddingX={1}
        width="100%"
      >
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            Notes
          </Text>
          <Text dimColor>⏎ Save  Esc Cancel</Text>
        </Box>
        <Box marginTop={1}>
          <InkTextInput
            value={editValue}
            onChange={setEditValue}
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      width="100%"
    >
      <Text bold color="cyan" wrap="wrap">
        {(activeTask.description || "").toUpperCase()}
      </Text>
    </Box>
  );
}
