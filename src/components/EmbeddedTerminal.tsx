import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Terminal } from "@xterm/headless";
import { execSync } from "child_process";
import {
  getOrCreateSession,
  getSession,
  getSessionCwd,
} from "../services/terminalManager.js";
import { useStore } from "../store/index.js";

interface EmbeddedTerminalProps {
  taskId: string;
  cwd: string;
  command?: string[];
  focused?: boolean;
  paused?: boolean;
  rows?: number;
  cols?: number;
  singleEsc?: boolean;
  onEsc?: (pid: number) => void;
  onError?: (message: string) => void;
}

// Convert xterm buffer cell attributes to ANSI SGR escape sequences
function cellToAnsi(
  cell: {
    getFgColor: () => number;
    getBgColor: () => number;
    isBold: () => number;
    isDim: () => number;
    isItalic: () => number;
    isUnderline: () => number;
    isInverse: () => number;
    getFgColorMode: () => number;
    getBgColorMode: () => number;
  },
  prevCell: typeof cell | null,
): string {
  const codes: number[] = [];

  const fgMode = cell.getFgColorMode();
  const bgMode = cell.getBgColorMode();
  const fg = cell.getFgColor();
  const bg = cell.getBgColor();
  const bold = cell.isBold();
  const dim = cell.isDim();
  const italic = cell.isItalic();
  const underline = cell.isUnderline();
  const inverse = cell.isInverse();

  if (!prevCell) {
    if (bold) codes.push(1);
    if (dim) codes.push(2);
    if (italic) codes.push(3);
    if (underline) codes.push(4);
    if (inverse) codes.push(7);

    if (fgMode === 1) codes.push(38, 5, fg);
    else if (fgMode === 2)
      codes.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
    else if (fgMode === 3) {
      if (fg < 8) codes.push(30 + fg);
      else codes.push(90 + (fg - 8));
    }

    if (bgMode === 1) codes.push(48, 5, bg);
    else if (bgMode === 2)
      codes.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
    else if (bgMode === 3) {
      if (bg < 8) codes.push(40 + bg);
      else codes.push(100 + (bg - 8));
    }
  } else {
    const changed =
      fg !== prevCell.getFgColor() ||
      bg !== prevCell.getBgColor() ||
      fgMode !== prevCell.getFgColorMode() ||
      bgMode !== prevCell.getBgColorMode() ||
      bold !== prevCell.isBold() ||
      dim !== prevCell.isDim() ||
      italic !== prevCell.isItalic() ||
      underline !== prevCell.isUnderline() ||
      inverse !== prevCell.isInverse();

    if (!changed) return "";

    codes.push(0);
    if (bold) codes.push(1);
    if (dim) codes.push(2);
    if (italic) codes.push(3);
    if (underline) codes.push(4);
    if (inverse) codes.push(7);

    if (fgMode === 1) codes.push(38, 5, fg);
    else if (fgMode === 2)
      codes.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
    else if (fgMode === 3) {
      if (fg < 8) codes.push(30 + fg);
      else codes.push(90 + (fg - 8));
    }

    if (bgMode === 1) codes.push(48, 5, bg);
    else if (bgMode === 2)
      codes.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
    else if (bgMode === 3) {
      if (bg < 8) codes.push(40 + bg);
      else codes.push(100 + (bg - 8));
    }
  }

  if (codes.length === 0) return "";
  return `\x1b[${codes.join(";")}m`;
}

function bufferToAnsiLines(term: Terminal): string[] {
  const lines: string[] = [];
  const buffer = term.buffer.active;
  const baseY = buffer.baseY;

  for (let y = baseY; y < baseY + term.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) {
      lines.push("");
      continue;
    }

    let result = "";
    let prevCell: any = null;

    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const char = cell.getChars();
      const ansi = cellToAnsi(cell as any, prevCell);
      result += ansi + (char || " ");
      prevCell = cell;
    }

    result += "\x1b[0m";
    result = result.replace(/\x1b\[0m$/, "").trimEnd() + "\x1b[0m";
    lines.push(result);
  }

  return lines;
}

export function getCwd(taskId: string, pid: number): string {
  const sessionPath = getSessionCwd(taskId);
  if (sessionPath) {
    return sessionPath;
  }

  try {
    const result = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      encoding: "utf-8",
      timeout: 2000,
    });
    const match = result.match(/^n(.+)$/m);
    return match ? match[1] : process.env.HOME || "/";
  } catch {
    return process.env.HOME || "/";
  }
}

const DEFAULT_CHROME_ROWS = 7;
const DEFAULT_CHROME_COLS = 4;

export function EmbeddedTerminal({
  taskId,
  cwd,
  command,
  focused = true,
  paused = false,
  rows: propRows,
  cols: propCols,
  singleEsc = false,
  onEsc,
  onError,
}: EmbeddedTerminalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const stdinListenerRef = useRef<((data: Buffer | string) => void) | null>(
    null,
  );
  const renderIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(focused);
  const procRef = useRef<any>(null);
  const pendingInputRef = useRef<string[]>([]);
  const paneType = taskId.endsWith("-console") ? "console" : "terminal";

  // Keep focusedRef in sync and flush any buffered input
  useEffect(() => {
    focusedRef.current = focused;
    if (focused && pendingInputRef.current.length > 0 && procRef.current) {
      for (const data of pendingInputRef.current) {
        try {
          procRef.current.terminal!.write(data);
        } catch {}
      }
      pendingInputRef.current = [];
    }
    if (!focused) {
      pendingInputRef.current = [];
    }
  }, [focused]);

  // Attach to (or create) persistent session; detach on unmount
  useEffect(() => {
    const cols =
      propCols ??
      Math.max(40, (process.stdout.columns || 80) - DEFAULT_CHROME_COLS);
    const rows =
      propRows ??
      Math.max(10, (process.stdout.rows || 24) - DEFAULT_CHROME_ROWS);

    let session;
    try {
      session = getOrCreateSession(taskId, cwd, cols, rows, command);
    } catch (e: any) {
      onError?.(`Failed to open terminal: ${e.message || e}`);
      return;
    }

    const { proc, xterm } = session;
    procRef.current = proc;

    // Resize to match current dimensions if they changed
    if (session.cols !== cols || session.rows !== rows) {
      try {
        proc.terminal!.resize(cols, rows);
        xterm.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
      } catch {}
    }

    // Render immediately from existing buffer
    setLines(bufferToAnsiLines(xterm));

    // Raw stdin → PTY with double-Esc detection
    // Single Esc → forwarded to PTY (e.g. vim insert→normal)
    // Double Esc (two bare Esc within 300ms) → unfocus pane
    let firstEscTime = 0;

    const onStdinData = (data: Buffer | string) => {
      if (!focusedRef.current) {
        // React hasn't re-rendered yet — check the store directly
        // (Zustand set() is synchronous, so focusPane reflects the true state)
        if (useStore.getState().focusPane === paneType) {
          const str = typeof data === "string" ? data : data.toString();
          pendingInputRef.current.push(str);
        }
        return;
      }

      const str = typeof data === "string" ? data : data.toString();
      const firstByte = typeof data === "string" ? data.charCodeAt(0) : data[0];

      // Check for bare Esc: single \x1b byte
      if (str.length === 1 && firstByte === 0x1b) {
        // Console pane: single Esc immediately unfocuses (no forwarding)
        if (singleEsc) {
          onEsc?.(proc.pid);
          return;
        }

        const now = Date.now();

        // Second bare Esc within 300ms → unfocus
        if (now - firstEscTime < 300) {
          firstEscTime = 0;
          if (escTimerRef.current) {
            clearTimeout(escTimerRef.current);
            escTimerRef.current = null;
          }
          onEsc?.(proc.pid);
          return;
        }

        // First bare Esc → wait to see if it's a sequence or double-tap
        firstEscTime = now;
        escTimerRef.current = setTimeout(() => {
          escTimerRef.current = null;
          // Timed out — it was a single bare Esc, forward to PTY
          try {
            proc.terminal!.write("\x1b");
          } catch {}
        }, 100);
        return;
      }

      // If waiting on Esc timeout, it's an escape sequence — forward both
      if (escTimerRef.current) {
        clearTimeout(escTimerRef.current);
        escTimerRef.current = null;
        try {
          proc.terminal!.write("\x1b" + str);
        } catch {}
        return;
      }

      // Normal data — forward to PTY
      try {
        proc.terminal!.write(str);
      } catch {}
    };

    stdinListenerRef.current = onStdinData;
    process.stdin.on("data", onStdinData);
    process.stdin.resume();

    // Render loop at ~30fps
    renderIntervalRef.current = setInterval(() => {
      setLines(bufferToAnsiLines(xterm));
    }, 33);

    // Handle resize
    const onResize = () => {
      if (propRows || propCols) return;
      const newCols = Math.max(
        40,
        (process.stdout.columns || 80) - DEFAULT_CHROME_COLS,
      );
      const newRows = Math.max(
        10,
        (process.stdout.rows || 24) - DEFAULT_CHROME_ROWS,
      );
      try {
        proc.terminal!.resize(newCols, newRows);
        xterm.resize(newCols, newRows);
        session!.cols = newCols;
        session!.rows = newRows;
      } catch {}
    };
    process.stdout.on("resize", onResize);

    // Cleanup: detach listeners only — session stays alive
    return () => {
      if (escTimerRef.current) {
        clearTimeout(escTimerRef.current);
        escTimerRef.current = null;
      }
      if (renderIntervalRef.current) {
        clearInterval(renderIntervalRef.current);
        renderIntervalRef.current = null;
      }
      if (stdinListenerRef.current) {
        process.stdin.removeListener("data", stdinListenerRef.current);
        stdinListenerRef.current = null;
      }
      process.stdout.removeListener("resize", onResize);
    };
  }, [taskId]);

  // Pause/resume render loop for copy mode
  const xtermRef = useRef<Terminal | null>(null);

  // Store xterm ref when session is created (set inside the main useEffect above
  // isn't accessible here, so we look it up from the session manager)
  useEffect(() => {
    const session = getSession(taskId);
    if (session) xtermRef.current = session.xterm;
  }, [taskId]);

  useEffect(() => {
    if (paused) {
      // Stop the render interval
      if (renderIntervalRef.current) {
        clearInterval(renderIntervalRef.current);
        renderIntervalRef.current = null;
      }
    } else {
      // Resume: do one immediate render, then restart interval
      if (xtermRef.current) {
        setLines(bufferToAnsiLines(xtermRef.current));
      }
      if (!renderIntervalRef.current && xtermRef.current) {
        const xterm = xtermRef.current;
        renderIntervalRef.current = setInterval(() => {
          setLines(bufferToAnsiLines(xterm));
        }, 33);
      }
    }
  }, [paused]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
