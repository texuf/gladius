import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { statSync } from "fs";
import { useStore } from "../store/index.js";
import {
  buildTaskTranscriptSnapshot,
  type TaskTranscriptSnapshot,
} from "../services/taskTranscript.js";

const TRANSCRIPT_RESERVED_ROWS = 9;
const TRANSCRIPT_HORIZONTAL_CHROME = 4;
const MIN_TRANSCRIPT_ROWS = 6;
const MIN_TRANSCRIPT_COLS = 40;
const TRANSCRIPT_REFRESH_MS = 1500;

function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  if (line.length <= width) return [line];

  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch?.[1] ?? "";
  const continuationIndent = indent.length < width - 4 ? indent : "";
  const wrapped: string[] = [];
  let rest = line;

  while (rest.length > width) {
    const slice = rest.slice(0, width + 1);
    let breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\t"));
    if (breakAt <= Math.max(8, indent.length)) breakAt = width;

    wrapped.push(rest.slice(0, breakAt).trimEnd());
    rest = `${continuationIndent}${rest.slice(breakAt).trimStart()}`;
  }

  wrapped.push(rest);
  return wrapped;
}

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => wrapLine(line, width));
}

function formatBytes(value: number | null): string {
  if (value === null) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function snapshotSignature(snapshot: TaskTranscriptSnapshot | null): string {
  if (!snapshot) return "none";
  return [
    snapshot.model ?? "none",
    snapshot.filePath ?? "no-file",
    snapshot.fileMtimeMs ?? "no-mtime",
    snapshot.fileSizeBytes ?? "no-size",
    snapshot.recordCount,
    snapshot.error ?? "ok",
  ].join(":");
}

function lineStyle(line: string): {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
} {
  if (/^\[\d+\]/.test(line)) return { color: "cyan", bold: true };
  if (line.includes("[tool use]") || line.includes("function_call")) {
    return { color: "magenta" };
  }
  if (line.includes("[tool result") || line.includes("call_output")) {
    return { color: "green" };
  }
  if (line.includes("[thinking]") || line.includes("reasoning")) {
    return { color: "yellow" };
  }
  if (line.trim().startsWith("metadata:") || line.includes(" metadata:")) {
    return { dimColor: true };
  }
  return {};
}

export function TaskTranscript() {
  const activeTask = useStore((s) => s.activeTask);
  const activeRepo = useStore((s) => s.activeRepo);
  const setView = useStore((s) => s.setView);
  const setFocusPane = useStore((s) => s.setFocusPane);
  const [screenRows, setScreenRows] = useState(process.stdout.rows || 24);
  const [screenCols, setScreenCols] = useState(process.stdout.columns || 80);
  const [scrollTop, setScrollTop] = useState(0);
  const pendingInitialScrollRef = useRef(true);
  const pendingRefreshBottomScrollRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const snapshotRef = useRef<TaskTranscriptSnapshot | null>(null);
  const snapshotSignatureRef = useRef("none");
  const [snapshot, setSnapshot] = useState<TaskTranscriptSnapshot | null>(() =>
    activeTask ? buildTaskTranscriptSnapshot(activeTask) : null,
  );

  useEffect(() => {
    pendingInitialScrollRef.current = true;
    pendingRefreshBottomScrollRef.current = false;
    stickToBottomRef.current = true;
    setSnapshot(activeTask ? buildTaskTranscriptSnapshot(activeTask) : null);
  }, [activeTask?.id]);

  useEffect(() => {
    snapshotRef.current = snapshot;
    snapshotSignatureRef.current = snapshotSignature(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (!activeTask) return;

    const interval = setInterval(() => {
      const currentSnapshot = snapshotRef.current;
      if (currentSnapshot?.filePath && !currentSnapshot.error) {
        try {
          const stats = statSync(currentSnapshot.filePath);
          if (
            stats.mtimeMs === currentSnapshot.fileMtimeMs &&
            stats.size === currentSnapshot.fileSizeBytes
          ) {
            return;
          }
        } catch {
          // Fall through and rebuild so the view can show the read error.
        }
      }

      const nextSnapshot = buildTaskTranscriptSnapshot(activeTask);
      const nextSignature = snapshotSignature(nextSnapshot);
      if (nextSignature === snapshotSignatureRef.current) return;

      if (stickToBottomRef.current) {
        pendingRefreshBottomScrollRef.current = true;
      }
      setSnapshot(nextSnapshot);
    }, TRANSCRIPT_REFRESH_MS);

    return () => clearInterval(interval);
  }, [
    activeTask?.id,
    activeTask?.model,
    activeTask?.claude_session_id,
    activeTask?.codex_session_id,
    activeTask?.worktree_path,
  ]);

  useEffect(() => {
    const handleResize = () => {
      setScreenRows(process.stdout.rows || 24);
      setScreenCols(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  const viewportRows = Math.max(
    MIN_TRANSCRIPT_ROWS,
    screenRows - TRANSCRIPT_RESERVED_ROWS,
  );
  const contentWidth = Math.max(
    MIN_TRANSCRIPT_COLS,
    screenCols - TRANSCRIPT_HORIZONTAL_CHROME,
  );
  const wrappedLines = useMemo(
    () => wrapLines(snapshot?.lines ?? [], contentWidth),
    [snapshot, contentWidth],
  );
  const maxScrollTop = Math.max(0, wrappedLines.length - viewportRows);
  const visibleLines = wrappedLines.slice(scrollTop, scrollTop + viewportRows);

  useEffect(() => {
    if (pendingInitialScrollRef.current) {
      pendingInitialScrollRef.current = false;
      pendingRefreshBottomScrollRef.current = false;
      stickToBottomRef.current = true;
      setScrollTop(maxScrollTop);
      return;
    }

    if (pendingRefreshBottomScrollRef.current) {
      pendingRefreshBottomScrollRef.current = false;
      stickToBottomRef.current = true;
      setScrollTop(maxScrollTop);
      return;
    }

    setScrollTop((current) => Math.min(current, maxScrollTop));
  }, [maxScrollTop, snapshot]);

  useEffect(() => {
    if (
      pendingInitialScrollRef.current ||
      pendingRefreshBottomScrollRef.current
    ) {
      return;
    }
    stickToBottomRef.current = scrollTop >= maxScrollTop;
  }, [scrollTop, maxScrollTop]);

  useInput((input, key) => {
    if (useStore.getState().modal?.type === "hotkeyMenu") return;

    if (key.escape) {
      setFocusPane("none");
      setView("taskView");
      return;
    }

    const pageRows = Math.max(1, viewportRows - 1);
    if (key.upArrow) {
      setScrollTop((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setScrollTop((value) => Math.min(maxScrollTop, value + 1));
      return;
    }
    if (key.pageUp) {
      setScrollTop((value) => Math.max(0, value - pageRows));
      return;
    }
    if (key.pageDown || input === " ") {
      setScrollTop((value) => Math.min(maxScrollTop, value + pageRows));
      return;
    }
    if (key.home || input === "g") {
      setScrollTop(0);
      return;
    }
    if (key.end || input === "G") {
      setScrollTop(maxScrollTop);
    }
  });

  if (!activeTask || !snapshot) return null;

  const modelLabel = snapshot.model ?? "no model";
  const position =
    wrappedLines.length === 0
      ? "0/0"
      : `${Math.min(scrollTop + 1, wrappedLines.length)}/${wrappedLines.length}`;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="column">
          <Text bold color="cyan">
            Transcript
            <Text dimColor> ({modelLabel})</Text>
          </Text>
          <Text dimColor wrap="truncate">
            {activeRepo ? `${activeRepo.name}/` : ""}
            {activeTask.label}
          </Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text dimColor>{position}</Text>
          <Text dimColor>
            {snapshot.recordCount} records,{" "}
            {formatBytes(snapshot.fileSizeBytes)}
          </Text>
        </Box>
      </Box>

      {snapshot.error && (
        <Box marginBottom={1}>
          <Text color="red">{snapshot.error}</Text>
        </Box>
      )}

      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={snapshot.error ? "red" : "gray"}
        paddingX={1}
        height={viewportRows + 2}
      >
        {visibleLines.map((line, index) => {
          const style = lineStyle(line);
          return (
            <Text
              key={`${scrollTop}-${index}`}
              color={style.color}
              bold={style.bold}
              dimColor={style.dimColor}
              wrap="truncate"
            >
              {line || " "}
            </Text>
          );
        })}
      </Box>

      {snapshot.filePath && (
        <Text dimColor wrap="truncate">
          {snapshot.filePath}
        </Text>
      )}
    </Box>
  );
}
