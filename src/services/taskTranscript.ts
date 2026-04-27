import { readFileSync, statSync } from "fs";
import type { Task } from "../store/types.js";
import { resolveTaskSessionFile, type PromptSource } from "./taskPrompt.js";

export interface TaskTranscriptSnapshot {
  model: PromptSource | null;
  filePath: string | null;
  generatedAt: string;
  recordCount: number;
  fileSizeBytes: number | null;
  fileMtimeMs: number | null;
  lines: string[];
  error: string | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJsonParse(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function omitKeys(record: JsonRecord, keys: string[]): JsonRecord {
  const omitted = new Set(keys);
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omitted.has(key)) result[key] = value;
  }
  return result;
}

function hasKeys(record: JsonRecord): boolean {
  return Object.keys(record).length > 0;
}

function splitText(text: string): string[] {
  if (!text) return [""];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function prefixed(prefix: string, text: string): string[] {
  return splitText(text).map((line) => `${prefix}${line}`);
}

function prefixedJson(prefix: string, value: unknown): string[] {
  return prefixed(prefix, stableJson(value));
}

function formatInlineMeta(parts: Array<string | null | undefined>): string {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? ` (${filtered.join(", ")})` : "";
}

function formatTimestamp(value: unknown): string {
  return typeof value === "string" && value ? value : "no timestamp";
}

function formatContent(content: unknown, prefix = "  "): string[] {
  if (typeof content === "string") {
    const parsed = safeJsonParse(content);
    if (parsed && (isRecord(parsed) || Array.isArray(parsed))) {
      return prefixedJson(prefix, parsed);
    }
    return prefixed(prefix, content);
  }

  if (Array.isArray(content)) {
    const lines: string[] = [];
    content.forEach((block, index) => {
      if (index > 0) lines.push("");
      lines.push(...formatContentBlock(block, prefix));
    });
    return lines;
  }

  if (content === null || content === undefined) {
    return [`${prefix}${String(content)}`];
  }

  if (isRecord(content)) {
    return prefixedJson(prefix, content);
  }

  return prefixed(prefix, String(content));
}

function summarizeImageSource(source: unknown): string {
  if (!isRecord(source)) return "unknown source";
  const mediaType = asString(source.media_type) || asString(source.mediaType);
  const sourceType = asString(source.type);
  const data = asString(source.data);
  const url = asString(source.url);
  const parts = [
    sourceType ? `type=${sourceType}` : null,
    mediaType ? `media=${mediaType}` : null,
    data ? `data=${data.length} chars` : null,
    url ? `url=${url}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : stableJson(source);
}

function formatToolInput(
  toolName: string,
  input: unknown,
  prefix: string,
): string[] {
  if (!isRecord(input)) return prefixedJson(prefix, input);

  if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
    const lines = [`${prefix}todos:`];
    for (const todo of input.todos) {
      if (!isRecord(todo)) {
        lines.push(...prefixedJson(`${prefix}  - `, todo));
        continue;
      }
      const status = asString(todo.status) || "unknown";
      const content = asString(todo.content) || stableJson(todo);
      const priority = asString(todo.priority);
      lines.push(
        `${prefix}  - [${status}] ${content}${priority ? ` (${priority})` : ""}`,
      );
    }
    return lines;
  }

  if (toolName === "Bash") {
    const lines: string[] = [];
    const description = asString(input.description);
    const command = asString(input.command);
    if (description) lines.push(`${prefix}description: ${description}`);
    if (command) {
      lines.push(`${prefix}command:`);
      lines.push(...prefixed(`${prefix}  `, command));
    }
    const rest = omitKeys(input, ["description", "command"]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}input metadata:`);
      lines.push(...prefixedJson(`${prefix}  `, rest));
    }
    return lines.length > 0 ? lines : prefixedJson(prefix, input);
  }

  if (toolName === "Write") {
    const lines: string[] = [];
    const filePath = asString(input.file_path);
    const content = asString(input.content);
    if (filePath) lines.push(`${prefix}file: ${filePath}`);
    if (content) {
      lines.push(`${prefix}content:`);
      lines.push(...prefixed(`${prefix}  `, content));
    }
    const rest = omitKeys(input, ["file_path", "content"]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}input metadata:`);
      lines.push(...prefixedJson(`${prefix}  `, rest));
    }
    return lines.length > 0 ? lines : prefixedJson(prefix, input);
  }

  if (toolName === "Edit") {
    const lines: string[] = [];
    const filePath = asString(input.file_path);
    const oldString = asString(input.old_string);
    const newString = asString(input.new_string);
    if (filePath) lines.push(`${prefix}file: ${filePath}`);
    if (typeof input.replace_all === "boolean") {
      lines.push(`${prefix}replace_all: ${input.replace_all}`);
    }
    if (oldString) {
      lines.push(`${prefix}old:`);
      lines.push(...prefixed(`${prefix}  - `, oldString));
    }
    if (newString) {
      lines.push(`${prefix}new:`);
      lines.push(...prefixed(`${prefix}  + `, newString));
    }
    const rest = omitKeys(input, [
      "file_path",
      "old_string",
      "new_string",
      "replace_all",
    ]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}input metadata:`);
      lines.push(...prefixedJson(`${prefix}  `, rest));
    }
    return lines.length > 0 ? lines : prefixedJson(prefix, input);
  }

  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const lines: string[] = [];
    const filePath = asString(input.file_path);
    if (filePath) lines.push(`${prefix}file: ${filePath}`);
    input.edits.forEach((edit, index) => {
      lines.push(`${prefix}edit ${index + 1}:`);
      if (!isRecord(edit)) {
        lines.push(...prefixedJson(`${prefix}  `, edit));
        return;
      }
      const oldString = asString(edit.old_string);
      const newString = asString(edit.new_string);
      if (oldString) {
        lines.push(`${prefix}  old:`);
        lines.push(...prefixed(`${prefix}    - `, oldString));
      }
      if (newString) {
        lines.push(`${prefix}  new:`);
        lines.push(...prefixed(`${prefix}    + `, newString));
      }
      const rest = omitKeys(edit, ["old_string", "new_string"]);
      if (hasKeys(rest)) {
        lines.push(...prefixedJson(`${prefix}  `, rest));
      }
    });
    const rest = omitKeys(input, ["file_path", "edits"]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}input metadata:`);
      lines.push(...prefixedJson(`${prefix}  `, rest));
    }
    return lines.length > 0 ? lines : prefixedJson(prefix, input);
  }

  return prefixedJson(prefix, input);
}

function formatToolResultContent(content: unknown, prefix: string): string[] {
  if (Array.isArray(content)) {
    const lines: string[] = [];
    content.forEach((item, index) => {
      if (index > 0) lines.push("");
      lines.push(...formatContentBlock(item, prefix));
    });
    return lines;
  }
  return formatContent(content, prefix);
}

function formatContentBlock(block: unknown, prefix: string): string[] {
  if (!isRecord(block)) return formatContent(block, prefix);

  const blockType = asString(block.type);
  if (!blockType) return prefixedJson(prefix, block);

  if (blockType === "text") {
    return prefixed(prefix, asString(block.text));
  }

  if (blockType === "input_text" || blockType === "output_text") {
    return prefixed(prefix, asString(block.text));
  }

  if (blockType === "thinking") {
    const lines = [`${prefix}[thinking]`];
    lines.push(...prefixed(`${prefix}  `, asString(block.thinking)));
    const rest = omitKeys(block, ["type", "thinking"]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}  metadata:`);
      lines.push(...prefixedJson(`${prefix}    `, rest));
    }
    return lines;
  }

  if (blockType === "image" || blockType === "input_image") {
    const source = block.source ?? block.image_url ?? block;
    return [`${prefix}[image: ${summarizeImageSource(source)}]`];
  }

  if (blockType === "tool_use") {
    const toolName = asString(block.name) || "unknown tool";
    const toolId = asString(block.id);
    const lines = [
      `${prefix}[tool use] ${toolName}${toolId ? ` id=${toolId}` : ""}`,
    ];
    lines.push(...formatToolInput(toolName, block.input, `${prefix}  `));
    const rest = omitKeys(block, ["type", "name", "id", "input"]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}  metadata:`);
      lines.push(...prefixedJson(`${prefix}    `, rest));
    }
    return lines;
  }

  if (blockType === "tool_result") {
    const toolUseId = asString(block.tool_use_id);
    const isError = block.is_error === true;
    const lines = [
      `${prefix}[tool result${isError ? " error" : ""}]${toolUseId ? ` tool_use_id=${toolUseId}` : ""}`,
    ];
    lines.push(...formatToolResultContent(block.content, `${prefix}  `));
    const rest = omitKeys(block, [
      "type",
      "tool_use_id",
      "is_error",
      "content",
    ]);
    if (hasKeys(rest)) {
      lines.push(`${prefix}  metadata:`);
      lines.push(...prefixedJson(`${prefix}    `, rest));
    }
    return lines;
  }

  if (blockType === "refusal") {
    return prefixed(prefix, asString(block.refusal) || stableJson(block));
  }

  const lines = [`${prefix}[${blockType}]`];
  lines.push(...prefixedJson(`${prefix}  `, omitKeys(block, ["type"])));
  return lines;
}

function formatRecordMetadata(
  record: JsonRecord,
  omittedKeys: string[],
  prefix: string,
): string[] {
  const metadata = omitKeys(record, omittedKeys);
  if (!hasKeys(metadata)) return [];
  return [`${prefix}metadata:`, ...prefixedJson(`${prefix}  `, metadata)];
}

function formatClaudeRecord(record: JsonRecord, index: number): string[] {
  const timestamp = formatTimestamp(record.timestamp);
  const type = asString(record.type) || "unknown";

  if (type === "summary") {
    const lines = [`[${index}] ${timestamp} summary`];
    lines.push(
      ...prefixed("  ", asString(record.summary) || stableJson(record)),
    );
    lines.push(
      ...formatRecordMetadata(record, ["type", "timestamp", "summary"], "  "),
    );
    return lines;
  }

  const message = record.message;
  if (!isRecord(message)) {
    return [`[${index}] ${timestamp} ${type}`, ...prefixedJson("  ", record)];
  }

  const role = asString(message.role) || type;
  const meta = formatInlineMeta([
    record.isMeta === true ? "meta" : null,
    record.isSidechain === true ? "sidechain" : null,
    record.isCompactSummary === true ? "compact summary" : null,
  ]);
  const lines = [`[${index}] ${timestamp} ${role}${meta}`];
  lines.push(...formatContent(message.content, "  "));

  const messageMetadata = omitKeys(message, ["role", "content"]);
  if (hasKeys(messageMetadata)) {
    lines.push("  message metadata:");
    lines.push(...prefixedJson("    ", messageMetadata));
  }
  lines.push(
    ...formatRecordMetadata(record, ["type", "timestamp", "message"], "  "),
  );
  return lines;
}

function formatCodexContent(content: unknown, prefix: string): string[] {
  return formatContent(content, prefix);
}

function formatCodexPayload(
  payload: JsonRecord,
  timestamp: string,
  index: number,
): string[] {
  const payloadType = asString(payload.type) || "unknown";

  if (payloadType === "message") {
    const role = asString(payload.role) || "message";
    const lines = [`[${index}] ${timestamp} ${role}`];
    lines.push(...formatCodexContent(payload.content, "  "));
    const metadata = omitKeys(payload, ["type", "role", "content"]);
    if (hasKeys(metadata)) {
      lines.push("  payload metadata:");
      lines.push(...prefixedJson("    ", metadata));
    }
    return lines;
  }

  if (
    payloadType === "function_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "local_shell_call"
  ) {
    const name = asString(payload.name) || asString(payload.command) || "tool";
    const status = asString(payload.status);
    const callId = asString(payload.call_id) || asString(payload.id);
    const lines = [
      `[${index}] ${timestamp} ${payloadType} ${name}${formatInlineMeta([
        status ? `status=${status}` : null,
        callId ? `id=${callId}` : null,
      ])}`,
    ];
    const args = payload.arguments ?? payload.input ?? payload.action;
    if (args !== undefined) {
      lines.push("  input:");
      if (typeof args === "string") {
        const parsed = safeJsonParse(args);
        lines.push(
          ...(parsed ? prefixedJson("    ", parsed) : prefixed("    ", args)),
        );
      } else {
        lines.push(...prefixedJson("    ", args));
      }
    }
    const metadata = omitKeys(payload, [
      "type",
      "name",
      "command",
      "status",
      "call_id",
      "id",
      "arguments",
      "input",
      "action",
    ]);
    if (hasKeys(metadata)) {
      lines.push("  payload metadata:");
      lines.push(...prefixedJson("    ", metadata));
    }
    return lines;
  }

  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output"
  ) {
    const callId = asString(payload.call_id);
    const lines = [
      `[${index}] ${timestamp} ${payloadType}${callId ? ` id=${callId}` : ""}`,
    ];
    const output = payload.output ?? payload.content;
    lines.push(...formatContent(output, "  "));
    const metadata = omitKeys(payload, [
      "type",
      "call_id",
      "output",
      "content",
    ]);
    if (hasKeys(metadata)) {
      lines.push("  payload metadata:");
      lines.push(...prefixedJson("    ", metadata));
    }
    return lines;
  }

  if (payloadType === "reasoning") {
    const lines = [`[${index}] ${timestamp} reasoning`];
    const summary = payload.summary ?? payload.content;
    if (summary !== undefined) lines.push(...formatContent(summary, "  "));
    if (typeof payload.encrypted_content === "string") {
      lines.push(
        `  [encrypted_content: ${payload.encrypted_content.length} chars]`,
      );
    }
    const metadata = omitKeys(payload, [
      "type",
      "summary",
      "content",
      "encrypted_content",
    ]);
    if (hasKeys(metadata)) {
      lines.push("  payload metadata:");
      lines.push(...prefixedJson("    ", metadata));
    }
    return lines;
  }

  return [
    `[${index}] ${timestamp} ${payloadType}`,
    ...prefixedJson("  ", payload),
  ];
}

function formatCodexRecord(record: JsonRecord, index: number): string[] {
  const timestamp = formatTimestamp(record.timestamp);
  const type = asString(record.type) || "unknown";

  if (type === "response_item" && isRecord(record.payload)) {
    const lines = formatCodexPayload(record.payload, timestamp, index);
    lines.push(
      ...formatRecordMetadata(record, ["type", "timestamp", "payload"], "  "),
    );
    return lines;
  }

  if (isRecord(record.payload)) {
    const lines = [`[${index}] ${timestamp} ${type}`];
    lines.push(...prefixedJson("  ", record.payload));
    lines.push(
      ...formatRecordMetadata(record, ["type", "timestamp", "payload"], "  "),
    );
    return lines;
  }

  return [`[${index}] ${timestamp} ${type}`, ...prefixedJson("  ", record)];
}

function parseTranscriptFile(filePath: string, model: PromptSource): string[] {
  const content = readFileSync(filePath, "utf8");
  const sourceLines = content.split("\n").filter((line) => line.length > 0);
  const lines: string[] = [];

  sourceLines.forEach((line, lineIndex) => {
    if (lineIndex > 0) lines.push("");
    const parsed = safeJsonParse(line);
    if (!isRecord(parsed)) {
      lines.push(`[${lineIndex + 1}] invalid JSONL record`);
      lines.push(...prefixed("  ", line));
      return;
    }

    lines.push(
      ...(model === "claude"
        ? formatClaudeRecord(parsed, lineIndex + 1)
        : formatCodexRecord(parsed, lineIndex + 1)),
    );
  });

  return lines;
}

export function buildTaskTranscriptSnapshot(
  task: Task,
): TaskTranscriptSnapshot {
  const model = task.model;
  const generatedAt = new Date().toISOString();

  if (!model) {
    return {
      model,
      filePath: null,
      generatedAt,
      recordCount: 0,
      fileSizeBytes: null,
      fileMtimeMs: null,
      lines: ["No model is selected for this task."],
      error: "No model selected.",
    };
  }

  const filePath = resolveTaskSessionFile(task, model, {
    preferExactSession: true,
  });
  if (!filePath) {
    return {
      model,
      filePath: null,
      generatedAt,
      recordCount: 0,
      fileSizeBytes: null,
      fileMtimeMs: null,
      lines: [`No local ${model} transcript file was found for this task.`],
      error: "Transcript file not found.",
    };
  }

  try {
    const stats = statSync(filePath);
    const lines = parseTranscriptFile(filePath, model);
    return {
      model,
      filePath,
      generatedAt,
      recordCount: Math.max(
        0,
        lines.filter((line) => /^\[\d+\]/.test(line)).length,
      ),
      fileSizeBytes: stats.size,
      fileMtimeMs: stats.mtimeMs,
      lines: lines.length > 0 ? lines : ["Transcript file is empty."],
      error: null,
    };
  } catch (error: any) {
    return {
      model,
      filePath,
      generatedAt,
      recordCount: 0,
      fileSizeBytes: null,
      fileMtimeMs: null,
      lines: [
        `Failed to read ${model} transcript file.`,
        error?.message ? String(error.message) : String(error),
      ],
      error: error?.message
        ? String(error.message)
        : "Failed to read transcript.",
    };
  }
}
