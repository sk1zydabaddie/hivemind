import type { WorkspaceHistoryRun } from "./workspace-actions";

/* What this project has actually accumulated.
 *
 * Every field is a sum over `history.runs`, which Core builds from the durable
 * trail. Nothing here is estimated, extrapolated or remembered in React, and
 * there is deliberately no streak, no score and no "time saved".
 *
 * Time saved is the one that would feel best and it is not derivable: it needs
 * how long a person WOULD have taken, which nothing in the trail knows and
 * nothing could. `absent` names the numbers a person might reasonably expect
 * and the reason each is missing, so the surface can say what it does not know
 * instead of inventing a satisfying version of it.
 */

export interface ProjectTotals {
  /** Runs that put at least one task on the branch. */
  runsShipped: number;
  /** Every run recorded, shipped or not. */
  runsRecorded: number;
  /** Tasks that reached the branch, summed across runs. */
  tasksShipped: number;
  /** Tasks whose checks passed, summed across runs. Never fewer than shipped. */
  tasksChecked: number;
  /** Wall time those runs spent working, summed. */
  workingMs: number;
  /** Model calls and tokens, from the same ledger the spend meter reads. */
  calls: number;
  effectiveTokens: number;
  /** The most recent run that shipped something, for "last shipped". */
  lastShippedAt: string | null;
  /** Numbers a person might look for that this project's record cannot answer. */
  absent: string[];
}

export function projectTotals(runs: WorkspaceHistoryRun[]): ProjectTotals {
  const shipped = runs.filter((run) => run.merged_tasks.length > 0);
  const lastShippedAt = shipped
    .map((run) => run.last_activity_at)
    .sort()
    .at(-1) ?? null;

  return {
    runsShipped: shipped.length,
    runsRecorded: runs.length,
    tasksShipped: sum(runs, (run) => run.merged_tasks.length),
    tasksChecked: sum(runs, (run) => run.verified_tasks.length),
    workingMs: sum(runs, (run) => run.duration_ms),
    calls: sum(runs, (run) => run.calls),
    effectiveTokens: sum(runs, (run) => run.effective_tokens),
    lastShippedAt,
    absent: absentTotals(runs)
  };
}

/**
 * What is missing, and why.
 *
 * Said out loud rather than left as a gap, because the gap is the interesting
 * part: a person looking at "12 tasks shipped" will wonder how many files that
 * touched, and the honest answer is that the run record does not carry it.
 */
function absentTotals(runs: WorkspaceHistoryRun[]): string[] {
  const missing: string[] = [];
  if (runs.length > 0) {
    /* `adoption.completed` carries `changed_files` and the per-run history
       summary does not, so the count exists in the trail but not in anything
       totalled here. Reading it would mean replaying every run's events. */
    missing.push("how many files all of this changed");
    /* Needs a counterfactual — how long a person would have taken — which is
       not a fact about anything and never will be in the record. */
    missing.push("how much time it saved you");
  }
  return missing;
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
