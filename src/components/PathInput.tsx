import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync, statSync } from "fs";
import { resolve, dirname, basename, join } from "path";

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return (process.env.HOME || "") + p.slice(1);
  }
  return p;
}

function collapseTilde(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function getCompletions(input: string): string[] {
  if (!input) return [];

  const expanded = expandTilde(input);
  let dir: string;
  let prefix: string;

  if (expanded.endsWith("/")) {
    dir = expanded;
    prefix = "";
  } else {
    dir = dirname(expanded);
    prefix = basename(expanded);
  }

  try {
    const entries = readdirSync(dir);
    const matches = entries
      .filter((e) => e.startsWith(prefix))
      .filter((e) => !e.startsWith(".") || prefix.startsWith("."))
      .sort();

    return matches.map((name) => {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        return stat.isDirectory() ? name + "/" : name;
      } catch {
        return name;
      }
    });
  } catch {
    return [];
  }
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  if (strings.length === 1) return strings[0];

  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}

export function PathInput({
  value,
  onChange,
  onSubmit,
  placeholder,
}: PathInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const [completions, setCompletions] = useState<string[]>([]);
  const [showCompletions, setShowCompletions] = useState(false);

  const updateValue = useCallback(
    (newVal: string, newCursor?: number) => {
      onChange(newVal);
      setCursor(newCursor ?? newVal.length);
      setShowCompletions(false);
      setCompletions([]);
    },
    [onChange]
  );

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }

    // Tab completion
    if (key.tab) {
      const expanded = expandTilde(value);
      let dir: string;
      let prefix: string;

      if (expanded.endsWith("/")) {
        dir = expanded;
        prefix = "";
      } else {
        dir = dirname(expanded);
        prefix = basename(expanded);
      }

      const matches = getCompletions(value);

      if (matches.length === 0) return;

      if (matches.length === 1) {
        // Single match — complete it
        const completed = join(dir, matches[0]);
        const display = collapseTilde(completed);
        updateValue(display);
        return;
      }

      // Multiple matches — extend to longest common prefix
      const lcp = longestCommonPrefix(matches);
      if (lcp.length > prefix.length) {
        const completed = join(dir, lcp);
        const display = collapseTilde(completed);
        updateValue(display);
        setCompletions(matches);
        return;
      }

      // Already at common prefix — show/toggle completions
      setCompletions(matches);
      setShowCompletions(true);
      return;
    }

    // Hide completions on any non-tab key
    if (showCompletions) {
      setShowCompletions(false);
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        const newVal = value.slice(0, cursor - 1) + value.slice(cursor);
        onChange(newVal);
        setCursor(cursor - 1);
      }
      return;
    }

    // Arrow keys
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1));
      return;
    }

    // Home / End (Ctrl+A / Ctrl+E)
    if (input === "a" && key.ctrl) {
      setCursor(0);
      return;
    }
    if (input === "e" && key.ctrl) {
      setCursor(value.length);
      return;
    }

    // Ctrl+U — clear line
    if (input === "u" && key.ctrl) {
      updateValue("");
      setCursor(0);
      return;
    }

    // Ctrl+W — delete word backward
    if (input === "w" && key.ctrl) {
      if (cursor > 0) {
        let i = cursor - 1;
        // Skip trailing slashes/spaces
        while (i > 0 && (value[i] === "/" || value[i] === " ")) i--;
        // Delete back to previous separator
        while (i > 0 && value[i - 1] !== "/" && value[i - 1] !== " ") i--;
        const newVal = value.slice(0, i) + value.slice(cursor);
        onChange(newVal);
        setCursor(i);
      }
      return;
    }

    // Regular character input — ignore control sequences
    if (
      !key.ctrl &&
      !key.meta &&
      input &&
      !key.upArrow &&
      !key.downArrow
    ) {
      const newVal = value.slice(0, cursor) + input + value.slice(cursor);
      onChange(newVal);
      setCursor(cursor + input.length);
    }
  });

  // Build display with cursor
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] || " ";
  const after = value.slice(cursor + 1);
  const isEmpty = value.length === 0;

  return (
    <Box flexDirection="column">
      <Box>
        {isEmpty && placeholder ? (
          <Text dimColor>
            <Text inverse> </Text>
            {placeholder}
          </Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
          </Text>
        )}
      </Box>
      {showCompletions && completions.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} gap={1}>
          {completions.map((c) => (
            <Text key={c} dimColor color={c.endsWith("/") ? "cyan" : undefined}>
              {c}{"  "}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
