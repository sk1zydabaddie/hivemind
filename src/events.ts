import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateRequestedTaskId } from "./task-id.js";

const eventAppendQueues = new Map<string, Promise<void>>();

export const eventTypes = [
  "task.created",
  "task.authoring_base_prepared",
  "task.assigned",
  "task.scouting_started",
  "task.run_accepted",
  "task.started",
  "task.worker_process_started",
  "task.worker_process_stopped",
  "task.completed",
  "task.failed",
  "task.paused",
  "task.cancel_requested",
  "task.cancelled",
  "task.submitted",
  "task.in_review",
  "task.revision_requested",
  "task.redirected",
  "task.integrated",
  "task.checkpointed",
  "task.resumed",
  "task.rerouted",
  "task.blocked",
  "write_intent.submitted",
  "write_intent.approved",
  "write_intent.rejected",
  "lease.requested",
  "lease.approved",
  "lease.rejected",
  "lease.released",
  "patch.submitted",
  "patch.accepted",
  "patch.rejected",
  "patch.revision_requested",
  "cache.read",
  "scout.completed",
  "replan.triggered",
  "integration.queued",
  "integration.started",
  "integration.passed",
  "integration.failed",
  "integration.blocked",
  "integration.low_confidence",
  "adoption.reviewed",
  "adoption.started",
  "adoption.completed",
  "adoption.failed",
  "adoption.indeterminate",
  "verification.completed",
  "verification.rerun_started",
  "verification.rerun_completed",
  "verification.rerun_failed",
  "memory.proposed",
  "memory.accepted",
  "routing.observed",
  "routing.corpus_registered",
  "quality.admission_decided",
  "quality.draft_started",
  "quality.worker_process_started",
  "quality.draft_verified",
  "quality.draft_disposed",
  "quality.selection_decided",
  "quality.refinement_completed",
  "quality.cancel_requested",
  "quality.cancel_failed",
  "quality.cancelled",
  "plan.ratified",
  "plan.prepared",
  "manual_task.authorized",
  "plan.amendment_queued",
  "autonomy.level_changed",
  "autonomy.decision_recorded",
  "human.guidance_recorded",
  "human.guidance_consumed",
  "manager.judgment_requested",
  "manager.action_approved",
  "manager.action_retry_requested",
  "scheduler.wave_started",
  "scheduler.wave_completed",
  "scheduler.wave_stopped",
  "scheduler.wave_settled",
  "scheduler.run_cancel_requested",
  "scheduler.run_cancelled",
  "scheduler.run_cancel_failed",
  "approval.required",
  "quota.low",
  "quota.exhausted",
  "spec.ratified",
  "context.low",
  "orchestrator.checkpointed",
  "orchestrator.resumed"
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
  await appendCompleteEventLine(eventPath, line);
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

  if (content.length > 0 && !content.endsWith("\n")) {
    return { ok: false, reason: "events.jsonl ends with an incomplete event line" };
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

export async function appendTaskCreatedIfMissing(
  repoRoot: string,
  taskId: string,
  data: Record<string, unknown>
): Promise<{ ok: true; appended: boolean } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  if (events.value.some((event) => event.type === "task.created" && event.task_id === taskId)) {
    return { ok: true, appended: false };
  }

  const appended = await appendEvent(repoRoot, {
    type: "task.created",
    task_id: taskId,
    data
  });
  return appended.ok ? { ok: true, appended: true } : appended;
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

async function appendCompleteEventLine(eventPath: string, line: string): Promise<void> {
  const key = eventQueueKey(eventPath);
  const previous = eventAppendQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => slot);
  eventAppendQueues.set(key, next);

  await previous.catch(() => undefined);
  try {
    await mkdir(path.dirname(eventPath), { recursive: true });
    // C3's append-only exception: one complete JSON line in one O_APPEND write.
    await appendFile(eventPath, line, "utf8");
  } finally {
    release();
    if (eventAppendQueues.get(key) === next) {
      eventAppendQueues.delete(key);
    }
  }
}

function eventQueueKey(eventPath: string): string {
  const resolved = path.normalize(path.resolve(eventPath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
