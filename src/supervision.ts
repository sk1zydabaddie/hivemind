import { loadConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { validateRequestedTaskId } from "./task-id.js";

export interface RedirectRequest {
  task_id: string;
  correction: string;
  source: "manager" | "human";
}

export interface RedirectResult {
  task_id: string;
  attempt: number;
  max_attempts: number;
  revision_requested: HivemindEvent;
  redirected: HivemindEvent;
}

export async function requestTaskRedirect(
  repoRoot: string,
  request: unknown
): Promise<{ ok: true; value: RedirectResult } | { ok: false; reason: string }> {
  if (!isRecord(request)) return { ok: false, reason: "redirect request must be a JSON object" };
  const allowed = new Set(["task_id", "correction", "source"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { ok: false, reason: `redirect request contains unsupported authority field: ${extra[0]}` };
  if (typeof request.task_id !== "string") return { ok: false, reason: "redirect task_id is required" };
  const taskId = validateRequestedTaskId(request.task_id);
  if (!taskId.ok) return taskId;
  const taskIdValue = request.task_id;
  const contract = await loadAndValidateContract(repoRoot, taskIdValue);
  if (!contract.ok) return { ok: false, reason: `redirect refused: ${contract.reason}` };
  if (request.source !== "manager" && request.source !== "human") return { ok: false, reason: "redirect source must be manager or human" };
  if (typeof request.correction !== "string" || request.correction.trim() === "" || request.correction.length > 20_000) {
    return { ok: false, reason: "redirect correction must be a non-empty string of at most 20000 characters" };
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) return config;
  const maxAttempts = config.config.manager_autonomy?.redirect_limit ?? 2;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const taskEvents = events.value.filter((event) => event.task_id === taskIdValue);
  const latestRejectedIndex = lastEventIndex(taskEvents, "write_intent.rejected");
  const latestRedirectIndex = lastEventIndex(taskEvents, "task.redirected");
  if (latestRejectedIndex < 0 || latestRedirectIndex > latestRejectedIndex) {
    return { ok: false, reason: `redirect refused: ${taskIdValue} has no unhandled rejected write-intent` };
  }
  const latestBoundary = [...taskEvents].reverse().find((event) =>
    event.type === "write_intent.rejected" ||
    event.type === "write_intent.approved" ||
    event.type === "task.completed" ||
    event.type === "task.failed" ||
    event.type === "task.cancelled"
  );
  if (latestBoundary?.type !== "write_intent.rejected") {
    return { ok: false, reason: `redirect refused: ${taskIdValue} is not paused at a current rejected write-intent boundary` };
  }
  const redirectsAfterStart = countRedirectsAfterLatestStart(taskEvents);
  if (redirectsAfterStart >= maxAttempts) {
    return { ok: false, reason: `redirect limit exhausted for ${taskIdValue} (${redirectsAfterStart}/${maxAttempts}); re-plan instead of redirecting again` };
  }
  const rejectionReason = typeof latestBoundary.data.reason === "string" ? latestBoundary.data.reason : null;
  if (rejectionReason === null) {
    return { ok: false, reason: "redirect refused: durable write-intent rejection has no usable reason" };
  }
  const rejectedIntent = {
    intended_files: arrayOfStrings(latestBoundary.data.intended_files),
    intended_symbols: arrayOfStrings(latestBoundary.data.intended_symbols),
    possible_risks: arrayOfStrings(latestBoundary.data.possible_risks),
    will_not_change: arrayOfStrings(latestBoundary.data.will_not_change)
  };
  if (rejectedIntent.intended_files === null) {
    return { ok: false, reason: "redirect refused: durable write-intent rejection is malformed" };
  }
  const attempt = redirectsAfterStart + 1;
  const revision = await appendEvent(repoRoot, {
    type: "task.revision_requested",
    task_id: taskIdValue,
    data: {
      reason: "write-intent drift corrected before worker edit",
      rejection_reason: rejectionReason,
      attempt,
      max_attempts: maxAttempts,
      source: request.source === "human" ? "human_redirect" : "write_intent"
    }
  });
  if (!revision.ok) return revision;
  const redirected = await appendEvent(repoRoot, {
    type: "task.redirected",
    task_id: taskIdValue,
    data: {
      correction: request.correction.trim(),
      reason: "write-intent drift corrected before worker edit",
      rejected_intent: rejectedIntent,
      rejection_reason: rejectionReason,
      attempt,
      max_attempts: maxAttempts,
      source: request.source
    }
  });
  return redirected.ok
    ? { ok: true, value: { task_id: taskIdValue, attempt, max_attempts: maxAttempts, revision_requested: revision.value, redirected: redirected.value } }
    : redirected;
}

function countRedirectsAfterLatestStart(events: HivemindEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "task.started") count = 0;
    if (event.type === "task.redirected") count += 1;
  }
  return count;
}

function lastEventIndex(events: HivemindEvent[], type: HivemindEvent["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
