/**
 * Generate a standup summary from a pre-built prompt using the OpenAI API.
 */
export const COMMIT_MESSAGE_MODEL = "gpt-4.1-nano";

export async function generateStandupSummary(
  apiKey: string,
  promptText: string,
): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages: [{ role: "user", content: promptText }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content?.trim() || "";
}

/**
 * Generate a PR title and description from commit messages using the OpenAI API.
 */
export async function generatePrDescription(
  apiKey: string,
  commitMessages: string,
  diffStat: string,
  taskDescription = "",
  recentPrompts = "",
): Promise<{ title: string; description: string }> {
  const prompt = `You are helping create a GitHub pull request. Based on the commit messages and diff stats below, generate a concise PR title and a clear description in markdown.

Format your response EXACTLY as:
TITLE: <one-line title, max 72 chars>
DESCRIPTION:
<markdown description with a summary section and list of changes>

Task description:
${taskDescription || "[none]"}

Recent user prompts:
${recentPrompts || "[none]"}

Commit messages:
${commitMessages}

Diff stat:
${diffStat}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices[0]?.message?.content || "";

  const titleMatch = text.match(/TITLE:\s*(.+)/);
  const descMatch = text.match(/DESCRIPTION:\s*([\s\S]+)/);

  return {
    title: titleMatch ? titleMatch[1].trim() : "Update",
    description: descMatch ? descMatch[1].trim() : text.trim(),
  };
}

function normalizeCommitMessage(text: string): string {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return "";

  const lines = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, i, arr) => {
      // Collapse extra blank lines while preserving paragraph breaks.
      if (line.length > 0) return true;
      return i > 0 && arr[i - 1].length > 0;
    });

  const trimmed = lines.slice(0, 20).join("\n").trim();
  return trimmed.replace(/^["'`]+|["'`]+$/g, "").trim();
}

/**
 * Generate a terse professional commit message from task context and current diff.
 */
export async function generateCommitMessage(
  apiKey: string,
  taskDescription: string,
  recentPrompts: string,
  diffText: string,
): Promise<string> {
  const prompt = `You write Git commit messages.
Return plain text only (no quotes, no markdown, no backticks).
Style: extremely terse and professional.
Use 2-20 lines total:
- Line 1: imperative subject, <=72 chars.
- Then a blank line.
- Then concise bullet lines starting with "- ".

Task description:
${taskDescription || "[none]"}

Recent user prompts:
${recentPrompts || "[none]"}

Git diff:
${diffText || "[none]"}`;

  const requestMessage = async (promptText: string): Promise<string> => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: COMMIT_MESSAGE_MODEL,
        max_tokens: 220,
        messages: [{ role: "user", content: promptText }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content || "";
  };

  const content = await requestMessage(prompt);
  let message = normalizeCommitMessage(content);
  if (!message) {
    const retryPrompt = `${prompt}\n\nIMPORTANT: Your prior output was empty. Respond with a non-empty commit message now.`;
    message = normalizeCommitMessage(await requestMessage(retryPrompt));
  }
  if (!message) {
    const terseDescription = taskDescription
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    return terseDescription
      ? `Update ${terseDescription}`.slice(0, 72).trimEnd()
      : "Update implementation details";
  }
  return message;
}
