import { $ } from "bun";

export interface LinearIssue {
  id: string;
  statusIcon: string;
  status: string;
  title: string;
  url: string;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripAnsi(text: string): string {
  // CSI + OSC escape sequences.
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
}

async function runLrIssue(
  repoPath: string,
  issueId: string,
  args: string[],
): Promise<string> {
  try {
    const result = await $`lr issue ${issueId} ${args}`
      .cwd(repoPath)
      .env({ ...process.env, NO_COLOR: "1", CLICOLOR: "0" })
      .nothrow();
    if (result.exitCode !== 0) return "";
    return stripAnsi(result.stdout.toString()).trim();
  } catch {
    return "";
  }
}

export function buildLinearIssueUrl(issueId: string, team = "hnt-labs"): string {
  return `https://linear.app/${team}/issue/${issueId}`;
}

/**
 * List uncompleted issues assigned to the current user.
 * Uses the same lr CLI flow the user validated in Python.
 */
export async function listLinearIssuesForRepo(
  repoPath: string,
  team = "",
): Promise<LinearIssue[]> {
  try {
    const args = [
      "issue:list",
      "--mine",
      "--uncompleted",
      "--no-header",
      "--no-truncate",
    ];
    const trimmedTeam = team.trim();
    if (trimmedTeam && trimmedTeam.toLowerCase() !== "all") {
      args.push("--team", trimmedTeam);
    }

    const output = await $`lr ${args}`
      .cwd(repoPath)
      .env({ ...process.env, NO_COLOR: "1", CLICOLOR: "0" })
      .text();
    const lines = normalizeLines(stripAnsi(output));
    if (lines.length === 0) return [];
    if (
      lines.length === 1 &&
      lines[0].toLowerCase().includes("no issues to show")
    ) {
      return [];
    }

    const byId = new Map<string, LinearIssue>();
    for (const line of lines) {
      if (line.startsWith("Team: ")) continue;
      const match = line.match(/^([A-Za-z]+-\d+)\b/i);
      if (!match) continue;
      const id = match[1].toUpperCase();
      const columns = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
      const title = columns.length >= 3 ? columns[columns.length - 1] : "";
      const statusChunk = columns.length >= 2 ? columns[1] : "";
      let statusIcon = "";
      let status = "";
      if (statusChunk) {
        const statusMatch = statusChunk.match(/^(\S+)\s+(.*)$/);
        if (statusMatch) {
          statusIcon = statusMatch[1];
          status = statusMatch[2].trim();
        } else {
          status = statusChunk;
        }
      }
      if (!title) continue;
      byId.set(id, {
        id,
        statusIcon,
        status,
        title,
        url: buildLinearIssueUrl(id, team || "hnt-labs"),
      });
    }

    return Array.from(byId.values());
  } catch {
    return [];
  }
}

/**
 * Retrieve full issue context (description + comments) for initial LLM prompting.
 */
export async function getLinearIssueContext(
  repoPath: string,
  issueId: string,
  team = "",
): Promise<string> {
  try {
    // Collect issue data using multiple views. Some lr versions/instances
    // don't include full description when combined with --comments.
    const [plain, description, comments] = await Promise.all([
      runLrIssue(repoPath, issueId, []),
      runLrIssue(repoPath, issueId, ["--description"]),
      runLrIssue(repoPath, issueId, ["--comments"]),
    ]);

    const sections: string[] = [];
    if (plain) sections.push(`Issue details:\n${plain}`);
    if (description && description !== plain) {
      sections.push(`Issue description:\n${description}`);
    }
    if (comments && comments !== plain && comments !== description) {
      sections.push(`Issue comments:\n${comments}`);
    }
    if (sections.length === 0) return "";

    const link = buildLinearIssueUrl(issueId, team || "hnt-labs");
    return [
      `Linear issue context for ${issueId}`,
      `URL: ${link}`,
      "",
      sections.join("\n\n"),
    ].join("\n");
  } catch {
    return "";
  }
}
