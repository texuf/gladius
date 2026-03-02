import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { Task } from "../store/types.js";
import { getLatestTaskPrompt } from "../services/taskPrompt.js";

const PROMPT_REFRESH_MS = 4000;
const PROMPT_MAX_CHARS = 300;

function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncatePrompt(text: string): string {
  const normalized = normalizePrompt(text);
  if (normalized.length <= PROMPT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, PROMPT_MAX_CHARS - 1)}…`;
}

function formatPromptTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const datePart = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${datePart}, ${timePart}`;
}

export function TaskStatusPane({ task }: { task: Task }) {
  const [latestPrompt, setLatestPrompt] = useState<{
    text: string;
    formattedTime: string;
  } | null>(null);

  useEffect(() => {
    const refreshPrompt = () => {
      const prompt = getLatestTaskPrompt(task);
      if (!prompt) {
        setLatestPrompt(null);
        return;
      }
      setLatestPrompt({
        text: truncatePrompt(prompt.text),
        formattedTime: formatPromptTime(prompt.timestamp),
      });
    };

    refreshPrompt();
    const interval = setInterval(refreshPrompt, PROMPT_REFRESH_MS);
    return () => clearInterval(interval);
  }, [task.id, task.worktree_path, task.claude_session_id, task.codex_session_id]);

  const statusText = useMemo(() => {
    if (!latestPrompt) return "No prompt captured yet.";
    const timePart = latestPrompt.formattedTime ? `${latestPrompt.formattedTime} ` : "";
    return `${timePart}${latestPrompt.text}`;
  }, [latestPrompt]);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      width="100%"
    >
      <Text bold>Status</Text>
      <Text wrap="truncate-end">{statusText}</Text>
    </Box>
  );
}
