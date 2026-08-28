/**
 * Rounds that opened and never closed, and whether anything is still doing them.
 *
 * ## The shape this exists for
 *
 * An artefact outliving its owner with nothing asking. A worker is killed
 * mid-call and `spec.draft_started` never gets its terminal event, so the
 * surface renders a live round forever -- "Planner is reading your request,
 * 5m 20s elapsed" was observed still counting minutes after the process that
 * started it was gone. Reopening the app does not help: the trail is replayed
 * faithfully, and the trail says a round started.
 *
 * It is the same shape as a reservation whose process died and as daemon work
 * whose owner is gone. So the question is asked once, here, for EVERY
 * started-with-no-terminal pair in the vocabulary rather than for the one that
 * was reported -- which is the difference between fixing a class and fixing an
 * instance.
 *
 * ## Why it reports rather than repairs
 *
 * It writes nothing. A fabricated terminal event would claim an outcome nobody
 * observed: "this draft failed" is a different statement from "nothing has
 * reported on this draft since it started", and only the second one is known.
 * The trail stays the record of what happened; this is a reading of it.
 *
 * ## What makes a round stale
 *
 * Two signals, strongest first.
 *
 *  - The process that opened it is provably gone. Rounds record the identity of
 *    the process that started them; a dead pid is proof, and it is available
 *    immediately rather than after a wait.
 *  - Otherwise, age past a bound. This is weaker on purpose and says so: a
 *    round past the bound is reported as no longer reporting, never as failed.
 *    A long call and an abandoned one look identical from outside, and the
 *    honest rendering of that is doubt rather than a confident clock.
 */

export type ProcessLivenessProbe = (pid: number) => "alive" | "dead" | "unknown";

export interface RoundEvent {
  ts: string;
  type: string;
  task_id: string | null;
  data: Record<string, unknown>;
}

/**
 * How long a round may go unreported before the surface stops counting with
 * confidence.
 *
 * Twenty minutes is above any single provider call this project has measured
 * (the longest observed worker call was ~4 minutes wall clock, and a manager
 * judgment turn is seconds), and below the point where a person watching a
 * clock would still believe it. It is deliberately not tuned per round type:
 * one bound that is obviously generous beats several that each look arbitrary.
 */
export const ROUND_SILENCE_BOUND_MS = 20 * 60 * 1000;

interface RoundShape {
  /** The event that opens the round. */
  started: string;
  /** Every event that closes it. */
  terminal: readonly string[];
  /** What identifies this round within its type, beyond `task_id`. */
  idFields: readonly string[];
  /** What the round is, for a sentence a person reads. */
  what: string;
}

/**
 * The vocabulary, in one place.
 *
 * Adding a `_started` event type without adding it here means its orphans go
 * unnoticed, which is exactly how the reported one survived. The pairing test
 * enumerates the event catalogue and fails on any started-shaped type missing
 * from this table, so the omission cannot be silent.
 */
export const ROUND_SHAPES: readonly RoundShape[] = [
  {
    started: "spec.draft_started",
    terminal: ["spec.draft_completed", "spec.draft_failed"],
    idFields: ["spec_id"],
    what: "drafting"
  },
  {
    started: "task.started",
    terminal: ["task.completed", "task.failed", "task.cancelled", "task.blocked", "task.paused"],
    idFields: [],
    what: "a worker"
  },
  {
    started: "task.scouting_started",
    terminal: ["scout.completed", "task.failed", "task.cancelled"],
    idFields: [],
    what: "scouting"
  },
  {
    started: "task.worker_process_started",
    terminal: ["task.worker_process_stopped"],
    idFields: [],
    what: "a worker process"
  },
  {
    started: "integration.started",
    terminal: ["integration.passed", "integration.failed", "integration.blocked", "integration.low_confidence"],
    idFields: [],
    what: "integration"
  },
  {
    started: "adoption.started",
    terminal: ["adoption.completed", "adoption.failed", "adoption.indeterminate"],
    idFields: [],
    what: "adopting the change"
  },
  {
    started: "quality.draft_started",
    terminal: ["quality.draft_disposed"],
    idFields: ["quality_run_id", "draft_id"],
    what: "a draft run"
  },
  {
    started: "scheduler.wave_started",
    terminal: ["scheduler.wave_completed", "scheduler.wave_settled", "scheduler.wave_stopped", "scheduler.run_cancelled"],
    idFields: ["wave_id"],
    what: "a wave of work"
  },
  /* Found by the coverage test above on its first run, which is the point of
     having it: a rerun opens a round like any other and nothing was asking. */
  {
    started: "verification.rerun_started",
    terminal: ["verification.rerun_completed", "verification.completed"],
    idFields: [],
    what: "re-running the checks"
  },
  {
    started: "quality.worker_process_started",
    terminal: ["task.worker_process_stopped", "quality.cancelled"],
    idFields: [],
    what: "a draft worker process"
  },
  {
    started: "manager.run_started",
    terminal: ["manager.run_completed", "manager.run_failed", "scheduler.run_cancelled"],
    idFields: ["session_id"],
    what: "a manager run"
  },
  {
    started: "manager.worker_process_started",
    terminal: ["manager.worker_process_stopped"],
    idFields: ["call_id"],
    what: "a manager process"
  }
];

export type RoundStanding =
  /** Opened recently, and nothing says its owner is gone. */
  | { standing: "running" }
  /** The process that opened it is provably absent. */
  | { standing: "abandoned"; because: string }
  /** Nothing has reported on it for longer than the bound. */
  | { standing: "silent"; because: string };

export interface OpenRound {
  /** The `_started` event type. */
  type: string;
  what: string;
  /** Spec id, task id, or whatever identifies it. Null when nothing does. */
  id: string | null;
  taskId: string | null;
  startedAt: string;
  ageMs: number;
  liveness: RoundStanding;
}

function roundIdentity(shape: RoundShape, event: RoundEvent): string[] {
  return shape.idFields.map((field) => typeof event.data[field] === "string" ? event.data[field] as string : "");
}

function roundKey(shape: RoundShape, event: RoundEvent): string {
  return `${shape.started}:${event.task_id ?? ""}:${roundIdentity(shape, event).join(":")}`;
}

function terminalKey(shape: RoundShape, event: RoundEvent): string {
  return roundKey(shape, event);
}

/** The pid recorded on the round, when one was. */
function recordedPid(data: Record<string, unknown>): number | null {
  const identity = data.process_identity;
  if (typeof identity === "object" && identity !== null && "pid" in identity) {
    const pid = (identity as { pid?: unknown }).pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  }
  const direct = data.pid;
  return typeof direct === "number" && Number.isInteger(direct) && direct > 0 ? direct : null;
}

/**
 * Every round that opened and has no terminal event, with what is known about
 * whether anything is still doing it.
 *
 * `now` and the liveness probe are supplied so this is a pure function of its
 * inputs -- a reconciler that reads the wall clock cannot be tested for the
 * boundary it exists to enforce.
 */
export function openRounds(
  events: readonly RoundEvent[],
  options: { now: number; probeLiveness?: ProcessLivenessProbe; boundMs?: number } = { now: Date.now() }
): OpenRound[] {
  const bound = options.boundMs ?? ROUND_SILENCE_BOUND_MS;
  const probe = options.probeLiveness;
  const open = new Map<string, { shape: RoundShape; event: RoundEvent }>();

  for (const event of events) {
    for (const shape of ROUND_SHAPES) {
      if (event.type === shape.started) {
        /* A second start for the same key replaces the first: the round was
           reopened, and the older one is superseded rather than doubly open. */
        open.set(roundKey(shape, event), { shape, event });
      } else if (shape.terminal.includes(event.type)) {
        if (shape.started === "scheduler.wave_started" && event.type === "scheduler.run_cancelled") {
          for (const [key, candidate] of open) {
            if (
              candidate.shape.started === shape.started &&
              candidate.event.data.session_id === event.data.session_id
            ) open.delete(key);
          }
        } else {
          open.delete(terminalKey(shape, event));
        }
      }
    }
  }

  const rounds: OpenRound[] = [];
  for (const { shape, event } of open.values()) {
    const startedMs = Date.parse(event.ts);
    const ageMs = Number.isFinite(startedMs) ? Math.max(0, options.now - startedMs) : 0;
    const pid = recordedPid(event.data);
    const observed = pid !== null && probe !== undefined ? probe(pid) : "unknown";

    const liveness: RoundStanding =
      observed === "dead"
        ? {
            standing: "abandoned",
            because: `the process that started it (pid ${pid}) is no longer running`
          }
        : ageMs > bound
          ? {
              standing: "silent",
              because: `nothing has reported on it for ${Math.round(ageMs / 60000)} minutes`
            }
          : { standing: "running" };

    rounds.push({
      type: shape.started,
      what: shape.what,
      id: roundIdentity(shape, event).filter((part) => part !== "").join("/") || event.task_id,
      taskId: event.task_id,
      startedAt: event.ts,
      ageMs,
      liveness
    });
  }
  return rounds.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

/** Whether a round should still be drawn as work in progress. */
export function roundIsReporting(round: OpenRound): boolean {
  return round.liveness.standing === "running";
}
