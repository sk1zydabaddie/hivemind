import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { parseQualityRunId } from "./value-quality.js";

export interface QualityCancellationResult {
  quality_run_id: string;
  task_id: string;
  status: "cancelled";
}

const cancellationWaitMs = 10_000;

export async function cancelQualityRun(
  repoRoot: string,
  request: unknown
): Promise<{ ok: true; value: QualityCancellationResult } | { ok: false; reason: string }> {
  if (!isRecord(request)) return { ok: false, reason: "quality cancellation must be a JSON object" };
  const extra = Object.keys(request).filter((key) => key !== "quality_run_id" && key !== "reason");
  if (extra.length > 0) return { ok: false, reason: `quality cancellation contains unsupported authority field: ${extra[0]}` };
  if (typeof request.quality_run_id !== "string") return { ok: false, reason: "quality_run_id is required" };
  const parsed = parseQualityRunId(request.quality_run_id);
  if (!parsed.ok) return parsed;
  if (typeof request.reason !== "string" || request.reason.trim() === "" || request.reason.length > 2000) {
    return { ok: false, reason: "quality cancellation reason must be a non-empty string of at most 2000 characters" };
  }
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const admitted = events.value.filter((event) =>
    event.type === "quality.admission_decided" &&
    event.task_id === parsed.taskId &&
    event.data.quality_run_id === request.quality_run_id &&
    event.data.admitted === true
  );
  if (admitted.length !== 1) {
    return { ok: false, reason: `quality cancellation refused: no unique admitted run ${request.quality_run_id}` };
  }
  if (events.value.some((event) => event.type === "quality.cancelled" && event.data.quality_run_id === request.quality_run_id)) {
    return { ok: false, reason: `quality run is already cancelled: ${request.quality_run_id}` };
  }
  if (!events.value.some((event) => event.type === "quality.cancel_requested" && event.data.quality_run_id === request.quality_run_id)) {
    const requested = await appendEvent(repoRoot, {
      type: "quality.cancel_requested",
      task_id: parsed.taskId,
      data: { version: 1, quality_run_id: request.quality_run_id, reason: request.reason.trim(), requested_by: "human" }
    });
    if (!requested.ok) return requested;
  }
  const deadline = Date.now() + cancellationWaitMs;
  while (Date.now() <= deadline) {
    const finalized = await finalizeQualityRunCancellation(repoRoot, request.quality_run_id);
    if (finalized.ok && finalized.value) {
      return { ok: true, value: { quality_run_id: request.quality_run_id, task_id: parsed.taskId, status: "cancelled" } };
    }
    if (!finalized.ok) return finalized;
    await delay(100);
  }
  return { ok: false, reason: `quality cancellation requested but cleanup did not finish within ${cancellationWaitMs}ms` };
}

export async function qualityRunCancelled(repoRoot: string, qualityRunId: string): Promise<boolean> {
  const events = await readEvents(repoRoot);
  return events.ok && events.value.some((event) =>
    (event.type === "quality.cancel_requested" || event.type === "quality.cancelled") &&
    event.data.quality_run_id === qualityRunId
  );
}

export async function finalizeQualityRunCancellation(
  repoRoot: string,
  qualityRunId: string
): Promise<{ ok: true; value: boolean } | { ok: false; reason: string }> {
  const parsed = parseQualityRunId(qualityRunId);
  if (!parsed.ok) return parsed;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  if (events.value.some((event) => event.type === "quality.cancelled" && event.data.quality_run_id === qualityRunId)) {
    return { ok: true, value: true };
  }
  const request = events.value.filter((event) => event.type === "quality.cancel_requested" && event.data.quality_run_id === qualityRunId).at(-1);
  if (request === undefined) return { ok: false, reason: `quality cancellation refused: no durable cancel request for ${qualityRunId}` };
  const open = openDraftStages(events.value, qualityRunId);
  if (!open.ok) return open;
  if (open.value.length > 0) return { ok: true, value: false };
  const cancelled = await appendEvent(repoRoot, {
    type: "quality.cancelled",
    task_id: parsed.taskId,
    data: {
      version: 1,
      quality_run_id: qualityRunId,
      reason: typeof request.data.reason === "string" ? request.data.reason : "human cancellation requested",
      canonical_state_touched: false,
      completed_artifacts_preserved_as_evidence: true,
      pending_work_disposed: true
    }
  });
  return cancelled.ok ? { ok: true, value: true } : cancelled;
}

function openDraftStages(
  events: HivemindEvent[],
  qualityRunId: string
): { ok: true; value: string[] } | { ok: false; reason: string } {
  const open = new Set<string>();
  for (const event of events) {
    if (event.data.quality_run_id !== qualityRunId) continue;
    if (event.type !== "quality.draft_started" && event.type !== "quality.draft_disposed") continue;
    if (typeof event.data.draft_id !== "string") {
      return { ok: false, reason: `quality cancellation refused: malformed ${event.type} evidence for ${qualityRunId}` };
    }
    if (event.type === "quality.draft_started") open.add(event.data.draft_id);
    else open.delete(event.data.draft_id);
  }
  return { ok: true, value: [...open].sort() };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
