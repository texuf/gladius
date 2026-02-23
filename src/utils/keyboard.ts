import type { Key } from "ink";

/**
 * Check if a Cmd+key combo was pressed.
 * Uses key.super from Kitty keyboard protocol.
 */
export function isCmdKey(input: string, key: Key, char: string): boolean {
  return key.super === true && input === char;
}

/**
 * Check if Cmd+Shift+key was pressed.
 * Kitty protocol sends uppercase char with key.super for Cmd+Shift combos.
 */
export function isCmdShiftKey(input: string, key: Key, char: string): boolean {
  return key.super === true && input === char.toUpperCase();
}

/**
 * Chord detection helper.
 * Returns the new chord buffer state and any completed chord.
 */
export function processChord(
  buffer: string,
  input: string,
  key: Key
): { newBuffer: string; chord: string | null } {
  // Only process regular character input for chords
  if (key.super || key.ctrl || key.meta || key.escape || key.return) {
    return { newBuffer: "", chord: null };
  }

  // Single printable character
  if (input.length === 1 && /^[a-z]$/.test(input)) {
    const newBuffer = buffer + input;

    // Check for known chords
    if (newBuffer === "cl" || newBuffer === "co") {
      return { newBuffer: "", chord: newBuffer };
    }

    // If buffer is getting long, it's not a chord
    if (newBuffer.length >= 3) {
      return { newBuffer: "", chord: null };
    }

    return { newBuffer, chord: null };
  }

  return { newBuffer: "", chord: null };
}
