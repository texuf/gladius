import { Terminal } from "@xterm/headless";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, writeFileSync } from "fs";

export interface TerminalSession {
  proc: ReturnType<typeof Bun.spawn>;
  xterm: Terminal;
  cols: number;
  rows: number;
  command: string[];
  isNew: boolean;
}

const sessions = new Map<string, TerminalSession>();

// ── tmux helpers ──

const GLADIUS_DIR = join(homedir(), ".gladius");
const TMUX_CONF = join(GLADIUS_DIR, "tmux.conf");
const TMUX_SOCKET = "gladius";

let _tmuxAvailable: boolean | null = null;

function hasTmux(): boolean {
  if (_tmuxAvailable !== null) return _tmuxAvailable;
  const result = spawnSync("tmux", ["-V"]);
  _tmuxAvailable = result.status === 0;
  return _tmuxAvailable;
}

function ensureTmuxConf(): void {
  if (existsSync(TMUX_CONF)) return;
  if (!existsSync(GLADIUS_DIR)) mkdirSync(GLADIUS_DIR, { recursive: true });
  writeFileSync(
    TMUX_CONF,
    [
      "set -g prefix None",
      "unbind C-b",
      "set -g status off",
      "set -g escape-time 0",
      "set -g mouse off",
      "set -g default-terminal 'xterm-256color'",
      "",
    ].join("\n"),
  );
}

function tmuxSessionName(taskId: string): string {
  // tmux session names: alphanumeric, dash, underscore, period
  return `gladius-${taskId}`;
}

function tmuxSessionExists(name: string): boolean {
  const result = spawnSync("tmux", [
    "-L",
    TMUX_SOCKET,
    "has-session",
    "-t",
    name,
  ]);
  return result.status === 0;
}

function createTmuxSession(
  name: string,
  cwd: string,
  cols: number,
  rows: number,
  command: string[],
): void {
  ensureTmuxConf();
  // Wrap command in a login shell so ~/.zshrc / ~/.zprofile are sourced
  // (ensures PATH includes user-installed tools like protoc, buf, bun, go, etc.)
  const shell = process.env.SHELL || "/bin/zsh";
  const isLoginShell =
    command.length >= 2 && command[0] === shell && command[1] === "-l";
  const wrappedCommand = isLoginShell
    ? command
    : [
        shell,
        "-lc",
        `exec ${command.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
      ];

  // Create detached session with specified size
  const args = [
    "-L",
    TMUX_SOCKET,
    "-f",
    TMUX_CONF,
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    cwd,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "--",
    ...wrappedCommand,
  ];
  const result = spawnSync("tmux", args, {
    env: { ...process.env, TMUX: "" } as Record<string, string>, // allow nested tmux
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || "";
    throw new Error(`Failed to create tmux session: ${stderr}`);
  }
}

function killTmuxSession(name: string): void {
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-session", "-t", name]);
}

function resizeTmuxSession(name: string, cols: number, rows: number): void {
  spawnSync("tmux", [
    "-L",
    TMUX_SOCKET,
    "resize-window",
    "-t",
    name,
    "-x",
    String(cols),
    "-y",
    String(rows),
  ]);
}

// ── Public API ──

export function getOrCreateSession(
  taskId: string,
  cwd: string,
  cols: number,
  rows: number,
  command?: string[],
): TerminalSession {
  const existing = sessions.get(taskId);
  if (existing) {
    existing.isNew = false;
    return existing;
  }

  const xterm = new Terminal({ cols, rows, allowProposedApi: true });
  const cmd = command ?? [process.env.SHELL || "/bin/zsh", "-l"];

  if (hasTmux()) {
    const sessionName = tmuxSessionName(taskId);
    const alreadyExists = tmuxSessionExists(sessionName);

    if (!alreadyExists) {
      createTmuxSession(sessionName, cwd, cols, rows, cmd);
    } else {
      resizeTmuxSession(sessionName, cols, rows);
    }

    // Attach to tmux session via PTY
    const proc = Bun.spawn(
      ["tmux", "-L", TMUX_SOCKET, "attach-session", "-t", sessionName],
      {
        env: { ...process.env, TMUX: "" } as Record<string, string>,
        terminal: {
          cols,
          rows,
          name: "xterm-256color",
          data(_terminal: any, data: any) {
            xterm.write(new Uint8Array(data));
          },
        },
      },
    );

    const session: TerminalSession = {
      proc,
      xterm,
      cols,
      rows,
      command: cmd,
      isNew: !alreadyExists,
    };
    sessions.set(taskId, session);
    return session;
  }

  // Fallback: direct spawn (no persistence across restarts)
  const proc = Bun.spawn(cmd, {
    cwd,
    env: process.env as Record<string, string>,
    terminal: {
      cols,
      rows,
      name: "xterm-256color",
      data(_terminal: any, data: any) {
        xterm.write(new Uint8Array(data));
      },
    },
  });

  const session: TerminalSession = {
    proc,
    xterm,
    cols,
    rows,
    command: cmd,
    isNew: true,
  };
  sessions.set(taskId, session);
  return session;
}

export function getSession(taskId: string): TerminalSession | undefined {
  return sessions.get(taskId);
}

/**
 * Returns true when a session exists but its underlying process/pane is dead.
 * Used to recycle stale "[exited]" console sessions on focus.
 */
export function isSessionDead(taskId: string): boolean {
  const session = sessions.get(taskId);

  // Direct subprocess already exited (non-tmux fallback or detached attach proc).
  if (session && session.proc.exitCode !== null) {
    return true;
  }

  // tmux-backed session: detect "[exited]" pane via pane_dead flag.
  if (hasTmux()) {
    const result = spawnSync(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "list-panes",
        "-t",
        tmuxSessionName(taskId),
        "-F",
        "#{pane_dead}",
      ],
      { encoding: "utf-8" },
    );

    // Session no longer exists but we still have an in-memory handle -> stale/dead.
    if (result.status !== 0) {
      return !!session;
    }

    const paneStates = (result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (paneStates.length === 0) return false;
    return paneStates.every((state) => state === "1");
  }

  return false;
}

/**
 * Detach from session — kills the attach process but keeps the tmux session alive.
 * Used when switching tasks or exiting the app (sessions can be reattached later).
 */
export function detachSession(taskId: string): void {
  const session = sessions.get(taskId);
  if (!session) return;
  sessions.delete(taskId);
  try {
    session.proc.terminal!.close();
  } catch {}
  try {
    session.proc.kill();
  } catch {}
  session.xterm.dispose();
}

/**
 * Fully destroy session — kills both the attach process and the tmux session.
 * Used when closing/deleting a task.
 */
export function destroySession(taskId: string): void {
  detachSession(taskId);
  if (hasTmux()) {
    killTmuxSession(tmuxSessionName(taskId));
  }
}

/**
 * Detach all sessions — keeps tmux sessions alive for reattach on next app start.
 */
export function detachAllSessions(): void {
  for (const taskId of [...sessions.keys()]) {
    detachSession(taskId);
  }
}

/**
 * Destroy all sessions — kills everything. Used for full cleanup.
 */
export function destroyAllSessions(): void {
  for (const taskId of [...sessions.keys()]) {
    destroySession(taskId);
  }
}

/**
 * Write text to a session's PTY (sends keystrokes).
 * Returns false if no session exists.
 */
export function writeToSession(taskId: string, text: string): boolean {
  const session = sessions.get(taskId);
  if (!session) return false;
  try {
    session.proc.terminal!.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current shell cwd for a persistent session.
 * For tmux-backed sessions, this returns pane_current_path.
 */
export function getSessionCwd(taskId: string): string | null {
  if (!hasTmux()) return null;
  const sessionName = tmuxSessionName(taskId);
  const result = spawnSync(
    "tmux",
    [
      "-L",
      TMUX_SOCKET,
      "display-message",
      "-p",
      "-t",
      `${sessionName}:0.0`,
      "#{pane_current_path}",
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) return null;
  const path = result.stdout?.toString().trim();
  return path || null;
}
