import React from "react";
import { Box, Text, useInput } from "ink";

interface ConfirmModalProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ message, onConfirm, onCancel }: ConfirmModalProps) {
  useInput((input, key) => {
    if (key.return) {
      onConfirm();
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      alignSelf="center"
    >
      <Text>{message}</Text>
      <Text dimColor>
        {"\n"}⏎ Confirm  Esc Cancel
      </Text>
    </Box>
  );
}
