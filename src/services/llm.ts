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
