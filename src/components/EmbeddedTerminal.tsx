import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Terminal } from "@xterm/headless";
import { execSync } from "child_process";

interface EmbeddedTerminalProps {
  cwd: string;
  onExit: (cwd: string) => void;
  onError: (message: string) => void;
}

// Convert xterm buffer cell attributes to ANSI SGR escape sequences
function cellToAnsi(
  cell: { getFgColor: () => number; getBgColor: () => number; isBold: () => number; isDim: () => number; isItalic: () => number; isUnderline: () => number; isInverse: () => number; getFgColorMode: () => number; getBgColorMode: () => number },
  prevCell: typeof cell | null
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
    else if (fgMode === 2) codes.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
    else if (fgMode === 3) { if (fg < 8) codes.push(30 + fg); else codes.push(90 + (fg - 8)); }

    if (bgMode === 1) codes.push(48, 5, bg);
    else if (bgMode === 2) codes.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
    else if (bgMode === 3) { if (bg < 8) codes.push(40 + bg); else codes.push(100 + (bg - 8)); }
  } else {
    const changed =
      fg !== prevCell.getFgColor() || bg !== prevCell.getBgColor() ||
      fgMode !== prevCell.getFgColorMode() || bgMode !== prevCell.getBgColorMode() ||
      bold !== prevCell.isBold() || dim !== prevCell.isDim() ||
      italic !== prevCell.isItalic() || underline !== prevCell.isUnderline() ||
      inverse !== prevCell.isInverse();

    if (!changed) return "";

    codes.push(0);
    if (bold) codes.push(1);
    if (dim) codes.push(2);
    if (italic) codes.push(3);
    if (underline) codes.push(4);
    if (inverse) codes.push(7);

    if (fgMode === 1) codes.push(38, 5, fg);
    else if (fgMode === 2) codes.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
    else if (fgMode === 3) { if (fg < 8) codes.push(30 + fg); else codes.push(90 + (fg - 8)); }

    if (bgMode === 1) codes.push(48, 5, bg);
    else if (bgMode === 2) codes.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
    else if (bgMode === 3) { if (bg < 8) codes.push(40 + bg); else codes.push(100 + (bg - 8)); }
  }

  if (codes.length === 0) return "";
  return `\x1b[${codes.join(";")}m`;
}

function bufferToAnsiLines(term: Terminal): string[] {
  const lines: string[] = [];
  const buffer = term.buffer.active;

  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) { lines.push(""); continue; }

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

function getCwd(pid: number): string {
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

const CHROME_ROWS = 7;
const CHROME_COLS = 4;

export function EmbeddedTerminal({ cwd, onExit, onError }: EmbeddedTerminalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const procRef = useRef<ReturnType<typeof Bun.spawn> | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const stdinListenerRef = useRef<((data: Buffer | string) => void) | null>(null);
  const renderIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanedUpRef = useRef(false);

  useEffect(() => {
    const cols = Math.max(40, (process.stdout.columns || 80) - CHROME_COLS);
    const rows = Math.max(10, (process.stdout.rows || 24) - CHROME_ROWS);

    // Create xterm headless terminal
    const xterm = new Terminal({ cols, rows, allowProposedApi: true });
    xtermRef.current = xterm;

    const shell = process.env.SHELL || "/bin/zsh";

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([shell, "-l"], {
        cwd,
        env: process.env as Record<string, string>,
        terminal: {
          cols,
          rows,
          name: "xterm-256color",
          data(_terminal: any, data: Buffer) {
            // PTY output → xterm
            xterm.write(new Uint8Array(data));
          },
        },
      });
    } catch (e: any) {
      onError(`Failed to open terminal: ${e.message || e}`);
      return;
    }
    procRef.current = proc;

    // Raw stdin → PTY with Esc detection
    const onStdinData = (data: Buffer | string) => {
      if (cleanedUpRef.current) return;

      const str = typeof data === "string" ? data : data.toString();
      const firstByte = typeof data === "string" ? data.charCodeAt(0) : data[0];

      // Check for bare Esc: single \x1b byte
      if (str.length === 1 && firstByte === 0x1b) {
        escTimerRef.current = setTimeout(() => {
          escTimerRef.current = null;
          const pid = proc.pid;
          cleanup();
          const shellCwd = getCwd(pid);
          onExit(shellCwd);
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
      const rendered = bufferToAnsiLines(xterm);
      setLines(rendered);
    }, 33);

    // Handle resize
    const onResize = () => {
      if (cleanedUpRef.current) return;
      const newCols = Math.max(40, (process.stdout.columns || 80) - CHROME_COLS);
      const newRows = Math.max(10, (process.stdout.rows || 24) - CHROME_ROWS);
      try {
        proc.terminal!.resize(newCols, newRows);
        xterm.resize(newCols, newRows);
      } catch {}
    };
    process.stdout.on("resize", onResize);

    const cleanup = () => {
      if (cleanedUpRef.current) return;
      cleanedUpRef.current = true;

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
      try {
        proc.terminal!.close();
      } catch {}
      try {
        proc.kill();
      } catch {}
      xterm.dispose();
    };

    return cleanup;
  }, []);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" flexGrow={1}>
      <Box paddingX={1}>
        <Text bold color="cyan">Terminal</Text>
        <Text dimColor>  (navigate to project dir, then press Esc)</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
