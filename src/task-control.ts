import { isRecord } from "./json.js";
import { isNodeError } from "./error-detail.js";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { loadAndValidateContract } from "./contract.js";
import { releaseLease } from "./lease.js";
import { terminateProcessTreeAndVerify, type DurableProcessIdentity } from "./process-control.js";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";
import { latestTaskRunState } from "./run-state.js";
import { validateRequestedTaskId } from "./task-id.js";
import { removeTaskWorktree } from "./worktree.js";
import { codedFailure, hasFailureCode } from "./failure-code.js";
import { isBusyErrno } from "./git-stderr.js";

const cleanupRetryMs = 2_500;
const cleanupRetryIntervalMs = 50;
const agentLogPath = "agent.log";

export interface TaskStopResult {
  task_id: string;
  status: "cancelled";
}

export interface StartupTaskReconciliationResult {
  examined: string[];
  failures: Array<{ task_id: string; reason: string }>;
}

type ControlResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function requestTaskStop(
  repoRoot: string,
  request: unknown
): Promise<ControlResult<TaskStopResult>> {
  return requestTaskStopFromSource(repoRoot, request, "human");
}

export async function requestSystemTaskStop(
  repoRoot: string,
  request: unknown
): Promise<ControlResult<TaskStopResult>> {
  return requestTaskStopFromSource(repoRoot, request, "scheduler");
}

async function requestTaskStopFromSource(
  repoRoot: string,
  request: unknown,
  requestedBy: "human" | "scheduler"
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
      data: { version: 1, reason: request.reason.trim(), requested_by: requestedBy, cleanup_required: true }
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
  const cleanup = await cleanupTaskAfterProvenWorkerDeath(repoRoot, taskId, {
    archiveAgentLog: false,
    removePatchBundle: true
  });
  if (!cleanup.ok) {
    return recordTaskStopFailure(repoRoot, taskId, cleanup.reason, cleanup.stage, "dead", true);
  }
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
      lease_released: cleanup.released,
      worktree_removed: true,
      patch_bundle_removed: true,
      terminal: true
    }
  });
  return appended.ok ? { ok: true, value: undefined } : appended;
}

export async function reconcileTaskRunOnStartup(
  repoRoot: string,
  taskId: string,
  options: { probeLiveness?: (pid: number) => ProcessLiveness } = {}
): Promise<ControlResult<void>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const interruptedResume = latestInterruptedResume(events.value, taskId);
  if (interruptedResume !== null) {
    const paused = await appendEvent(repoRoot, {
      type: "task.paused",
      task_id: taskId,
      data: {
        version: 1,
        reason: "resume_interrupted",
        source: "startup_reconciliation",
        snapshot_path: interruptedResume.data.snapshot_path,
        recovered: true,
        terminal: false
      }
    });
    return paused.ok ? { ok: true, value: undefined } : paused;
  }
  const cancellationRequested = hasOpenCancelRequest(events.value, taskId);
  const state = latestTaskRunState(events.value, taskId);
  if (cancellationRequested && (state.state === "not_started" || (state.state === "failed" && state.failed.data.worker_death_proven === true))) {
    return finalizeTaskCancellation(repoRoot, taskId);
  }
  const identity = workerIdentityForLatestRun(events.value, taskId);
  if (!identity.ok) {
    return { ok: true, value: undefined };
  }
  const liveness = (options.probeLiveness ?? getProcessLiveness)(identity.value.pid);
  if (liveness !== "dead") {
    return { ok: true, value: undefined };
  }
  return cancellationRequested
    ? finalizeTaskCancellation(repoRoot, taskId)
    : finalizeFailedTaskAfterRestart(repoRoot, taskId, identity.value);
}

export async function reconcileTaskRunsOnStartup(
  repoRoot: string,
  options: { probeLiveness?: (pid: number) => ProcessLiveness } = {}
): Promise<ControlResult<StartupTaskReconciliationResult>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const taskIds = tasksNeedingStartupReconciliation(events.value);
  const failures: Array<{ task_id: string; reason: string }> = [];
  for (const taskId of taskIds) {
    const reconciled = await reconcileTaskRunOnStartup(repoRoot, taskId, options);
    if (!reconciled.ok) failures.push({ task_id: taskId, reason: reconciled.reason });
  }
  return failures.length === 0
    ? { ok: true, value: { examined: taskIds, failures } }
    : {
        ok: false,
        reason: `startup task reconciliation failed: ${failures.map((failure) => `${failure.task_id}: ${failure.reason}`).join("; ")}`
      };
}

async function finalizeFailedTaskAfterRestart(
  repoRoot: string,
  taskId: string,
  identity: DurableProcessIdentity
): Promise<ControlResult<void>> {
  const cleanup = await cleanupTaskAfterProvenWorkerDeath(repoRoot, taskId, {
    archiveAgentLog: true,
    removePatchBundle: false
  });
  if (!cleanup.ok) {
    const failed = await recordTaskStopFailure(repoRoot, taskId, cleanup.reason, cleanup.stage, "dead", true);
    return failed.recorded ? { ok: true, value: undefined } : failed;
  }
  const appended = await appendEvent(repoRoot, {
    type: "task.failed",
    task_id: taskId,
    data: {
      version: 1,
      reason: "daemon restarted after the worker process ended without a durable completion",
      recovered: true,
      worker_death_proven: true,
      worker_liveness: "dead",
      pid: identity.pid,
      process_instance_id: identity.process_instance_id,
      lease_released: cleanup.released,
      worktree_removed: true,
      lease_held_for_retry: false,
      terminal: true
    }
  });
  return appended.ok ? { ok: true, value: undefined } : appended;
}

type CleanupFailureStage = "log_archival" | "worktree_cleanup" | "patch_cleanup" | "lease_release";

async function cleanupTaskAfterProvenWorkerDeath(
  repoRoot: string,
  taskId: string,
  options: { archiveAgentLog: boolean; removePatchBundle: boolean }
): Promise<{ ok: true; released: string[] } | { ok: false; reason: string; stage: CleanupFailureStage }> {
  if (options.archiveAgentLog) {
    const archived = await archiveAgentLog(repoRoot, taskId);
    if (!archived.ok) return { ...archived, stage: "log_archival" };
  }
  const worktree = await removeTaskWorktreeAfterProcessExit(repoRoot, taskId);
  if (!worktree.ok) return { ...worktree, stage: "worktree_cleanup" };
  if (options.removePatchBundle) {
    try {
      await rm(path.join(repoRoot, ".hivemind", "patches", taskId), { recursive: true, force: true });
    } catch (error: unknown) {
      return { ok: false, reason: errorMessage(error), stage: "patch_cleanup" };
    }
  }
  const lease = await releaseLease(repoRoot, taskId);
  return lease.ok
    ? { ok: true, released: lease.value.released }
    : { ok: false, reason: lease.reason, stage: "lease_release" };
}

async function archiveAgentLog(repoRoot: string, taskId: string): Promise<ControlResult<void>> {
  try {
    const destination = path.join(repoRoot, ".hivemind", "patches", taskId);
    await mkdir(destination, { recursive: true });
    await copyFile(
      path.join(repoRoot, ".hivemind", "worktrees", taskId, agentLogPath),
      path.join(destination, agentLogPath)
    );
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { ok: true, value: undefined }
      : { ok: false, reason: errorMessage(error) };
  }
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
  // Absent for any worker recorded before the group was written, and null on
  // Windows. Either way it is carried through as null rather than guessed at:
  // on POSIX that makes the stop refuse instead of killing one process and
  // reporting a tree termination it cannot prove.
  const recordedGroup = processEvent.data.process_group_id;
  const processGroupId = Number.isSafeInteger(recordedGroup) && Number(recordedGroup) > 0
    ? Number(recordedGroup)
    : null;
  return {
    ok: true,
    value: {
      pid: Number(processEvent.data.pid),
      process_instance_id: processEvent.data.process_instance_id,
      process_group_id: processGroupId
    }
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

function tasksNeedingStartupReconciliation(events: HivemindEvent[]): string[] {
  const tasks = new Set(startedWithoutTerminal(events));
  const openCancellation = new Set<string>();
  const eventTaskIds = new Set<string>();
  for (const event of events) {
    if (event.task_id === null) continue;
    eventTaskIds.add(event.task_id);
    if (event.type === "task.started") openCancellation.delete(event.task_id);
    if (event.type === "task.cancel_requested") openCancellation.add(event.task_id);
    if (event.type === "task.cancelled") openCancellation.delete(event.task_id);
  }
  for (const taskId of eventTaskIds) {
    if (latestInterruptedResume(events, taskId) !== null) tasks.add(taskId);
  }
  for (const taskId of openCancellation) tasks.add(taskId);
  return [...tasks].sort((left, right) => left.localeCompare(right));
}

function latestInterruptedResume(events: HivemindEvent[], taskId: string): HivemindEvent | null {
  let resume: HivemindEvent | null = null;
  for (const event of events) {
    if (event.task_id !== taskId) continue;
    if (event.type === "task.resumed") resume = event;
    if (
      resume !== null &&
      ["task.started", "task.completed", "task.failed", "task.cancelled", "task.paused"].includes(event.type)
    ) resume = null;
  }
  return resume;
}

function startedWithoutTerminal(events: HivemindEvent[]): string[] {
  const running = new Set<string>();
  for (const event of events) {
    if (event.task_id === null) continue;
    if (event.type === "task.started") {
      running.add(event.task_id);
      continue;
    }
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled") {
      running.delete(event.task_id);
      continue;
    }
    if (event.type === "task.paused" && event.data.reason === "quota_exhausted") running.delete(event.task_id);
  }
  return [...running].sort((left, right) => left.localeCompare(right));
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
  // Retry only what the removal itself reported as still-held. This used to
  // regex EBUSY/EPERM back out of a rendered sentence -- the typed errno
  // existed upstream, was flattened by error.message, and was reconstructed
  // here to decide whether a lease could be released.
  while (!result.ok && Date.now() < deadline && hasFailureCode(result, "worktree_busy")) {
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
    // A throw that escaped the removal still carries its errno. Read it as a
    // value rather than rendering it and re-reading the rendering.
    return isBusyErrno(error)
      ? codedFailure("worktree_busy", errorMessage(error))
      : { ok: false, reason: errorMessage(error) };
  }
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
