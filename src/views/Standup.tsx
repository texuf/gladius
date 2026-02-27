import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store/index.js";
import { getAppState } from "../services/db.js";
import { generateStandup, getStandupWindowStart } from "../services/standup.js";
import { $ } from "bun";

type Phase = "loading" | "generating" | "display" | "error";

export function Standup() {
  const setView = useStore((s) => s.setView);
  const [phase, setPhase] = useState<Phase>("loading");
  const [summary, setSummary] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [sinceLabel, setSinceLabel] = useState("");

  const run = async () => {
    setPhase("generating");
    setCopied(false);
    setSinceLabel(getStandupWindowStart());

    const apiKey = getAppState("settings.openai_api_key");
    if (!apiKey) {
      setErrorMsg(
        "No OpenAI API key configured. Press 's' from Repo Selection to open Settings.",
      );
      setPhase("error");
      return;
    }

    try {
      const result = await generateStandup(apiKey);
      setSummary(result);
      setPhase("display");
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to generate standup summary.");
      setPhase("error");
    }
  };

  useEffect(() => {
    run();
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      setView("projects");
      return;
    }

    if (phase === "display") {
      if (input === "c") {
        const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
        proc.stdin.write(summary);
        proc.stdin.end();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      }
      if (input === "r") {
        run();
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {" "}
          GLADIUS{" "}
        </Text>
        <Text dimColor> Standup Summary</Text>
      </Box>

      {(phase === "loading" || phase === "generating") && (
        <Text dimColor>Generating summary...</Text>
      )}

      {phase === "display" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text dimColor>Since: {sinceLabel}</Text>
          </Box>
          <Text>{summary}</Text>
          {copied && (
            <Box marginTop={1}>
              <Text color="green">Copied!</Text>
            </Box>
          )}
        </Box>
      )}

      {phase === "error" && (
        <Box flexDirection="column">
          <Text color="red">{errorMsg}</Text>
        </Box>
      )}
    </Box>
  );
}
