import { rm } from "node:fs/promises";
import path from "node:path";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { loadAndValidateContract } from "./contract.js";
import { releaseLease } from "./lease.js";
import { terminateProcessTreeAndVerify, type DurableProcessIdentity } from "./process-control.js";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";
import { latestTaskRunState } from "./run-state.js";
import { validateRequestedTaskId } from "./task-id.js";
import { removeTaskWorktree } from "./worktree.js";

const cleanupRetryMs = 2_500;
const cleanupRetryIntervalMs = 50;

export interface TaskStopResult {
  task_id: string;
  status: "cancelled";
}

type ControlResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function requestTaskStop(
  repoRoot: string,
  request: unknown
): Promise<ControlResult<TaskStopResult>> {
  if (!isRecord(request)) return { ok: false, reason: "task stop request must be a JSON object" };
  const allowed = new Set(["task_id", "reason"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { ok: false, reason: `task stop request contains unsupported authority field: ${extra[0]}` };
  if (typeof request.task_id !== "string") return { ok: false, reason: "task stop task_id is required" };
  const taskId = validateRequestedTaskId(request.task_id);
  if (!taskId.ok) return taskId;
  const taskIdValue = request.task_id;
  const contract = await loadAndValidateContract(repoRoot, taskIdValue);
  if (!contract.ok) return { ok: false, reason: `task stop refused: ${contract.reason}` };
  if (typeof request.reason !== "string" || request.reason.trim() === "" || request.reason.length > 2000) {
    return { ok: false, reason: "task stop reason must be a non-empty string of at most 2000 characters" };
  }
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const state = latestTaskRunState(events.value, taskIdValue);
  if (state.state === "completed" || state.state === "cancelled" || (state.state === "failed" && state.failed.data.stop_retryable !== true)) {
    return { ok: false, reason: `task stop refused: ${taskIdValue} is already terminal (${state.state})` };
  }
  if (!hasOpenCancelRequest(events.value, taskIdValue)) {
    const requested = await appendEvent(repoRoot, {
      type: "task.cancel_requested",
      task_id: taskIdValue,
      data: { version: 1, reason: request.reason.trim(), requested_by: "human", cleanup_required: true }
    });
    if (!requested.ok) return requested;
  }
  if (state.state === "running" || (state.state === "failed" && state.failed.data.worker_death_proven !== true)) {
    const identity = await waitForWorkerIdentity(repoRoot, taskIdValue);
    if (!identity.ok) {
      return recordTaskStopFailure(repoRoot, taskIdValue, identity.reason, "worker_identity", "unknown");
    }
    const terminated = await terminateProcessTreeAndVerify(identity.value);
    if (terminated.status !== "dead") {
      return recordTaskStopFailure(repoRoot, taskIdValue, terminated.reason, "worker_termination", terminated.liveness);
    }
    const retryingAfterTeardownFailure = state.state === "failed" && state.failed.data.failure_stage === "worker_teardown";
    if (!retryingAfterTeardownFailure && !await waitForWorkerTeardown(repoRoot, taskIdValue, identity.value)) {
      return recordTaskStopFailure(
        repoRoot,
        taskIdValue,
        "worker death was proven but adapter teardown did not reach its durable stopped boundary",
        "worker_teardown",
        "dead",
        true
      );
    }
  }
  const finalized = await finalizeTaskCancellation(repoRoot, taskIdValue);
  return finalized.ok ? { ok: true, value: { task_id: taskIdValue, status: "cancelled" } } : finalized;
}

async function waitForWorkerIdentity(repoRoot: string, taskId: string): Promise<ControlResult<DurableProcessIdentity>> {
  const deadline = Date.now() + cleanupRetryMs;
  let lastReason = `task stop cannot establish durable worker process identity for ${taskId}`;
  while (Date.now() <= deadline) {
    const events = await readEvents(repoRoot);
    if (!events.ok) return events;
    const identity = workerIdentityForLatestRun(events.value, taskId);
    if (identity.ok) return identity;
    lastReason = identity.reason;
    await new Promise((resolve) => setTimeout(resolve, cleanupRetryIntervalMs));
  }
  return { ok: false, reason: lastReason };
}

export async function taskCancellationRequested(repoRoot: string, taskId: string): Promise<boolean> {
  const events = await readEvents(repoRoot);
  return events.ok && hasOpenCancelRequest(events.value, taskId);
}

export async function finalizeTaskCancellation(
  repoRoot: string,
  taskId: string
): Promise<ControlResult<void>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  if (events.value.some((event) => event.type === "task.cancelled" && event.task_id === taskId)) {
    return { ok: true, value: undefined };
  }
  if (!hasOpenCancelRequest(events.value, taskId)) {
    return { ok: false, reason: `task cancellation refused: no durable cancel request for ${taskId}` };
  }
  const worktree = await removeTaskWorktreeAfterProcessExit(repoRoot, taskId);
  if (!worktree.ok) return recordTaskStopFailure(repoRoot, taskId, worktree.reason, "worktree_cleanup", "dead", true);
  try {
    await rm(path.join(repoRoot, ".hivemind", "patches", taskId), { recursive: true, force: true });
  } catch (error: unknown) {
    return recordTaskStopFailure(repoRoot, taskId, errorMessage(error), "patch_cleanup", "dead", true);
  }
  const lease = await releaseLease(repoRoot, taskId);
  if (!lease.ok) return recordTaskStopFailure(repoRoot, taskId, lease.reason, "lease_release", "dead", true);
  const current = await readEvents(repoRoot);
  if (!current.ok) return current;
  if (current.value.some((event) => event.type === "task.cancelled" && event.task_id === taskId)) {
    return { ok: true, value: undefined };
  }
  const request = [...current.value].reverse().find((event) => event.type === "task.cancel_requested" && event.task_id === taskId);
  const appended = await appendEvent(repoRoot, {
    type: "task.cancelled",
    task_id: taskId,
    data: {
      version: 1,
      reason: typeof request?.data.reason === "string" ? request.data.reason : "human stop requested",
      lease_released: true,
      worktree_removed: true,
      patch_bundle_removed: true,
      terminal: true
    }
  });
  return appended.ok ? { ok: true, value: undefined } : appended;
}

export async function reconcileTaskCancellationOnStartup(
  repoRoot: string,
  taskId: string,
  options: { probeLiveness?: (pid: number) => ProcessLiveness } = {}
): Promise<ControlResult<void>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  if (!hasOpenCancelRequest(events.value, taskId)) return { ok: true, value: undefined };
  const state = latestTaskRunState(events.value, taskId);
  if (state.state === "not_started" || (state.state === "failed" && state.failed.data.worker_death_proven === true)) {
    return finalizeTaskCancellation(repoRoot, taskId);
  }
  const identity = workerIdentityForLatestRun(events.value, taskId);
  if (!identity.ok) {
    const failed = await recordTaskStopFailure(repoRoot, taskId, identity.reason, "restart_worker_identity", "unknown");
    return failed.recorded ? { ok: true, value: undefined } : failed;
  }
  const liveness = (options.probeLiveness ?? getProcessLiveness)(identity.value.pid);
  if (liveness !== "dead") {
    const failed = await recordTaskStopFailure(
      repoRoot,
      taskId,
      `daemon restart cannot prove worker pid ${identity.value.pid} is dead; liveness is ${liveness}`,
      "restart_worker_liveness",
      liveness
    );
    return failed.recorded ? { ok: true, value: undefined } : failed;
  }
  return finalizeTaskCancellation(repoRoot, taskId);
}

function workerIdentityForLatestRun(
  events: HivemindEvent[],
  taskId: string
): ControlResult<DurableProcessIdentity> {
  const started = [...events].reverse().find((event) => event.type === "task.started" && event.task_id === taskId);
  const runId = started?.data.run_id;
  if (typeof runId !== "string") return { ok: false, reason: `task stop cannot establish the active run identity for ${taskId}` };
  const processEvent = [...events].reverse().find((event) =>
    event.type === "task.worker_process_started" && event.task_id === taskId && event.data.run_id === runId
  );
  if (
    processEvent === undefined ||
    !Number.isSafeInteger(processEvent.data.pid) ||
    Number(processEvent.data.pid) <= 0 ||
    typeof processEvent.data.process_instance_id !== "string" ||
    processEvent.data.process_instance_id.trim() === ""
  ) {
    return { ok: false, reason: `task stop cannot establish durable worker process identity for ${taskId} run ${runId}` };
  }
  return {
    ok: true,
    value: { pid: Number(processEvent.data.pid), process_instance_id: processEvent.data.process_instance_id }
  };
}

async function recordTaskStopFailure(
  repoRoot: string,
  taskId: string,
  reason: string,
  stage: string,
  liveness: ProcessLiveness,
  workerDeathProven = false
): Promise<{ ok: false; reason: string; recorded: boolean }> {
  const event = await appendEvent(repoRoot, {
    type: "task.failed",
    task_id: taskId,
    data: {
      version: 1,
      reason: `task stop failed at ${stage}: ${reason}`,
      stop_attempt: true,
      stop_retryable: true,
      cleanup_complete: false,
      lease_released: false,
      lease_state: "held",
      worker_death_proven: workerDeathProven,
      worker_liveness: liveness,
      failure_stage: stage,
      terminal: true
    }
  });
  return event.ok
    ? { ok: false, reason: `task stop failed at ${stage}: ${reason}; lease remains held and stop is retryable`, recorded: true }
    : { ...event, recorded: false };
}

function hasOpenCancelRequest(events: HivemindEvent[], taskId: string): boolean {
  let requested = false;
  for (const event of events) {
    if (event.task_id !== taskId) continue;
    if (event.type === "task.started") requested = false;
    if (event.type === "task.cancel_requested") requested = true;
    if (event.type === "task.cancelled") requested = false;
  }
  return requested;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeTaskWorktreeAfterProcessExit(
  repoRoot: string,
  taskId: string
): Promise<Awaited<ReturnType<typeof removeTaskWorktree>>> {
  const deadline = Date.now() + cleanupRetryMs;
  let result = await attemptTaskWorktreeRemoval(repoRoot, taskId);
  while (!result.ok && Date.now() < deadline && isTransientWorktreeCleanupFailure(result.reason)) {
    await new Promise((resolve) => setTimeout(resolve, cleanupRetryIntervalMs));
    result = await attemptTaskWorktreeRemoval(repoRoot, taskId);
  }
  return result;
}

async function attemptTaskWorktreeRemoval(
  repoRoot: string,
  taskId: string
): Promise<Awaited<ReturnType<typeof removeTaskWorktree>>> {
  try {
    return await removeTaskWorktree(repoRoot, taskId, { discardChanges: true });
  } catch (error: unknown) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function isTransientWorktreeCleanupFailure(reason: string): boolean {
  return /\b(?:EBUSY|EPERM|resource busy|used by another process|access is denied)\b/iu.test(reason);
}

async function waitForWorkerTeardown(
  repoRoot: string,
  taskId: string,
  identity: DurableProcessIdentity
): Promise<boolean> {
  const deadline = Date.now() + cleanupRetryMs;
  while (Date.now() <= deadline) {
    const events = await readEvents(repoRoot);
    if (!events.ok) return false;
    if (events.value.some((event) =>
      event.type === "task.worker_process_stopped" &&
      event.task_id === taskId &&
      event.data.pid === identity.pid &&
      event.data.process_instance_id === identity.process_instance_id
    )) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, cleanupRetryIntervalMs));
  }
  return false;
}
