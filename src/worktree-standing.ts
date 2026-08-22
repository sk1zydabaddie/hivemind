import { readdir } from "node:fs/promises";
import path from "node:path";

import { readEvents } from "./events.js";
import { latestTaskRunState } from "./run-state.js";
import { loadRatifiedPlanByIdentity } from "./plan.js";
import { removeTaskWorktree } from "./worktree.js";

/**
 * Removes the worktrees of read-only plan tasks that finished clean.
 *
 * The one leftover class the startup reconcilers did not cover: a read-only
 * task completes with zero changed files, adoption verifies it without
 * adopting it (there is nothing to adopt), and nothing ever removed its
 * worktree -- so the project could never prove itself idle again (A-37). The
 * idleness proof itself now disregards leftovers (the shell's `daemon_work`
 * counts only work something alive can still finish); this is the half that
 * cleans them up, run at daemon startup and at adoption completion.
 *
 * Deliberately NOT a daemon-served answer to "is work in flight": the shell
 * must judge idleness for daemons of any build, including ones older than any
 * route added today, so that accounting reads durable records directly (see
 * `daemon_work` in the shell and the recorded reason in
 * desktop/test/identity.test.ts -- "read off disk, not asked of the daemon").
 *
 * Grounded in the ratified plan rather than guessed from the diff: only a
 * task the plan itself declares `read_only`, whose durable completion
 * recorded zero changed files, is removed. A write task's worktree is never
 * touched here -- its branch carries the work adoption still needs, and its
 * cleanup belongs to adoption alone.
 */
export async function reconcileLeftoverWorktrees(
  repoRoot: string
): Promise<{ ok: true; value: { removed: string[] } } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const ratification = [...events.value].reverse().find((event) => event.type === "plan.ratified");
  if (ratification === undefined) return { ok: true, value: { removed: [] } };
  const specId = ratification.data.spec_id;
  if (typeof specId !== "string") return { ok: true, value: { removed: [] } };
  const plan = await loadRatifiedPlanByIdentity(
    repoRoot,
    specId,
    ratification.data.plan_path,
    ratification.data.plan_hash,
    "leftover worktree reconciliation"
  );
  /* No loadable plan means no proof any worktree is a finished read-only
     task's. Removing nothing is the direction that cannot destroy work. */
  if (!plan.ok) return { ok: true, value: { removed: [] } };

  const worktrees = await listWorktreeDirectories(repoRoot);
  if (!worktrees.ok) return worktrees;
  const present = new Set(worktrees.value);

  const removed: string[] = [];
  for (const task of plan.value.tasks) {
    if (task.mode !== "read_only" || !present.has(task.task_id)) continue;
    const state = latestTaskRunState(events.value, task.task_id);
    if (state.state !== "completed" || state.completed.data.changed_files !== 0) continue;
    const removal = await removeTaskWorktree(repoRoot, task.task_id, { discardChanges: true });
    if (!removal.ok) {
      return { ok: false, reason: `could not remove finished read-only worktree ${task.task_id}: ${removal.reason}` };
    }
    removed.push(task.task_id);
  }
  return { ok: true, value: { removed } };
}

async function listWorktreeDirectories(
  repoRoot: string
): Promise<{ ok: true; value: string[] } | { ok: false; reason: string }> {
  const dir = path.join(repoRoot, ".hivemind", "worktrees");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return { ok: true, value: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name) };
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ok: true, value: [] };
    }
    return { ok: false, reason: `could not list task worktrees: ${String(error)}` };
  }
}
