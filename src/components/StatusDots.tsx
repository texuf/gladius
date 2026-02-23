import React from "react";
import { Text } from "ink";

interface StatusDotsProps {
  green?: number;
  red?: number;
  orange?: number;
}

export function StatusDots({ green = 0, red = 0, orange = 0 }: StatusDotsProps) {
  const parts: React.ReactNode[] = [];

  if (green > 0) {
    parts.push(
      <Text key="green" color="green">
        {"●".repeat(green)}
      </Text>
    );
  }
  if (red > 0) {
    parts.push(
      <Text key="red" color="red">
        {"●".repeat(red)}
      </Text>
    );
  }
  if (orange > 0) {
    parts.push(
      <Text key="orange" color="yellow">
        {"●".repeat(orange)}
      </Text>
    );
  }

  if (parts.length === 0) return null;

  return (
    <Text>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text> </Text>}
          {part}
        </React.Fragment>
      ))}
    </Text>
  );
}
