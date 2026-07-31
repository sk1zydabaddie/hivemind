import { rm } from "node:fs/promises";
import path from "node:path";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { loadAndValidateContract } from "./contract.js";
import { releaseLease } from "./lease.js";
import { latestTaskRunState } from "./run-state.js";
import { validateRequestedTaskId } from "./task-id.js";
import { removeTaskWorktree } from "./worktree.js";

export interface TaskStopResult {
  task_id: string;
  status: "cancel_requested" | "cancelled";
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
  if (state.state === "completed" || state.state === "failed" || state.state === "cancelled") {
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
  if (state.state === "running") {
    return { ok: true, value: { task_id: taskIdValue, status: "cancel_requested" } };
  }
  const finalized = await finalizeTaskCancellation(repoRoot, taskIdValue);
  return finalized.ok ? { ok: true, value: { task_id: taskIdValue, status: "cancelled" } } : finalized;
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
  if (!hasOpenCancelRequest(events.value, taskId)) {
    return { ok: false, reason: `task cancellation refused: no durable cancel request for ${taskId}` };
  }
  const lease = await releaseLease(repoRoot, taskId);
  if (!lease.ok) return { ok: false, reason: `task cancellation cleanup failed for lease: ${lease.reason}` };
  const worktree = await removeTaskWorktree(repoRoot, taskId, { discardChanges: true });
  if (!worktree.ok) return { ok: false, reason: `task cancellation cleanup failed for worktree: ${worktree.reason}` };
  await rm(path.join(repoRoot, ".hivemind", "patches", taskId), { recursive: true, force: true });
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
