import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";
import { parseQualityRunId } from "./value-quality.js";

export interface QualityCancellationResult {
  quality_run_id: string;
  task_id: string;
  status: "cancelled";
}

const cancellationWaitMs = 10_000;

export async function cancelQualityRun(
  repoRoot: string,
  request: unknown,
  options: { waitMs?: number } = {}
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
  const waitMs = options.waitMs ?? cancellationWaitMs;
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const finalized = await finalizeQualityRunCancellation(repoRoot, request.quality_run_id);
    if (finalized.ok && finalized.value) {
      return { ok: true, value: { quality_run_id: request.quality_run_id, task_id: parsed.taskId, status: "cancelled" } };
    }
    if (!finalized.ok) return finalized;
    await delay(100);
  }
  return recordQualityCancellationFailure(
    repoRoot,
    request.quality_run_id,
    `cleanup did not finish within ${waitMs}ms`,
    "cancel_timeout"
  );
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

export async function preflightQualityCancellationReconciliation(
  repoRoot: string,
  options: { probeLiveness?: (pid: number) => ProcessLiveness } = {}
): Promise<{ ok: true; value: { blocked: boolean } } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const probe = options.probeLiveness ?? getProcessLiveness;
  let blocked = false;
  for (const qualityRunId of openCancelledQualityRuns(events.value)) {
    const open = openDraftStages(events.value, qualityRunId);
    if (!open.ok) return open;
    for (const draftId of open.value) {
      const identity = qualityWorkerIdentity(events.value, qualityRunId, draftId);
      const liveness = identity.ok ? probe(identity.value.pid) : "unknown";
      if (!identity.ok || liveness !== "dead") {
        blocked = true;
        const reason = identity.ok
          ? `daemon restart cannot prove quality worker pid ${identity.value.pid} is dead; liveness is ${liveness}`
          : identity.reason;
        const failed = await recordQualityCancellationFailure(repoRoot, qualityRunId, reason, "restart_worker_liveness", liveness);
        if (!failed.recorded) return failed;
      }
    }
  }
  return { ok: true, value: { blocked } };
}

export async function reconcileQualityCancellationsOnStartup(
  repoRoot: string,
  options: { probeLiveness?: (pid: number) => ProcessLiveness } = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const probe = options.probeLiveness ?? getProcessLiveness;
  for (const qualityRunId of openCancelledQualityRuns(events.value)) {
    const parsed = parseQualityRunId(qualityRunId);
    if (!parsed.ok) return parsed;
    const open = openDraftStages(events.value, qualityRunId);
    if (!open.ok) return open;
    for (const draftId of open.value) {
      const identity = qualityWorkerIdentity(events.value, qualityRunId, draftId);
      if (!identity.ok) return { ok: false, reason: identity.reason };
      const liveness = probe(identity.value.pid);
      if (liveness !== "dead") {
        return { ok: false, reason: `quality cancellation reconciliation refused: worker ${identity.value.pid} is ${liveness}` };
      }
      const disposed = await appendEvent(repoRoot, {
        type: "quality.draft_disposed",
        task_id: parsed.taskId,
        data: {
          version: 1,
          quality_run_id: qualityRunId,
          draft_id: draftId,
          outcome: "producer_cancelled",
          eligible_for_selection: false,
          recovered_after_daemon_restart: true,
          worker_death_proven: true,
          advisory_only: true
        }
      });
      if (!disposed.ok) return disposed;
    }
    const finalized = await finalizeQualityRunCancellation(repoRoot, qualityRunId);
    if (!finalized.ok) return finalized;
    if (!finalized.value) return { ok: false, reason: `quality cancellation reconciliation left open draft state for ${qualityRunId}` };
  }
  return { ok: true };
}

function openCancelledQualityRuns(events: HivemindEvent[]): string[] {
  const requested = new Set<string>();
  const completed = new Set<string>();
  for (const event of events) {
    const id = event.data.quality_run_id;
    if (typeof id !== "string") continue;
    if (event.type === "quality.cancel_requested") requested.add(id);
    if (event.type === "quality.cancelled") completed.add(id);
  }
  return [...requested].filter((id) => !completed.has(id)).sort();
}

function qualityWorkerIdentity(
  events: HivemindEvent[],
  qualityRunId: string,
  draftId: string
): { ok: true; value: { pid: number; process_instance_id: string } } | { ok: false; reason: string } {
  const event = [...events].reverse().find((entry) =>
    entry.type === "quality.worker_process_started" &&
    entry.data.quality_run_id === qualityRunId &&
    entry.data.draft_id === draftId
  );
  if (
    event === undefined ||
    !Number.isSafeInteger(event.data.pid) ||
    Number(event.data.pid) <= 0 ||
    typeof event.data.process_instance_id !== "string" ||
    event.data.process_instance_id.trim() === ""
  ) {
    return { ok: false, reason: `quality cancellation cannot establish durable process identity for ${qualityRunId}/${draftId}` };
  }
  return { ok: true, value: { pid: Number(event.data.pid), process_instance_id: event.data.process_instance_id } };
}

async function recordQualityCancellationFailure(
  repoRoot: string,
  qualityRunId: string,
  reason: string,
  stage: string,
  liveness: ProcessLiveness = "unknown"
): Promise<{ ok: false; reason: string; recorded: boolean }> {
  const parsed = parseQualityRunId(qualityRunId);
  if (!parsed.ok) return { ...parsed, recorded: false };
  const event = await appendEvent(repoRoot, {
    type: "quality.cancel_failed",
    task_id: parsed.taskId,
    data: {
      version: 1,
      quality_run_id: qualityRunId,
      reason: `quality cancellation failed at ${stage}: ${reason}`,
      failure_stage: stage,
      worker_liveness: liveness,
      cleanup_complete: false,
      retryable: true,
      terminal: true,
      canonical_state_touched: false
    }
  });
  return event.ok
    ? { ok: false, reason: `quality cancellation failed at ${stage}: ${reason}; cancellation remains retryable`, recorded: true }
    : { ...event, recorded: false };
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
