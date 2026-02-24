import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ReviewThread } from "../store/types.js";

interface Props {
  threads: ReviewThread[];
  onPaste: (text: string) => void;
  onResolve: (threadId: string) => void;
  onClose: () => void;
}

function formatThreadForPaste(thread: ReviewThread): string {
  const lines = ["Please fix this PR review comment:"];
  lines.push(`File: ${thread.path}`);
  if (thread.startLine && thread.startLine !== thread.line) {
    lines.push(`Lines: ${thread.startLine}-${thread.line}`);
  } else {
    lines.push(`Line: ${thread.line}`);
  }
  lines.push("");
  for (const c of thread.comments) {
    lines.push(`Comment by @${c.author}:`);
    lines.push(c.body);
    lines.push("");
  }
  return lines.join("\n");
}

export function PrCommentViewer({ threads, onPaste, onResolve, onClose }: Props) {
  const [selected, setSelected] = useState(0);
  const [localThreads, setLocalThreads] = useState(threads);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (localThreads.length === 0) return;

    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(localThreads.length - 1, s + 1));
      return;
    }

    if (input === "p") {
      const thread = localThreads[selected];
      if (thread) onPaste(formatThreadForPaste(thread));
      return;
    }

    if (input === "s") {
      const thread = localThreads[selected];
      if (!thread) return;
      onResolve(thread.id);
      const next = localThreads.filter((_, i) => i !== selected);
      setLocalThreads(next);
      if (selected >= next.length) setSelected(Math.max(0, next.length - 1));
      if (next.length === 0) onClose();
      return;
    }
  });

  const thread = localThreads[selected];
  const firstComment = thread?.comments[0];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      position="absolute"
      marginLeft={4}
      marginTop={2}
      width={72}
    >
      <Text bold color="cyan">
        {" "}PR Comments ({localThreads.length} unresolved){" "}
      </Text>
      <Box marginTop={1} />

      {localThreads.length === 0 ? (
        <Text dimColor>No unresolved threads.</Text>
      ) : (
        <Box flexDirection="column">
          {localThreads.map((t, i) => {
            const preview = t.comments[0]?.body.split("\n")[0]?.slice(0, 50) || "";
            return (
              <Box key={t.id} flexDirection="column">
                <Text color={i === selected ? "cyan" : undefined} bold={i === selected}>
                  {i === selected ? " \u25B8 " : "   "}
                  {t.path}:{t.line}
                </Text>
                <Text dimColor wrap="truncate">
                  {"     "}{preview}{preview.length >= 50 ? "..." : ""}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {thread && firstComment && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
          <Text bold>@{firstComment.author}</Text>
          <Text wrap="wrap">{firstComment.body.slice(0, 300)}{firstComment.body.length > 300 ? "..." : ""}</Text>
        </Box>
      )}

      <Box marginTop={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>
          {"↑↓ Navigate  p Paste to Console  s Resolve  Esc Close"}
        </Text>
      </Box>
    </Box>
  );
}
