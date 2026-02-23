import React from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";

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
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
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
        <Text dimColor>⏎ Submit  Esc Cancel</Text>
      </Box>
    </Box>
  );
}
