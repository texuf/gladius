import React from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useEffect, useMemo, useState } from "react";

interface TextInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  placeholder?: string;
}

export function TextInputField({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: TextInputProps) {
  useInput((_input, key) => {
    if (key.escape && onCancel) {
      onCancel();
    }
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
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        backgroundColor="black"
      >
        <Text bold color="cyan">
          {label}
        </Text>
        <Box marginTop={1}>
          <Text>&gt; </Text>
          <InkTextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={placeholder}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>⏎ Submit Esc Cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function WrappedTextInputField({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: TextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((prev) => Math.max(0, Math.min(prev, value.length)));
  }, [value]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorOffset((prev) => Math.min(value.length, prev + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursorOffset === 0) return;
      onChange(value.slice(0, cursorOffset - 1) + value.slice(cursorOffset));
      setCursorOffset((prev) => Math.max(0, prev - 1));
      return;
    }

    if (!input) return;
    onChange(value.slice(0, cursorOffset) + input + value.slice(cursorOffset));
    setCursorOffset((prev) => prev + input.length);
  });

  const modalWidth = Math.max(36, Math.min(80, (process.stdout.columns || 80) - 6));
  const renderedValue = useMemo(() => {
    if (!value) {
      return (
        <Text>
          <Text inverse> </Text>
          {placeholder ? <Text dimColor>{placeholder}</Text> : null}
        </Text>
      );
    }

    const before = value.slice(0, cursorOffset);
    const current = value[cursorOffset] ?? " ";
    const after = cursorOffset < value.length ? value.slice(cursorOffset + 1) : "";

    return (
      <Text wrap="wrap">
        {before}
        <Text inverse>{current}</Text>
        {after}
      </Text>
    );
  }, [cursorOffset, placeholder, value]);

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
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        backgroundColor="black"
        width={modalWidth}
      >
        <Text bold color="cyan">
          {label}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Type your note. Blank submit clears it.</Text>
          <Box marginTop={1}>
            <Text>&gt; </Text>
            <Box flexGrow={1}>{renderedValue}</Box>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>⏎ Submit Esc Cancel ←→ Move Cursor Backspace Delete</Text>
        </Box>
      </Box>
    </Box>
  );
}
