import path from "node:path";
import type { HivemindEvent } from "./events.js";
import { readJsonFile } from "./json.js";
import { validateRequestedTaskId } from "./task-id.js";

export interface IntegrationStatus {
  branch: string;
  applied: string[];
  tests: "pass" | "fail";
  report: string;
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

    if (event.type === "integration.failed") {
      for (const taskId of eventAppliedTaskIds(event)) {
        integrated.delete(taskId);
      }
    }
  }

  return integrated;
}

export async function loadIntegrationQueue(
  repoRoot: string
): Promise<{ ok: true; value: IntegrationQueueEntry[] } | { ok: false; reason: string }> {
  const queuePath = path.join(repoRoot, ".hivemind", "integration", "queue.json");
  let raw: unknown;
  try {
    raw = await readJsonFile(queuePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: "integration queue not found: .hivemind/integration/queue.json" };
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

  return problems.length === 0 ? { ok: true, value: entries } : { ok: false, reason: problems.join("; ") };
}

function hasAcceptedCurrentPatch(trail: PatchTrail | undefined): boolean {
  return trail !== undefined && trail.submittedIndex >= 0 && trail.acceptedIndex > trail.submittedIndex && trail.acceptedIndex > trail.rejectedIndex;
}

function eventAppliedTaskIds(event: HivemindEvent): string[] {
  const applied = event.data.applied;
  return Array.isArray(applied) ? applied.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
