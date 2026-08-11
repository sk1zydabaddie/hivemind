import type { HivemindEvent } from "./projection";

/* The run thread is a plain-language narrative of what the project did, built
 * only from durable daemon events so it survives a reload. It is deliberately
 * NOT a model transcript: the orchestrator is silent on a clean run, because the
 * mechanical pipeline is deterministic code rather than model calls.
 *
 * Everything here is presentation of events the daemon already emitted. Nothing
 * in this file decides truth.
 */

export type ThreadTone = "neutral" | "live" | "good" | "warning" | "danger";

export interface ThreadRequest {
  kind: "request";
  id: string;
  at: string;
  /* Populated once Core records the request text on `plan.prepared`; today the
     event carries only `prompt_hash`, so this entry stays hidden. */
  text: string;
}

export interface ThreadGuidance {
  kind: "guidance";
  id: string;
  at: string;
  text: string;
  applied: boolean;
}

export interface ThreadPlan {
  kind: "plan";
  id: string;
  at: string;
  specId: string | null;
  planHash: string | null;
  approved: boolean;
}

export interface ThreadMilestone {
  kind: "milestone";
  id: string;
  at: string;
  text: string;
  tone: ThreadTone;
  count: number;
  /** The task this describes, so identical wording never merges two of them. */
  taskId: string | null;
  /** Time between this task's last start and this event, when both are durable. */
  durationMs: number | null;
}

export interface ThreadShipped {
  kind: "shipped";
  id: string;
  at: string;
  taskIds: string[];
  /* `null` when `adoption.completed` did not record the field at all, which is
     a different fact from a change that touched no files. Collapsing the two
     is how the shipped card came to read "0 files changed" over a commit that
     changed eight. */
  changedFiles: string[] | null;
  branch: string | null;
  adoptedRef: string | null;
}

export type ThreadEntry =
  | ThreadRequest
  | ThreadGuidance
  | ThreadPlan
  | ThreadMilestone
  | ThreadShipped;

/* Events a person would recognise as something happening to their work. */
const TASK_MILESTONES: Record<string, { text: string; tone: ThreadTone }> = {
  "task.started": { text: "started working", tone: "live" },
  "task.completed": { text: "finished its work", tone: "neutral" },
  "task.failed": { text: "stopped unexpectedly", tone: "danger" },
  "task.paused": { text: "paused for capacity", tone: "warning" },
  "task.blocked": { text: "needs help before it can continue", tone: "danger" },
  "task.cancelled": { text: "was stopped", tone: "neutral" },
  "task.resumed": { text: "picked up where it left off", tone: "live" },
  "task.redirected": { text: "received your guidance", tone: "live" },
  "patch.rejected": { text: "has to revise its change", tone: "warning" }
};

const RUN_MILESTONES: Record<string, { text: string; tone: ThreadTone }> = {
  "integration.passed": {
    text: "Everything passed the project checks and is ready to ship",
    tone: "good"
  },
  "integration.failed": { text: "The project checks failed", tone: "danger" },
  "integration.blocked": { text: "The project checks are blocked", tone: "danger" },
  "integration.low_confidence": {
    text: "A change has thin test coverage",
    tone: "warning"
  },
  "plan.amendment_queued": {
    text: "A plan change was queued for review",
    tone: "neutral"
  },
  "quota.low": { text: "The model provider is running low on capacity", tone: "warning" },
  "quota.exhausted": { text: "The model provider is out of capacity", tone: "danger" },
  "context.low": { text: "An agent is running out of room to work", tone: "warning" },
  /* adoption.started is suppressed as mechanical, but its outcomes are not: the
     thread previously said "merging" and then went quiet whichever way it went. */
  "adoption.failed": { text: "The merge did not happen and your branch is unchanged", tone: "danger" },
  "adoption.indeterminate": {
    text: "We cannot tell whether this landed on your branch — check it by hand",
    tone: "danger"
  },
  "verification.rerun_failed": { text: "The re-check did not complete", tone: "danger" }
};

/* Mechanical steps a person never asked to see. The pipeline these describe is
   deterministic code, so their only readers are the detail surfaces. */
const SUPPRESSED = new Set([
  "task.created",
  "task.assigned",
  "task.scouting_started",
  "task.revision_requested",
  "scout.completed",
  "lease.approved",
  "lease.released",
  "lease.rejected",
  "patch.submitted",
  "patch.accepted",
  "integration.queued",
  "integration.started",
  "routing.observed",
  "orchestrator.checkpointed",
  "orchestrator.resumed",
  "human.guidance_consumed",
  "adoption.started",
  "verification.completed"
]);

/* A task the projection cannot name is still a specific task. Naming it by its
   identifier keeps two failing tasks apart; "A task" does not. */
export function taskLabel(taskId: string, taskTitles: Record<string, string>): string {
  const title = taskTitles[taskId];
  return title === undefined || title.trim() === "" || title === taskId ? taskId : title;
}

const STARTED_TYPES = new Set(["task.started", "task.resumed", "task.run_accepted"]);
const FINISHED_TYPES = new Set([
  "task.completed",
  "task.failed",
  "task.blocked",
  "task.cancelled"
]);

/** Wall time the trail covers, first durable event to last. */
/**
 * How long THIS RUN has been going, from the trail's own timestamps.
 *
 * This used to measure the whole replayed buffer, first event to last. The
 * buffer is not a run: the textkit trail opens with an `autonomy.level_changed`
 * twenty-six minutes before anybody typed anything, so a six-minute run
 * reported "took 30m 43s" and its mid-run cut reported "took 26m 27s" — a
 * number made almost entirely of the time somebody spent in settings.
 *
 * The run starts where its story starts: the newest `plan.prepared`, which is
 * the event carrying the request the thread leads with. A trail with no plan
 * has no run boundary to find, so it keeps the whole window rather than
 * inventing one.
 *
 * It ends at the newest event, so a live run reports elapsed-as-of-the-last-
 * thing-that-happened. That moves when the trail moves and at no other time,
 * which is the same rule the rest of this file follows — a ticking clock would
 * be ambient motion and client-held state.
 */
export function runSpanMs(events: HivemindEvent[]): number | null {
  if (events.length === 0) return null;
  const stamps = events
    .map((event) => Date.parse(event.ts))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (stamps.length < 2) return null;

  const startedAt = events
    .filter((event) => event.type === "plan.prepared")
    .map((event) => Date.parse(event.ts))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)
    .at(-1);

  const latest = stamps[stamps.length - 1]!;
  const from = startedAt !== undefined && startedAt <= latest ? startedAt : stamps[0]!;
  const span = latest - from;
  /* Sub-second spans are an artefact of a trail written in one burst, not a
     measurement worth showing. */
  return span >= 1000 ? span : null;
}

export function buildRunThread(
  eventsNewestFirst: HivemindEvent[],
  taskTitles: Record<string, string>
): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const appliedGuidance = new Set<string>();
  const startedAt = new Map<string, string>();

  for (const event of eventsNewestFirst) {
    if (event.type !== "human.guidance_consumed") continue;
    for (const id of readStringArray(event.data.guidance_ids) ?? []) {
      appliedGuidance.add(id);
    }
  }

  const ordered = [...eventsNewestFirst].reverse();
  for (const [index, event] of ordered.entries()) {
    if (SUPPRESSED.has(event.type) || event.type.startsWith("quality.")) continue;
    const id = `${event.ts}-${event.type}-${index}`;

    if (event.type === "plan.prepared") {
      const text = readString(event.data.prompt);
      if (text !== null) {
        entries.push({ kind: "request", id: `${id}-ask`, at: event.ts, text });
      }
      entries.push({
        kind: "plan",
        id,
        at: event.ts,
        specId: readString(event.data.spec_id),
        planHash: readString(event.data.plan_hash),
        approved: false
      });
      continue;
    }

    if (event.type === "plan.ratified") {
      const planHash = readString(event.data.plan_hash);
      const target = [...entries]
        .reverse()
        .find(
          (entry): entry is ThreadPlan =>
            entry.kind === "plan" && (planHash === null || entry.planHash === planHash)
        );
      if (target) {
        target.approved = true;
      } else {
        entries.push({
          kind: "plan",
          id,
          at: event.ts,
          specId: readString(event.data.spec_id),
          planHash,
          approved: true
        });
      }
      continue;
    }

    if (event.type === "human.guidance_recorded") {
      const text = readString(event.data.message);
      const guidanceId = readString(event.data.guidance_id);
      if (text === null) continue;
      entries.push({
        kind: "guidance",
        id: guidanceId ?? id,
        at: event.ts,
        text,
        applied: guidanceId !== null && appliedGuidance.has(guidanceId)
      });
      continue;
    }

    if (event.type === "adoption.completed") {
      entries.push({
        kind: "shipped",
        id,
        at: event.ts,
        taskIds: readStringArray(event.data.task_ids) ?? [],
        /* Deliberately NOT `?? []`. Absent and empty are different facts, and
           the older trails in docs/evidence genuinely lack this field. */
        changedFiles: readStringArray(event.data.changed_files),
        branch: readString(event.data.base_branch),
        adoptedRef: readString(event.data.adopted_ref)
      });
      continue;
    }

    if (event.task_id !== null && STARTED_TYPES.has(event.type)) {
      startedAt.set(event.task_id, event.ts);
    }

    const runMilestone = RUN_MILESTONES[event.type];
    if (runMilestone) {
      pushMilestone(entries, {
        kind: "milestone",
        id,
        at: event.ts,
        count: 1,
        taskId: null,
        durationMs: null,
        ...runMilestone
      });
      continue;
    }

    const taskMilestone = TASK_MILESTONES[event.type];
    if (taskMilestone && event.task_id !== null) {
      pushMilestone(entries, {
        kind: "milestone",
        id,
        at: event.ts,
        text: `${taskLabel(event.task_id, taskTitles)} ${taskMilestone.text}`,
        tone: taskMilestone.tone,
        count: 1,
        taskId: event.task_id,
        durationMs: FINISHED_TYPES.has(event.type)
          ? elapsed(startedAt.get(event.task_id), event.ts)
          : null
      });
    }
  }

  return entries;
}

/* Consecutive milestones collapse only when they are the same thing happening to
   the same task. Keying on rendered text merged three different failing tasks
   into one "x3" row on a real trail, which reads as one task retrying. */
function pushMilestone(entries: ThreadEntry[], milestone: ThreadMilestone): void {
  const previous = entries.at(-1);
  if (
    previous?.kind === "milestone" &&
    previous.text === milestone.text &&
    previous.taskId === milestone.taskId
  ) {
    previous.count += 1;
    previous.at = milestone.at;
    previous.durationMs = milestone.durationMs ?? previous.durationMs;
    return;
  }
  entries.push(milestone);
}

function elapsed(from: string | undefined, to: string): number | null {
  if (from === undefined) return null;
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) && span > 0 ? span : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}
