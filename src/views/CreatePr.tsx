import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";
import { useStore } from "../store/index.js";
import { getAppState, setAppState } from "../services/db.js";
import {
  getCurrentBranch,
  getGitStatus,
  getCommitLog,
  getDiffStat,
  getMainBranch,
  stageAndCommit,
  pushBranch,
  createPullRequest,
} from "../services/git.js";
import { generatePrDescription } from "../services/llm.js";
import type { Reviewer } from "../store/types.js";

type Phase =
  | "init"
  | "uncommitted"
  | "committing"
  | "reviewers"
  | "generating"
  | "creating"
  | "done"
  | "error";

interface AddingReviewer {
  step: "name" | "handle";
  name: string;
}

export function CreatePr() {
  const activeTask = useStore((s) => s.activeTask);
  const activeRepo = useStore((s) => s.activeRepo);
  const setView = useStore((s) => s.setView);

  const [phase, setPhase] = useState<Phase>("init");
  const [errorMsg, setErrorMsg] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [changedFiles, setChangedFiles] = useState(0);
  const [branch, setBranch] = useState("");

  // Reviewer state
  const [globalReviewers, setGlobalReviewers] = useState<Reviewer[]>([]);
  const [selectedHandles, setSelectedHandles] = useState<Set<string>>(new Set());
  const [reviewerIndex, setReviewerIndex] = useState(0);
  const [addingReviewer, setAddingReviewer] = useState<AddingReviewer | null>(null);
  const [addName, setAddName] = useState("");
  const [addHandle, setAddHandle] = useState("");

  // PR generation state
  const [prTitle, setPrTitle] = useState("");
  const [prDescription, setPrDescription] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [prNumber, setPrNumber] = useState(0);

  const repoPath = activeTask?.worktree_path || "";
  const initRan = useRef(false);

  // Init phase: check git status
  useEffect(() => {
    if (phase !== "init" || !repoPath || initRan.current) return;
    initRan.current = true;

    (async () => {
      try {
        const branchName = await getCurrentBranch(repoPath);
        setBranch(branchName);
        const status = await getGitStatus(repoPath, branchName);

        // Load reviewers from app_state
        const globalJson = getAppState("reviewers.global");
        const reviewers: Reviewer[] = globalJson ? JSON.parse(globalJson) : [];
        reviewers.sort((a, b) => a.name.localeCompare(b.name));
        setGlobalReviewers(reviewers);

        // Load repo defaults
        const repoKey = `reviewers.repo.${activeRepo?.id}`;
        const defaultJson = getAppState(repoKey);
        const defaults: string[] = defaultJson ? JSON.parse(defaultJson) : [];
        setSelectedHandles(new Set(defaults));

        if (status.changedFiles > 0) {
          setChangedFiles(status.changedFiles);
          setPhase("uncommitted");
        } else {
          setPhase("reviewers");
        }
      } catch (e: any) {
        setErrorMsg(e.message || "Failed to check git status");
        setPhase("error");
      }
    })();
  }, [phase, repoPath]);

  const handleCommit = async (msg: string) => {
    if (!msg.trim()) return;
    setPhase("committing");
    try {
      await stageAndCommit(repoPath, msg.trim());
      setPhase("reviewers");
    } catch (e: any) {
      setErrorMsg(e.message || "Commit failed");
      setPhase("error");
    }
  };

  const handleGenerate = async () => {
    setPhase("generating");
    try {
      const apiKey = getAppState("settings.openai_api_key");
      if (!apiKey) {
        setErrorMsg("OpenAI API key not set. Press 's' in Repo Selection to open Settings.");
        setPhase("error");
        return;
      }

      // Push branch first
      const branchName = branch || (await getCurrentBranch(repoPath));
      setBranch(branchName);
      await pushBranch(repoPath, branchName);

      const mainBranch = await getMainBranch(repoPath);
      const [commitLog, diffStat] = await Promise.all([
        getCommitLog(repoPath, mainBranch),
        getDiffStat(repoPath, mainBranch),
      ]);

      if (!commitLog) {
        setErrorMsg("No commits found between main and HEAD");
        setPhase("error");
        return;
      }

      const { title, description } = await generatePrDescription(apiKey, commitLog, diffStat);
      setPrTitle(title);
      setPrDescription(description);
      // Skip confirmation — go straight to creating the PR
      setPhase("creating");
      const reviewerList = Array.from(selectedHandles);
      if (activeRepo) {
        setAppState(
          `reviewers.repo.${activeRepo.id}`,
          JSON.stringify(reviewerList),
        );
      }
      const result = await createPullRequest(repoPath, title, description, reviewerList);
      setPrNumber(result.number);
      setPrUrl(result.url);
      setPhase("done");
      try { Bun.spawn(["open", result.url], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
    } catch (e: any) {
      const stderr = e.stderr?.toString?.()?.trim?.();
      setErrorMsg(stderr || e.message || "Failed to generate PR description");
      setPhase("error");
    }
  };


  const addNewReviewer = (name: string, handle: string) => {
    const trimName = name.trim();
    const trimHandle = handle.trim().replace(/^@/, "");
    if (!trimHandle) return;

    const reviewer: Reviewer = { name: trimName || trimHandle, handle: trimHandle };
    const updated = [...globalReviewers, reviewer].sort((a, b) => a.name.localeCompare(b.name));
    setGlobalReviewers(updated);
    setAppState("reviewers.global", JSON.stringify(updated));
    setSelectedHandles((prev) => new Set([...prev, trimHandle]));
    setReviewerIndex(updated.findIndex((r) => r.handle === trimHandle));
  };

  // Text input active in these phases
  const textInputActive =
    phase === "uncommitted" ||
    (phase === "reviewers" && addingReviewer !== null);

  useInput((input, key) => {
    // Gate: when text input is active, only handle Escape to cancel
    if (textInputActive) {
      if (key.escape) {
        if (phase === "uncommitted") {
          setView("taskView");
        } else if (phase === "reviewers" && addingReviewer) {
          setAddingReviewer(null);
          setAddName("");
          setAddHandle("");
        }
      }
      return;
    }

    if (key.escape) {
      setView("taskView");
      return;
    }

    if (phase === "reviewers") {
      if (key.upArrow) {
        setReviewerIndex(Math.max(0, reviewerIndex - 1));
      } else if (key.downArrow) {
        setReviewerIndex(Math.min(globalReviewers.length - 1, reviewerIndex + 1));
      } else if (input === " " && globalReviewers.length > 0) {
        const handle = globalReviewers[reviewerIndex]?.handle;
        if (handle) {
          setSelectedHandles((prev) => {
            const next = new Set(prev);
            if (next.has(handle)) next.delete(handle);
            else next.add(handle);
            return next;
          });
        }
      } else if (input === "a") {
        setAddingReviewer({ step: "name", name: "" });
        setAddName("");
        setAddHandle("");
      } else if (key.return) {
        handleGenerate();
      }
      return;
    }

  });

  if (!activeTask) return null;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Create Pull Request</Text>
        <Text dimColor>  {activeTask.label}</Text>
        {branch && <Text dimColor>  ({branch})</Text>}
      </Box>

      {/* Init / loading */}
      {phase === "init" && <Text dimColor>Checking git status...</Text>}

      {/* Uncommitted changes */}
      {phase === "uncommitted" && (
        <Box flexDirection="column">
          <Text color="yellow">{changedFiles} uncommitted file{changedFiles !== 1 ? "s" : ""}. Enter commit message:</Text>
          <Box marginTop={1}>
            <Text color="cyan">&gt; </Text>
            <InkTextInput
              value={commitMsg}
              onChange={setCommitMsg}
              onSubmit={handleCommit}
            />
          </Box>
        </Box>
      )}

      {/* Committing */}
      {phase === "committing" && <Text dimColor>Committing changes...</Text>}

      {/* Reviewer selection */}
      {phase === "reviewers" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Select Reviewers</Text>
            <Text dimColor>  Space: toggle  a: add  Enter: continue</Text>
          </Box>

          {globalReviewers.length === 0 && !addingReviewer && (
            <Text dimColor>No reviewers configured. Press 'a' to add one, or Enter to skip.</Text>
          )}

          {globalReviewers.map((r, i) => {
            const selected = selectedHandles.has(r.handle);
            const focused = i === reviewerIndex;
            return (
              <Box key={r.handle} paddingLeft={1}>
                <Text color={focused ? "cyan" : undefined} bold={focused}>
                  {focused ? "▸ " : "  "}
                  {selected ? "[x]" : "[ ]"} {r.name} <Text dimColor>@{r.handle}</Text>
                </Text>
              </Box>
            );
          })}

          {addingReviewer && addingReviewer.step === "name" && (
            <Box marginTop={1} flexDirection="column">
              <Text>New reviewer name:</Text>
              <Box>
                <Text color="cyan">&gt; </Text>
                <InkTextInput
                  value={addName}
                  onChange={setAddName}
                  onSubmit={(val) => {
                    setAddingReviewer({ step: "handle", name: val });
                  }}
                />
              </Box>
            </Box>
          )}

          {addingReviewer && addingReviewer.step === "handle" && (
            <Box marginTop={1} flexDirection="column">
              <Text>GitHub handle for {addingReviewer.name || "reviewer"}:</Text>
              <Box>
                <Text color="cyan">@</Text>
                <InkTextInput
                  value={addHandle}
                  onChange={setAddHandle}
                  onSubmit={(val) => {
                    addNewReviewer(addingReviewer.name, val);
                    setAddingReviewer(null);
                    setAddName("");
                    setAddHandle("");
                  }}
                />
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Generating */}
      {phase === "generating" && (
        <Box flexDirection="column">
          <Text dimColor>Pushing branch and generating PR description...</Text>
        </Box>
      )}

      {/* Creating */}
      {phase === "creating" && <Text dimColor>Creating pull request...</Text>}

      {/* Done */}
      {phase === "done" && (
        <Box flexDirection="column">
          <Text color="green" bold>PR #{prNumber} created!</Text>
          <Box marginTop={1}>
            <Text>{prUrl}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc: return to task</Text>
          </Box>
        </Box>
      )}

      {/* Error */}
      {phase === "error" && (
        <Box flexDirection="column">
          <Text color="red" bold>Error</Text>
          <Box marginTop={1}>
            <Text color="red">{errorMsg}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc: return to task</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
