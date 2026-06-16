import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateRequestedTaskId } from "./task-id.js";

export const eventTypes = [
  "task.created",
  "lease.approved",
  "lease.rejected",
  "patch.submitted",
  "patch.accepted",
  "patch.rejected",
  "cache.read",
  "integration.queued",
  "integration.passed",
  "integration.failed"
] as const;

export type HivemindEventType = (typeof eventTypes)[number];

export interface HivemindEvent {
  ts: string;
  type: HivemindEventType;
  task_id: string | null;
  data: Record<string, unknown>;
}

export interface HivemindEventInput {
  type: HivemindEventType;
  task_id: string | null;
  data: Record<string, unknown>;
}

export async function appendEvent(repoRoot: string, input: HivemindEventInput): Promise<{ ok: true; value: HivemindEvent } | { ok: false; reason: string }> {
  const validation = validateEventInput(input);
  if (!validation.ok) {
    return validation;
  }

  const event: HivemindEvent = {
    ts: new Date().toISOString(),
    type: input.type,
    task_id: input.task_id,
    data: input.data
  };

  let line: string;
  try {
    line = `${JSON.stringify(event)}\n`;
  } catch {
    return { ok: false, reason: "event data must be JSON serializable" };
  }

  const eventPath = eventLogPath(repoRoot);
  await mkdir(path.dirname(eventPath), { recursive: true });
  await appendFile(eventPath, line, "utf8");
  return { ok: true, value: event };
}

export async function readEvents(repoRoot: string): Promise<{ ok: true; value: HivemindEvent[] } | { ok: false; reason: string }> {
  let content: string;
  try {
    content = await readFile(eventLogPath(repoRoot), "utf8");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: [] };
    }
    throw error;
  }

  const events: HivemindEvent[] = [];
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: `invalid JSON in events.jsonl line ${index + 1}` };
    }
    const validation = validateEventShape(parsed);
    if (!validation.ok) {
      return { ok: false, reason: `invalid event in events.jsonl line ${index + 1}: ${validation.reason}` };
    }
    events.push(parsed as HivemindEvent);
  }

  return { ok: true, value: events };
}

function validateEventInput(input: HivemindEventInput): { ok: true } | { ok: false; reason: string } {
  return validateEventShape({ ts: new Date().toISOString(), ...input });
}

function validateEventShape(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "event must be a JSON object" };
  }
  if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) {
    return { ok: false, reason: "event ts must be an ISO timestamp string" };
  }
  if (!isEventType(value.type)) {
    return { ok: false, reason: "event type is invalid" };
  }
  if (value.task_id !== null) {
    if (typeof value.task_id !== "string") {
      return { ok: false, reason: "event task_id must be a string or null" };
    }
    const taskIdResult = validateRequestedTaskId(value.task_id);
    if (!taskIdResult.ok) {
      return { ok: false, reason: `event task_id is invalid: ${taskIdResult.reason}` };
    }
  }
  if (!isRecord(value.data)) {
    return { ok: false, reason: "event data must be a JSON object" };
  }
  return { ok: true };
}

function eventLogPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "log", "events.jsonl");
}

function isEventType(value: unknown): value is HivemindEventType {
  return typeof value === "string" && (eventTypes as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
