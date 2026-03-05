import React from "react";
import { Box, Text, useInput } from "ink";

interface ConfirmModalProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  message,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onConfirm();
    } else if (key.escape || key.return || input === "n" || input === "N") {
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
        borderColor="yellow"
        paddingX={2}
        paddingY={1}
        backgroundColor="black"
      >
        <Text>{message}</Text>
        <Box marginTop={1}>
          <Text dimColor>y Confirm </Text>
          <Text bold>⏎/n Cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}
