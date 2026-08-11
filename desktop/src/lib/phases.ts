import type { TaskProjection, TaskState } from "./projection";

/* The four phases a change moves through, named the way a person would describe
 * them rather than the way the pipeline implements them.
 *
 * This is a lookup table over `task.state`, which Core owns and publishes. It
 * derives no truth: every entry is a rendering of one state the daemon already
 * decided. Adding a rule here that inspects anything other than the published
 * state would make the client a second opinion, which is the one thing it must
 * never be.
 */

export const PHASES = ["Queued", "Editing", "Checked", "Ready"] as const;

export type PhaseName = (typeof PHASES)[number];

/** Where a task sits, and whether it got there cleanly. */
export type PhaseStanding =
  /** Moving through this phase right now. */
  | "working"
  /** Sitting in this phase, but not moving: waiting on a turn, or on capacity. */
  | "waiting"
  /** Stopped in this phase and a person has to look at it. */
  | "attention"
  /** Cleared every phase. */
  | "done"
  /** Stopped on purpose; it is not coming back. */
  | "stopped";

export interface TaskPhase {
  /** 0-3 while in flight, 4 once the change is on the branch. */
  reached: number;
  standing: PhaseStanding;
  /** One short line: what is true of this task right now. */
  summary: string;
}

/* One row per state Core can publish. Exhaustive by type, so a new task state
   cannot be added upstream without this table refusing to compile. */
const PHASE_TABLE: Record<TaskState, TaskPhase> = {
  planned: { reached: 0, standing: "waiting", summary: "Waiting for its turn" },
  paused: { reached: 0, standing: "waiting", summary: "Paused until there is room to run" },
  running: { reached: 1, standing: "working", summary: "Editing its files" },
  submitted: { reached: 2, standing: "working", summary: "Checking the change it made" },
  accepted: { reached: 2, standing: "working", summary: "Change looks good, running the project's checks" },
  verified: { reached: 3, standing: "done", summary: "Checks passed, ready to ship" },
  merged: { reached: 4, standing: "done", summary: "Shipped to your branch" },
  rejected: { reached: 2, standing: "attention", summary: "Its change was turned down and has to be redone" },
  blocked: { reached: 2, standing: "attention", summary: "The project's checks could not run" },
  failed: { reached: 1, standing: "attention", summary: "The agent stopped before it finished" },
  cancelled: { reached: 0, standing: "stopped", summary: "Stopped" }
};

export function taskPhase(task: TaskProjection): TaskPhase {
  const phase = PHASE_TABLE[task.state];
  /* A stalled task is still in its published phase; it just is not moving.
     Core flags this, the client only renders it. */
  if (task.stalled && phase.standing === "working") {
    return { ...phase, standing: "attention", summary: "Not responding" };
  }
  return phase;
}

/** How many of the four phases this task has actually cleared. */
export function clearedPhases(phase: TaskPhase): number {
  if (phase.standing === "done") return phase.reached;
  return Math.max(0, phase.reached - (phase.standing === "working" ? 1 : 0));
}

/* What a whole run amounts to, for the one line at the top of the Work tab.
   Counting is presentation; the states being counted are Core's. */
export interface RunStanding {
  working: number;
  waiting: number;
  attention: number;
  done: number;
  shipped: number;
  total: number;
}

export function runStanding(tasks: TaskProjection[]): RunStanding {
  const standing: RunStanding = {
    working: 0,
    waiting: 0,
    attention: 0,
    done: 0,
    shipped: 0,
    total: tasks.length
  };
  for (const task of tasks) {
    const phase = taskPhase(task);
    if (phase.standing === "working") standing.working += 1;
    else if (phase.standing === "waiting") standing.waiting += 1;
    else if (phase.standing === "attention") standing.attention += 1;
    else if (phase.standing === "done") {
      standing.done += 1;
      if (phase.reached >= 4) standing.shipped += 1;
    }
  }
  return standing;
}

/** Files currently spoken for across the run. Plain count, no vocabulary. */
export function filesInFlight(tasks: TaskProjection[]): number {
  return tasks.reduce((count, task) => count + task.lease_files.length, 0);
}
