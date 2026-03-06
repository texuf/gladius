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
      `cd ${quoteShell(shellCwd)} && exec \\$SHELL -l`,
      true,
    );
  }
  return ["zsh", "-l"];
}
