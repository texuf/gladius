/**
 * Generate a standup summary from a pre-built prompt using the OpenAI API.
 */
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
): Promise<{ title: string; description: string }> {
  const prompt = `You are helping create a GitHub pull request. Based on the commit messages and diff stats below, generate a concise PR title and a clear description in markdown.

Format your response EXACTLY as:
TITLE: <one-line title, max 72 chars>
DESCRIPTION:
<markdown description with a summary section and list of changes>

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

function normalizeSingleLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) || "";
  return line.replace(/^["'`]+|["'`]+$/g, "").trim();
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
  const prompt = `You write Git commit subjects.
Return EXACTLY one line, no prefix/suffix, no quotes, no markdown.
Style: extremely terse and professional. Imperative mood. Max 72 chars.

Task description:
${taskDescription || "[none]"}

Recent user prompts:
${recentPrompts || "[none]"}

Git diff:
${diffText || "[none]"}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      max_completion_tokens: 80,
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
  const content = data.choices[0]?.message?.content || "";
  const message = normalizeSingleLine(content);
  if (!message) return "Update changes";
  return message.length > 72 ? message.slice(0, 72).trimEnd() : message;
}
