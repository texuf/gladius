import { spawn, spawnSync } from "child_process";
import { posix as posixPath } from "path";
import { existsSync } from "fs";
import type { Project, ProjectBackendKind } from "../store/types.js";

export interface ResolvedProjectBackend {
  kind: ProjectBackendKind;
  target: string | null;
  basePath: string;
  displayName: string;
}

export interface RunCommandOptions {
  cwd?: string | null;
  interactive?: boolean;
}

export interface BackendRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DependencyCheckItem {
  tool: string;
  status: "ok" | "missing" | "warning";
  requiredFor: "repo" | "pr" | "llm" | "optional";
  detail: string;
}

export interface DependencyCheckResult {
  backend: ResolvedProjectBackend;
  checkedAt: string;
  items: DependencyCheckItem[];
}

export interface BackendValidationResult {
  ok: boolean;
  detail: string;
}

export interface RemotePathValidationResult extends BackendValidationResult {
  resolvedPath: string | null;
}

const DEPENDENCY_CHECKS: Array<{
  tool: string;
  command: string;
  requiredFor: DependencyCheckItem["requiredFor"];
}> = [
  {
    tool: "shell",
    command: 'command -v "${SHELL:-sh}" >/dev/null 2>&1 || command -v sh >/dev/null 2>&1',
    requiredFor: "repo",
  },
  {
    tool: "git",
    command: "command -v git >/dev/null 2>&1",
    requiredFor: "repo",
  },
  {
    tool: "gh",
    command: "command -v gh >/dev/null 2>&1",
    requiredFor: "pr",
  },
  {
    tool: "claude",
    command: "command -v claude >/dev/null 2>&1",
    requiredFor: "llm",
  },
  {
    tool: "codex",
    command: "command -v codex >/dev/null 2>&1",
    requiredFor: "llm",
  },
  {
    tool: "bun",
    command: "command -v bun >/dev/null 2>&1",
    requiredFor: "optional",
  },
];

export function resolveProjectBackend(
  project: Pick<
    Project,
    "backend_kind" | "backend_target" | "backend_base_path" | "backend_display_name" | "path" | "name"
  >,
): ResolvedProjectBackend {
  const kind = project.backend_kind ?? "local";
  const basePath = project.backend_base_path?.trim() || project.path;
  const target = kind === "ssh" ? project.backend_target?.trim() || null : null;
  const displayName =
    project.backend_display_name?.trim() ||
    (kind === "ssh" && target ? `${target}:${basePath}` : project.name);

  return {
    kind,
    target,
    basePath,
    displayName,
  };
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildRemoteCommand(cwd: string, command: string): string {
  return `cd ${quoteShell(cwd)} && ${command}`;
}

export function buildSshExecArgs(
  target: string,
  remoteCommand: string,
  interactive = false,
): string[] {
  return interactive
    ? ["ssh", "-t", target, remoteCommand]
    : ["ssh", target, remoteCommand];
}

export function openBackendShellCommand(
  backend: ResolvedProjectBackend,
  cwd?: string | null,
): string[] {
  const shellCwd = cwd?.trim() || backend.basePath;
  if (backend.kind === "ssh") {
    if (!backend.target) {
      throw new Error("SSH backend is missing a target");
    }
    return buildSshExecArgs(
      backend.target,
      `cd ${quoteShell(shellCwd)} && exec "\${SHELL:-/bin/sh}" -l`,
      true,
    );
  }
  return ["zsh", "-l"];
}

export function openBackendLlmCommand(
  backend: ResolvedProjectBackend,
  cwd: string,
  model: "claude" | "codex",
): string[] {
  if (backend.kind === "ssh") {
    if (!backend.target) {
      throw new Error("SSH backend is missing a target");
    }
    const llmCommand =
      model === "claude"
        ? `cd ${quoteShell(cwd)} && exec claude`
        : `cd ${quoteShell(cwd)} && exec codex -C ${quoteShell(cwd)}`;
    const remoteCommand = `exec "\${SHELL:-/bin/sh}" -lc ${quoteShell(llmCommand)}`;
    return buildSshExecArgs(backend.target, remoteCommand, true);
  }
  return model === "claude"
    ? ["claude"]
    : ["codex", "-C", cwd];
}

export function runBackendCommand(
  backend: ResolvedProjectBackend,
  command: string,
  options?: RunCommandOptions,
): BackendRunResult {
  const cwd = options?.cwd?.trim() || backend.basePath;

  if (backend.kind === "ssh") {
    if (!backend.target) {
      return {
        stdout: "",
        stderr: "SSH backend is missing a target.",
        exitCode: 1,
      };
    }
    const result = spawnSync(
      "ssh",
      buildSshExecArgs(backend.target, buildRemoteCommand(cwd, command)).slice(1),
      { encoding: "utf8" },
    );
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status ?? 1,
    };
  }

  const localCommand = cwd
    ? `cd ${quoteShell(cwd)} && ${command}`
    : command;
  const result = spawnSync(process.env.SHELL || "/bin/zsh", ["-lc", localCommand], {
    encoding: "utf8",
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

export function runBackendCommandAsync(
  backend: ResolvedProjectBackend,
  command: string,
  options?: RunCommandOptions,
): Promise<BackendRunResult> {
  const cwd = options?.cwd?.trim() || backend.basePath;

  if (backend.kind === "ssh") {
    if (!backend.target) {
      return Promise.resolve({
        stdout: "",
        stderr: "SSH backend is missing a target.",
        exitCode: 1,
      });
    }
    return new Promise((resolve) => {
      const child = spawn(
        "ssh",
        buildSshExecArgs(backend.target, buildRemoteCommand(cwd, command)).slice(1),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        resolve({
          stdout,
          stderr: stderr || error.message,
          exitCode: 1,
        });
      });
      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });
    });
  }

  const localCommand = cwd
    ? `cd ${quoteShell(cwd)} && ${command}`
    : command;
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/zsh", ["-lc", localCommand], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        stdout,
        stderr: stderr || error.message,
        exitCode: 1,
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

export function checkBackendDependencies(
  backend: ResolvedProjectBackend,
): DependencyCheckResult {
  const checkedAt = new Date().toISOString();

  if (backend.kind === "ssh") {
    const connection = testSshConnection(backend.target || "");
    if (!connection.ok) {
      return {
        backend,
        checkedAt,
        items: [
          {
            tool: "ssh",
            status: "warning",
            requiredFor: "repo",
            detail: connection.detail,
          },
          ...DEPENDENCY_CHECKS.map((check) => ({
            tool: check.tool,
            status: "warning" as const,
            requiredFor: check.requiredFor,
            detail: "Skipped because the SSH backend is unreachable.",
          })),
        ],
      };
    }
  }

  return {
    backend,
    checkedAt,
    items: DEPENDENCY_CHECKS.map((check) => {
      const result = runBackendCommand(backend, check.command);
      const ok = result.exitCode === 0;
      return {
        tool: check.tool,
        status: ok ? ("ok" as const) : ("missing" as const),
        requiredFor: check.requiredFor,
        detail: ok
          ? `${check.tool} is available.`
          : `${check.tool} is missing from PATH.`,
      };
    }),
  };
}

export function isBackendReachable(backend: ResolvedProjectBackend): boolean {
  if (backend.kind === "ssh") {
    return testSshConnection(backend.target || "").ok;
  }
  return existsSync(backend.basePath);
}

export function discoverRemoteGitRepos(
  backend: ResolvedProjectBackend,
): string[] {
  if (backend.kind !== "ssh" || !backend.target) {
    throw new Error("Remote repo discovery requires an SSH backend.");
  }

  const result = runBackendCommand(
    backend,
    "find . -path '*/node_modules' -prune -o \\( -name .git -type d -o -name .git -type f \\) -print",
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(detail || "Remote repo discovery failed.");
  }

  const repos = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const relativeGitPath = trimmed.replace(/^\.\//, "");
    if (relativeGitPath === ".git") {
      repos.add(backend.basePath);
      continue;
    }
    const repoRelativePath = relativeGitPath.replace(/\/\.git$/, "");
    if (!repoRelativePath) continue;
    const rootSegment = repoRelativePath.split("/")[0];
    if (rootSegment.startsWith(".")) continue;
    repos.add(posixPath.join(backend.basePath, repoRelativePath));
  }

  return [...repos].sort();
}

export function testSshConnection(target: string): BackendValidationResult {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return { ok: false, detail: "SSH target cannot be empty." };
  }

  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      normalizedTarget,
      "printf connected",
    ],
    { encoding: "utf8" },
  );

  if (result.status === 0 && result.stdout.trim() === "connected") {
    return { ok: true, detail: `Connected to ${normalizedTarget}.` };
  }

  const detail = (result.stderr || result.stdout || "").trim();
  return {
    ok: false,
    detail: detail || `Could not connect to ${normalizedTarget}.`,
  };
}

export function ensureSshBasePath(
  target: string,
  basePath: string,
): RemotePathValidationResult {
  const normalizedTarget = target.trim();
  const normalizedBasePath = basePath.trim();

  if (!normalizedTarget) {
    return {
      ok: false,
      detail: "SSH target cannot be empty.",
      resolvedPath: null,
    };
  }
  if (!normalizedBasePath) {
    return {
      ok: false,
      detail: "Remote base path cannot be empty.",
      resolvedPath: null,
    };
  }

  const remoteCommand = `mkdir -p ${quoteShell(normalizedBasePath)} && cd ${quoteShell(normalizedBasePath)} && pwd`;
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      normalizedTarget,
      remoteCommand,
    ],
    { encoding: "utf8" },
  );

  if (result.status === 0) {
    const resolvedPath = result.stdout.trim() || normalizedBasePath;
    return {
      ok: true,
      detail: `Prepared remote base path ${resolvedPath}.`,
      resolvedPath,
    };
  }

  const detail = (result.stderr || result.stdout || "").trim();
  return {
    ok: false,
    detail: detail || `Could not prepare remote path ${normalizedBasePath}.`,
    resolvedPath: null,
  };
}
