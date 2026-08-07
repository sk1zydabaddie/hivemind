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
}

export interface ThreadShipped {
  kind: "shipped";
  id: string;
  at: string;
  taskIds: string[];
  changedFiles: string[];
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
  "context.low": { text: "An agent is running out of room to work", tone: "warning" }
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

export function buildRunThread(
  eventsNewestFirst: HivemindEvent[],
  taskTitles: Record<string, string>
): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const appliedGuidance = new Set<string>();

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
        changedFiles: readStringArray(event.data.changed_files) ?? [],
        branch: readString(event.data.base_branch),
        adoptedRef: readString(event.data.adopted_ref)
      });
      continue;
    }

    const runMilestone = RUN_MILESTONES[event.type];
    if (runMilestone) {
      pushMilestone(entries, { kind: "milestone", id, at: event.ts, count: 1, ...runMilestone });
      continue;
    }

    const taskMilestone = TASK_MILESTONES[event.type];
    if (taskMilestone && event.task_id !== null) {
      const subject = taskTitles[event.task_id] ?? "A task";
      pushMilestone(entries, {
        kind: "milestone",
        id,
        at: event.ts,
        text: `${subject} ${taskMilestone.text}`,
        tone: taskMilestone.tone,
        count: 1
      });
    }
  }

  return entries;
}

/* Consecutive identical milestones collapse, so ten workers starting reads as
   one line with a count rather than ten rows. */
function pushMilestone(entries: ThreadEntry[], milestone: ThreadMilestone): void {
  const previous = entries.at(-1);
  if (previous?.kind === "milestone" && previous.text === milestone.text) {
    previous.count += 1;
    previous.at = milestone.at;
    return;
  }
  entries.push(milestone);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}
