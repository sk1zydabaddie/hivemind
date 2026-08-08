import path from "node:path";
import {
  appendTrailLine,
  readTrail,
  repairTrail,
  type TrailDamage,
  type TrailRepair
} from "./jsonl-trail.js";
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

  // Worker stdout is the largest thing written anywhere in the system -- lines
  // of 23,408 bytes are in this repository's own captured trail -- and this
  // path previously had no serialisation at all, not even in-process.
  const appended = await appendTrailLine(taskOutputLogPath(repoRoot, input.task_id), line);
  if (!appended.ok) {
    return appended;
  }
  return { ok: true, value: record };
}

export async function readTaskOutput(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: TaskOutputRecord[] } | { ok: false; reason: string; damage?: TrailDamage }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return { ok: false, reason: taskIdResult.reason };
  }

  return readTrail<TaskOutputRecord>(
    repoRoot,
    taskOutputLogPath(repoRoot, taskId),
    taskOutputRelativePath(taskId),
    (value) => validateTaskOutputShape(value, taskId),
    taskOutputRepairCommand(taskId)
  );
}

export function taskOutputRepairCommand(taskId: string): string {
  return `hivemind events repair --task ${taskId}`;
}

/**
 * Removes an interrupted trailing append from a task's output stream.
 *
 * Unlike the event trail this does not record itself, because the output
 * stream is a record of what a provider printed rather than a record anything
 * derives a guarantee from -- and appending a repair notice into a worker's
 * stdout would put a Hivemind sentence in the provider's mouth. The event
 * trail is where the repair is recorded.
 */
export async function repairTaskOutput(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: TrailRepair | null } | { ok: false; reason: string }> {
  const read = await readTaskOutput(repoRoot, taskId);
  if (read.ok) {
    return { ok: true, value: null };
  }
  if (read.damage === undefined) {
    return { ok: false, reason: read.reason };
  }
  return repairTrail(
    taskOutputLogPath(repoRoot, taskId),
    taskOutputRelativePath(taskId),
    read.damage,
    new Date().toISOString().replaceAll(":", "-")
  );
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
