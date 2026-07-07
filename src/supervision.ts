import { appendEvent, type HivemindEvent } from "./events.js";

export interface RedirectCorrectionRecord {
  task_id: string;
  attempt: number;
  max_attempts: number;
  correction: string;
  reason: string;
  rejected_intent: Record<string, unknown>;
  rejection_reason: string;
}

export async function recordRedirectFirstCorrection(
  repoRoot: string,
  record: RedirectCorrectionRecord
): Promise<{ ok: true; value: { revision_requested: HivemindEvent; redirected: HivemindEvent } } | { ok: false; reason: string }> {
  const revision = await appendEvent(repoRoot, {
    type: "task.revision_requested",
    task_id: record.task_id,
    data: {
      reason: record.reason,
      rejection_reason: record.rejection_reason,
      attempt: record.attempt,
      max_attempts: record.max_attempts,
      source: "write_intent"
    }
  });
  if (!revision.ok) {
    return revision;
  }

  const redirected = await appendEvent(repoRoot, {
    type: "task.redirected",
    task_id: record.task_id,
    data: {
      correction: record.correction,
      reason: record.reason,
      rejected_intent: record.rejected_intent,
      rejection_reason: record.rejection_reason,
      attempt: record.attempt,
      max_attempts: record.max_attempts,
      source: "manager"
    }
  });
  if (!redirected.ok) {
    return redirected;
  }

  return {
    ok: true,
    value: {
      revision_requested: revision.value,
      redirected: redirected.value
    }
  };
}
