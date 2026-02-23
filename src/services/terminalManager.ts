import { Terminal } from "@xterm/headless";

export interface TerminalSession {
  proc: ReturnType<typeof Bun.spawn>;
  xterm: Terminal;
  cols: number;
  rows: number;
}

const sessions = new Map<string, TerminalSession>();

export function getOrCreateSession(
  taskId: string,
  cwd: string,
  cols: number,
  rows: number
): TerminalSession {
  const existing = sessions.get(taskId);
  if (existing) return existing;

  const xterm = new Terminal({ cols, rows, allowProposedApi: true });
  const shell = process.env.SHELL || "/bin/zsh";

  const proc = Bun.spawn([shell, "-l"], {
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

  const session: TerminalSession = { proc, xterm, cols, rows };
  sessions.set(taskId, session);
  return session;
}

export function getSession(taskId: string): TerminalSession | undefined {
  return sessions.get(taskId);
}

export function destroySession(taskId: string): void {
  const session = sessions.get(taskId);
  if (!session) return;
  sessions.delete(taskId);
  try { session.proc.terminal!.close(); } catch {}
  try { session.proc.kill(); } catch {}
  session.xterm.dispose();
}

export function destroyAllSessions(): void {
  for (const taskId of [...sessions.keys()]) {
    destroySession(taskId);
  }
}
