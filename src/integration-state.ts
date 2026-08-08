import path from "node:path";
import { readEvents, type HivemindEvent } from "./events.js";
import { codedFailure, type CodedFailure } from "./failure-code.js";
import { readJsonFile } from "./json.js";
import { validateRequestedTaskId } from "./task-id.js";

export interface IntegrationStatus {
  branch: string;
  applied: string[];
  tests: "pass" | "fail" | "blocked";
  report: string;
  verification_id?: string;
  verification_manifest_path?: string;
  verification_manifest_sha256?: string;
}

export interface IntegrationQueueEntry {
  task_id: string;
}

interface PatchTrail {
  submittedIndex: number;
  acceptedIndex: number;
  rejectedIndex: number;
}

export function integratedTaskIdsFromEvents(events: HivemindEvent[]): Set<string> {
  const patches = new Map<string, PatchTrail>();
  const integrated = new Set<string>();

  for (const [index, event] of events.entries()) {
    if (event.type === "patch.submitted" && event.task_id !== null) {
      patches.set(event.task_id, {
        submittedIndex: index,
        acceptedIndex: -1,
        rejectedIndex: -1
      });
      integrated.delete(event.task_id);
      continue;
    }

    if (event.type === "patch.accepted" && event.task_id !== null && event.data.verdict === "accept") {
      const trail = patches.get(event.task_id);
      if (trail !== undefined) {
        trail.acceptedIndex = index;
      }
      continue;
    }

    if (event.type === "patch.rejected" && event.task_id !== null) {
      const trail = patches.get(event.task_id);
      if (trail !== undefined) {
        trail.rejectedIndex = index;
      }
      integrated.delete(event.task_id);
      continue;
    }

    if (event.type === "integration.passed") {
      for (const taskId of eventAppliedTaskIds(event)) {
        if (hasAcceptedCurrentPatch(patches.get(taskId))) {
          integrated.add(taskId);
        }
      }
      continue;
    }

    if (event.type === "integration.failed" || event.type === "integration.blocked") {
      for (const taskId of eventAppliedTaskIds(event)) {
        integrated.delete(taskId);
      }
    }
  }

  return integrated;
}

/**
 * The queue holds patches that are accepted and not yet on the base branch.
 *
 * Only adoption puts a patch on that branch. A passing shadow verification is a
 * rehearsal in a worktree that is deleted immediately, and the human may never
 * authorize the set it verified, so `integration.passed` must not drain an
 * entry -- doing so would leave the patch pending with nothing left to
 * re-enqueue it.
 *
 * An entry is therefore pending unless an adoption durably took it, and it
 * becomes pending again if a newer patch was submitted for that task after that
 * adoption. Anything uncertain stays queued: this may retain an entry that is
 * already integrated, which costs a re-gate, but it can never drop a patch that
 * is still waiting.
 */
export function pendingQueueEntries(
  entries: IntegrationQueueEntry[],
  events: HivemindEvent[]
): IntegrationQueueEntry[] {
  const adoptedAt = new Map<string, number>();
  const submittedAt = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === "adoption.completed") {
      for (const taskId of eventTaskIds(event)) adoptedAt.set(taskId, index);
      continue;
    }
    if (event.type === "patch.submitted" && event.task_id !== null) {
      submittedAt.set(event.task_id, index);
    }
  }

  return entries.filter((entry) => {
    const adopted = adoptedAt.get(entry.task_id);
    if (adopted === undefined) return true;
    const submitted = submittedAt.get(entry.task_id);
    return submitted !== undefined && submitted > adopted;
  });
}

export async function loadIntegrationQueue(
  repoRoot: string
): Promise<{ ok: true; value: IntegrationQueueEntry[] } | CodedFailure> {
  const queuePath = path.join(repoRoot, ".hivemind", "integration", "queue.json");
  let raw: unknown;
  try {
    raw = await readJsonFile(queuePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      // Three callers treat "no queue file" as "empty queue". That is a real
      // distinction, so it carries a code rather than being recovered from the
      // sentence.
      return codedFailure("integration_queue_not_found", "integration queue not found: .hivemind/integration/queue.json");
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/integration/queue.json" };
    }
    throw error;
  }

  if (!Array.isArray(raw)) {
    return { ok: false, reason: "integration queue must be an array" };
  }

  const entries: IntegrationQueueEntry[] = [];
  const problems: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.task_id !== "string") {
      problems.push(`queue[${index}].task_id must be a string`);
      continue;
    }
    const taskIdResult = validateRequestedTaskId(entry.task_id);
    if (!taskIdResult.ok) {
      problems.push(`queue[${index}].${taskIdResult.reason}`);
      continue;
    }
    entries.push({ task_id: entry.task_id });
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  // The trail decides what is still pending. An unreadable trail fails the load
  // closed rather than reporting an undrained queue as current.
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  return { ok: true, value: pendingQueueEntries(entries, events.value) };
}

function hasAcceptedCurrentPatch(trail: PatchTrail | undefined): boolean {
  return trail !== undefined && trail.submittedIndex >= 0 && trail.acceptedIndex > trail.submittedIndex && trail.acceptedIndex > trail.rejectedIndex;
}

function eventAppliedTaskIds(event: HivemindEvent): string[] {
  const applied = event.data.applied;
  return Array.isArray(applied) ? applied.filter((entry): entry is string => typeof entry === "string") : [];
}

function eventTaskIds(event: HivemindEvent): string[] {
  const taskIds = event.data.task_ids;
  return Array.isArray(taskIds) ? taskIds.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
