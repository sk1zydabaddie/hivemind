import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateRequestedTaskId } from "./task-id.js";

export type TaskOutputStream = "stdout" | "stderr";

export interface TaskOutputRecord {
  ts: string;
  task_id: string;
  tool: string;
  stream: TaskOutputStream;
  text: string;
}

export interface TaskOutputInput {
  task_id: string;
  tool: string;
  stream: TaskOutputStream;
  text: string;
}

export async function appendTaskOutput(
  repoRoot: string,
  input: TaskOutputInput
): Promise<{ ok: true; value: TaskOutputRecord } | { ok: false; reason: string }> {
  const validation = validateTaskOutputInput(input);
  if (!validation.ok) {
    return validation;
  }

  const record: TaskOutputRecord = {
    ts: new Date().toISOString(),
    task_id: input.task_id,
    tool: input.tool,
    stream: input.stream,
    text: input.text
  };

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    return { ok: false, reason: "task output data must be JSON serializable" };
  }

  const outputPath = taskOutputLogPath(repoRoot, input.task_id);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await appendFile(outputPath, line, "utf8");
  return { ok: true, value: record };
}

export async function readTaskOutput(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: TaskOutputRecord[] } | { ok: false; reason: string }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return { ok: false, reason: taskIdResult.reason };
  }

  let content: string;
  try {
    content = await readFile(taskOutputLogPath(repoRoot, taskId), "utf8");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: [] };
    }
    throw error;
  }

  const records: TaskOutputRecord[] = [];
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: `invalid JSON in ${taskOutputRelativePath(taskId)} line ${index + 1}` };
    }
    const validation = validateTaskOutputShape(parsed, taskId);
    if (!validation.ok) {
      return { ok: false, reason: `invalid task output in ${taskOutputRelativePath(taskId)} line ${index + 1}: ${validation.reason}` };
    }
    records.push(parsed as TaskOutputRecord);
  }

  return { ok: true, value: records };
}

export function taskOutputRelativePath(taskId: string): string {
  return `.hivemind/log/tasks/${taskId}.output.jsonl`;
}

function taskOutputLogPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, ".hivemind", "log", "tasks", `${taskId}.output.jsonl`);
}

function validateTaskOutputInput(input: TaskOutputInput): { ok: true } | { ok: false; reason: string } {
  const taskIdResult = validateRequestedTaskId(input.task_id);
  if (!taskIdResult.ok) {
    return { ok: false, reason: `task output task_id is invalid: ${taskIdResult.reason}` };
  }
  if (typeof input.tool !== "string" || input.tool.trim() === "") {
    return { ok: false, reason: "task output tool must be a non-empty string" };
  }
  if (input.stream !== "stdout" && input.stream !== "stderr") {
    return { ok: false, reason: "task output stream must be stdout or stderr" };
  }
  if (typeof input.text !== "string") {
    return { ok: false, reason: "task output text must be a string" };
  }
  return { ok: true };
}

function validateTaskOutputShape(value: unknown, expectedTaskId: string): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "task output record must be a JSON object" };
  }
  if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) {
    return { ok: false, reason: "task output ts must be an ISO timestamp string" };
  }
  if (value.task_id !== expectedTaskId) {
    return { ok: false, reason: "task output task_id must match the stream task" };
  }
  if (typeof value.tool !== "string" || value.tool.trim() === "") {
    return { ok: false, reason: "task output tool must be a non-empty string" };
  }
  if (value.stream !== "stdout" && value.stream !== "stderr") {
    return { ok: false, reason: "task output stream must be stdout or stderr" };
  }
  if (typeof value.text !== "string") {
    return { ok: false, reason: "task output text must be a string" };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
