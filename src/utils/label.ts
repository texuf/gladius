// Common English verbs used in task descriptions
const VERBS = new Set([
  "fix", "add", "update", "remove", "delete", "create", "implement",
  "refactor", "move", "rename", "change", "replace", "improve", "optimize",
  "debug", "test", "write", "build", "deploy", "setup", "configure",
  "migrate", "upgrade", "downgrade", "revert", "merge", "split",
  "extract", "inline", "wrap", "unwrap", "convert", "transform",
]);

// Words to skip when looking for meaningful nouns
const SKIP_WORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
  "from", "by", "is", "are", "was", "were", "be", "been", "being",
  "that", "this", "it", "its", "and", "or", "but", "not", "no",
  "so", "if", "up", "out", "into", "new", "all",
]);

/**
 * Generate a task label from a description.
 * Extracts first verb + first noun, appends MMDD date.
 * Example: "Fix authentication bug in login flow" → "fix-auth-0223"
 */
export function generateLabel(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  let verb = "";
  let noun = "";

  for (const word of words) {
    if (!verb && VERBS.has(word)) {
      verb = word;
      continue;
    }
    if (verb && !noun && !SKIP_WORDS.has(word) && !VERBS.has(word)) {
      // Truncate long nouns to first 4+ chars
      noun = word.length > 6 ? word.slice(0, 4) : word;
      break;
    }
  }

  // Fallback: use first two meaningful words
  if (!verb) {
    const meaningful = words.filter((w) => !SKIP_WORDS.has(w));
    verb = meaningful[0] || "task";
    noun = meaningful[1] || "";
    if (noun.length > 6) noun = noun.slice(0, 4);
  }
  if (!noun) {
    const meaningful = words.filter((w) => !SKIP_WORDS.has(w) && w !== verb);
    noun = meaningful[0] || "";
    if (noun.length > 6) noun = noun.slice(0, 4);
  }

  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${month}${day}`;

  const parts = [verb, noun, date].filter(Boolean);
  return parts.join("-");
}

/**
 * Deduplicate a label by appending -2, -3, etc. if it already exists.
 */
export function deduplicateLabel(label: string, existingLabels: string[]): string {
  if (!existingLabels.includes(label)) return label;
  let i = 2;
  while (existingLabels.includes(`${label}-${i}`)) i++;
  return `${label}-${i}`;
}
