import path from "node:path";
import {
  appendTrailLine,
  readTrail,
  repairTrail,
  type TrailDamage,
  type TrailRepair
} from "./jsonl-trail.js";
import { validateRequestedTaskId } from "./task-id.js";

/**
 * Serialises appends inside this process before they reach the cross-process
 * lock. Not a correctness mechanism on its own -- the daemon, the CLI and the
 * MCP server are separate processes -- but it keeps a busy process from
 * fighting itself for the file lock.
 */
const eventAppendQueues = new Map<string, Promise<void>>();
type EventPublisher = (event: HivemindEvent) => void;
let publisher: EventPublisher | null = null;

/** Registered by the daemon that owns the live subscribers. */
export function setEventPublisher(next: EventPublisher | null): void {
  publisher = next;
}

export const eventTrailRepairCommand = "hivemind events repair";

export const eventTypes = [
  "task.created",
  "task.authoring_base_prepared",
  "task.run_accepted",
  "task.started",
  "task.worker_process_started",
  "task.worker_process_stopped",
  "task.completed",
  "task.failed",
  "task.paused",
  "task.cancel_requested",
  "task.cancelled",
  "task.revision_requested",
  "task.redirected",
  "task.checkpointed",
  "task.resumed",
  "task.rerouted",
  "task.blocked",
  "write_intent.submitted",
  "write_intent.approved",
  "write_intent.rejected",
  "lease.approved",
  "lease.rejected",
  "lease.released",
  "patch.submitted",
  "patch.accepted",
  "patch.rejected",
  "cache.read",
  "scout.completed",
  "replan.triggered",
  "integration.queued",
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
  "plan.amendment_queued",
  "autonomy.level_changed",
  "autonomy.decision_recorded",
  "human.guidance_recorded",
  "human.guidance_consumed",
  "manager.judgment_requested",
  "manager.run_started",
  "manager.run_completed",
  "manager.run_failed",
  "manager.worker_process_starting",
  "manager.worker_process_started",
  "manager.worker_process_stopped",
  "manager.action_approved",
  "manager.action_retry_requested",
  "scheduler.wave_started",
  "scheduler.wave_completed",
  "scheduler.wave_stopped",
  "scheduler.wave_settled",
  "scheduler.run_cancel_requested",
  "scheduler.run_cancelled",
  "scheduler.run_cancel_failed",
  "quota.exhausted",
  /* A provider-owned rate-limit snapshot observed in the completed adapter
     stream. This is deliberately distinct from quota.exhausted, which is
     Hivemind's own deterministic spending-ceiling event. */
  "provider.quota_observed",
  /* Provider setup has side effects outside React (a provider-owned terminal
     or a bounded capability probe). These three events make the transition
     durable without carrying credentials or provider output into the trail. */
  "provider.setup_started",
  "provider.setup_completed",
  "provider.setup_failed",
  "conversation.message_recorded",
  /* What the drafter said back when the message was not a build request. It
     carries advisory_only/authorization_effect exactly as human guidance does,
     because a reply is a message and never a permission. */
  "conversation.reply_recorded",
  /* A person asked to start talking again. It moves where the THREAD begins and
     nothing else: the trail keeps every earlier message, and a prepared plan is
     untouched. See `startNewConversation`. */
  "conversation.started",
  "spec.draft_started",
  "spec.draft_completed",
  "spec.draft_failed",
  "orchestrator.checkpointed",
  "orchestrator.resumed",
  // A repair that leaves no trace makes the trail unable to explain its own
  // gap. This records what was removed and where the quarantined copy went.
  "trail.repaired"
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

  const appended = await appendCompleteEventLine(eventLogPath(repoRoot), line);
  if (!appended.ok) {
    return appended;
  }
  /* Publication follows the durable append immediately. It must not wait for
     the provider action that caused this event to return. */
  publisher?.(event);
  return { ok: true, value: event };
}

export async function readEvents(
  repoRoot: string
): Promise<{ ok: true; value: HivemindEvent[] } | { ok: false; reason: string; damage?: TrailDamage }> {
  return readTrail<HivemindEvent>(
    repoRoot,
    eventLogPath(repoRoot),
    eventTrailRelativePath,
    validateEventShape,
    eventTrailRepairCommand
  );
}

export interface EventPage {
  /** Newest event first. */
  events: HivemindEvent[];
  /** Exclusive event-index cursor for the next older page. */
  next_before: number | null;
}

/**
 * One bounded page of the durable trail.
 *
 * The cursor is an exclusive event index, not a timestamp: multiple durable
 * events may legitimately share a timestamp, while append order is exact. New
 * appends do not move an older cursor, so loading history while work continues
 * cannot duplicate or skip a record.
 */
export async function readEventPage(
  repoRoot: string,
  options: { before?: number; limit: number }
): Promise<{ ok: true; value: EventPage } | { ok: false; reason: string }> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    return { ok: false, reason: "trail page limit must be an integer from 1 to 500" };
  }
  const trail = await readEvents(repoRoot);
  if (!trail.ok) return trail;
  const before = options.before ?? trail.value.length;
  if (!Number.isSafeInteger(before) || before < 0 || before > trail.value.length) {
    return { ok: false, reason: "trail page cursor is outside the durable trail" };
  }
  const start = Math.max(0, before - options.limit);
  return {
    ok: true,
    value: {
      events: trail.value.slice(start, before).reverse(),
      next_before: start === 0 ? null : start
    }
  };
}

/**
 * Removes an interrupted trailing append from the event trail, and records
 * that it did.
 *
 * A repair that leaves no trace makes the trail unable to explain its own
 * gap, so the removal is appended back to the trail it just repaired.
 */
export async function repairEventTrail(
  repoRoot: string
): Promise<{ ok: true; value: TrailRepair | null } | { ok: false; reason: string }> {
  const read = await readEvents(repoRoot);
  if (read.ok) {
    return { ok: true, value: null };
  }
  if (read.damage === undefined) {
    return { ok: false, reason: read.reason };
  }
  const repaired = await repairTrail(
    eventLogPath(repoRoot),
    eventTrailRelativePath,
    read.damage,
    new Date().toISOString().replaceAll(":", "-")
  );
  if (!repaired.ok) {
    return repaired;
  }
  const recorded = await appendEvent(repoRoot, {
    type: "trail.repaired",
    task_id: null,
    data: {
      version: 1,
      file: repaired.value.file,
      quarantine_path: path.relative(repoRoot, repaired.value.quarantine_path).replaceAll("\\", "/"),
      removed_bytes: repaired.value.removed_bytes,
      intact_records: repaired.value.intact_records
    }
  });
  if (!recorded.ok) {
    return recorded;
  }
  return repaired;
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

const eventTrailRelativePath = ".hivemind/log/events.jsonl";

function eventLogPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "log", "events.jsonl");
}

async function appendCompleteEventLine(
  eventPath: string,
  line: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
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
    // C3's append-only exception, now actually enforced: one complete JSON
    // line, one write, under a lock every process honours. The in-process
    // queue above only keeps this process from queueing on its own file lock.
    const appended = await appendTrailLine(eventPath, line);
    return appended.ok ? { ok: true } : appended;
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
