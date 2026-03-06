import type { Reviewer } from "../store/types.js";

export function normalizeReviewerHotkey(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z]$/.test(normalized) ? normalized : null;
}

export function normalizeReviewers(reviewers: Reviewer[]): Reviewer[] {
  const usedHotkeys = new Set<string>();

  return reviewers.flatMap((reviewer) => {
    const handle = reviewer.handle?.trim().replace(/^@/, "") ?? "";
    if (!handle) return [];

    const hotkey = normalizeReviewerHotkey(reviewer.hotkey);
    const uniqueHotkey =
      hotkey && !usedHotkeys.has(hotkey) ? hotkey : null;
    if (uniqueHotkey) {
      usedHotkeys.add(uniqueHotkey);
    }

    return [
      {
        name: reviewer.name?.trim() || handle,
        handle,
        hotkey: uniqueHotkey,
      },
    ];
  });
}

export function parseStoredReviewers(value: string | null): Reviewer[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Reviewer[];
    return Array.isArray(parsed) ? normalizeReviewers(parsed) : [];
  } catch {
    return [];
  }
}
