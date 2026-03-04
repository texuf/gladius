import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ModalState } from "../store/types.js";

type HotkeyMenuModalState = Extract<ModalState, { type: "hotkeyMenu" }>;

interface HotkeyMenuModalProps {
  menu: HotkeyMenuModalState;
  onSelect: (item: HotkeyMenuModalState["items"][number]) => void;
  onCancel: () => void;
}

function findNextEnabledIndex(
  items: HotkeyMenuModalState["items"],
  start: number,
  step: 1 | -1,
): number {
  if (items.length === 0) return -1;
  let i = start;
  for (let checked = 0; checked < items.length; checked += 1) {
    i = (i + step + items.length) % items.length;
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

export function HotkeyMenuModal({
  menu,
  onSelect,
  onCancel,
}: HotkeyMenuModalProps) {
  const { items } = menu;
  const keyWidth = useMemo(
    () => Math.max(1, ...items.map((item) => item.key.length)),
    [items],
  );
  const firstEnabled = useMemo(
    () => items.findIndex((item) => !item.disabled),
    [items],
  );
  const [selectedIndex, setSelectedIndex] = useState(firstEnabled);

  useEffect(() => {
    setSelectedIndex(firstEnabled);
  }, [firstEnabled]);

  const runItem = (idx: number) => {
    const item = items[idx];
    if (!item || item.disabled) return;
    onSelect(item);
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      const next = findNextEnabledIndex(
        items,
        selectedIndex < 0 ? 0 : selectedIndex,
        -1,
      );
      if (next >= 0) setSelectedIndex(next);
      return;
    }

    if (key.downArrow) {
      const next = findNextEnabledIndex(
        items,
        selectedIndex < 0 ? -1 : selectedIndex,
        1,
      );
      if (next >= 0) setSelectedIndex(next);
      return;
    }

    if (key.return) {
      if (selectedIndex >= 0) runItem(selectedIndex);
      return;
    }

    if (key.ctrl || key.meta || key.super) return;
    if (input.length !== 1) return;
    const normalized = input.toLowerCase();
    const idx = items.findIndex(
      (item) => item.key.toLowerCase() === normalized,
    );
    if (idx >= 0) runItem(idx);
  });

  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor="yellow"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="yellow">
          {menu.title}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {items.map((item, idx) => {
            const active = idx === selectedIndex && !item.disabled;
            return (
              <Text
                key={`${item.key}-${idx}`}
                color={active ? "cyan" : undefined}
                dimColor={item.disabled}
              >
                {active ? "▸ " : "  "}
                {item.key.padEnd(keyWidth)}
                {"  "}
                {item.label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press key or ⏎ Esc Cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}
