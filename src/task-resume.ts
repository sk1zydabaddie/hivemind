import { readEvents } from "./events.js";
import { loadAndValidateContract } from "./contract.js";
import { readActiveLeases } from "./lease.js";
import { loadCurrentRatifiedPlan } from "./plan.js";
import { runTask } from "./run.js";
import { requireActiveSpecRatified, type SpecResult } from "./spec.js";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Continuing a run that stopped, without planning it again.
 *
 * A quota pause loses nothing. The contract, the lease and the worktree all
 * survive it, and the work is one worker call from continuing — but the product
 * offered no way to say so, and the only route forward was a new prompt, which
 * throws away a plan the person already approved and pays for planning twice.
 *
 * What this is not allowed to do is the whole design of it. Resuming must not
 * skip a gate a fresh run would apply, must not reuse a lease another task now
 * holds, and must not resume onto a plan that has changed. Verified-then-stale
 * is refused everywhere else here; this is the same rule for paused-then-stale.
 * Every check below fails closed with a sentence a person can act on.
 */

export interface TaskResumeResult {
  task_id: string;
  resumed_from: "paused";
}

export async function resumeTask(
  repoRoot: string,
  taskId: string
): Promise<SpecResult<TaskResumeResult>> {
  /* Every gate a fresh run applies, applied again. A pause is not a licence to
     start work the current state would refuse. */
  const spec = await requireActiveSpecRatified(repoRoot);
  if (!spec.ok) return spec;

  const events = await readEvents(repoRoot);
  if (!events.ok) return { ok: false, reason: events.reason };

  /* `latestTaskRunState` does not model a pause, so the pause is read from the
     trail: the newest lifecycle event for this task must be `task.paused`. */
  const lifecycle = new Set([
    "task.started", "task.resumed", "task.paused", "task.completed",
    "task.failed", "task.blocked", "task.cancelled"
  ]);
  let newest: string | null = null;
  for (const event of events.value) {
    if (event.task_id === taskId && lifecycle.has(event.type)) newest = event.type;
  }
  if (newest !== "task.paused") {
    return {
      ok: false,
      reason: `This task is not waiting for capacity, so there is nothing to pick up${newest === null ? "" : ` (it is ${newest.replace("task.", "")})`}.`
    };
  }

  const contract = await loadAndValidateContract(repoRoot, taskId);
  if (!contract.ok) {
    return { ok: false, reason: `This task's contract can no longer be read: ${contract.reason}` };
  }

  /* The plan must still be the one that was approved. Resuming onto a changed
     plan would run work nobody ratified. */
  const plan = await loadCurrentRatifiedPlan(repoRoot, spec.value.spec_id);
  if (!plan.ok) {
    return { ok: false, reason: "The approved plan is no longer readable. Review the plan again." };
  }
  const planned = plan.value.tasks.find((task) => task.task_id === taskId);
  if (planned === undefined) {
    return {
      ok: false,
      reason: "This task is not in the approved plan any more. Review the plan again before continuing."
    };
  }

  /* The lease has to still be this task's. If another task now holds one of
     these files, continuing would put two writers on the same file. */
  const leases = await readActiveLeases(repoRoot);
  if (!leases.ok) return { ok: false, reason: String((leases as { reason?: string }).reason ?? "lease store unreadable") };
  const held = Object.entries(leases.store).filter(([, owner]) => owner === taskId);
  if (held.length === 0) {
    return {
      ok: false,
      reason: "This task no longer holds its files, so it cannot pick up where it left off. Start it again from the plan."
    };
  }
  const takenByOthers = contract.contract.allowed_files.filter(
    (file) => leases.store[file] !== undefined && leases.store[file] !== taskId
  );
  if (takenByOthers.length > 0) {
    return {
      ok: false,
      reason: `Another task is now editing ${takenByOthers.join(", ")}, so this one cannot continue. Start it again from the plan.`
    };
  }

  /* And the workspace it was editing has to still be there. */
  const worktree = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  try {
    const entry = await stat(worktree);
    if (!entry.isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ok: false,
      reason: "The workspace this task was editing is gone, so its unfinished work cannot be recovered. Start it again from the plan."
    };
  }

  const run = await runTask(repoRoot, taskId);
  if (!run.ok) return { ok: false, reason: run.reason };
  return { ok: true, value: { task_id: taskId, resumed_from: "paused" } };
}
