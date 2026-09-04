import { isRecord } from "./json.js";
import { randomUUID } from "node:crypto";
import { appendEvent, readEvents } from "./events.js";

export interface HumanGuidance {
  guidance_id: string;
  target: "orchestrator";
  message: string;
  recorded_at: string;
}

type GuidanceResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function recordHumanGuidance(
  repoRoot: string,
  request: unknown
): Promise<GuidanceResult<HumanGuidance>> {
  if (!isRecord(request)) {
    return { ok: false, reason: "human guidance must be a JSON object" };
  }
  const keys = Object.keys(request);
  if (keys.some((key) => key !== "target" && key !== "message")) {
    return { ok: false, reason: `human guidance contains unsupported authority field: ${keys.find((key) => key !== "target" && key !== "message")}` };
  }
  if (request.target !== "orchestrator") {
    return { ok: false, reason: "human guidance target must be orchestrator" };
  }
  if (typeof request.message !== "string" || request.message.trim() === "" || request.message.length > 20_000) {
    return { ok: false, reason: "human guidance message must be a non-empty string of at most 20000 characters" };
  }
  const guidance: HumanGuidance = {
    guidance_id: `H-${randomUUID()}`,
    target: "orchestrator",
    message: request.message.trim(),
    recorded_at: new Date().toISOString()
  };
  const appended = await appendEvent(repoRoot, {
    type: "human.guidance_recorded",
    task_id: null,
    data: {
      version: 1,
      ...guidance,
      advisory_only: true,
      authorization_effect: "none"
    }
  });
  return appended.ok ? { ok: true, value: guidance } : appended;
}

export async function readPendingHumanGuidance(repoRoot: string): Promise<GuidanceResult<HumanGuidance[]>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const consumed = new Set<string>();
  for (const event of events.value) {
    if (event.type !== "human.guidance_consumed") continue;
    if (!Array.isArray(event.data.guidance_ids) || !event.data.guidance_ids.every((id) => typeof id === "string")) {
      return { ok: false, reason: "durable human guidance consumption evidence is malformed" };
    }
    for (const id of event.data.guidance_ids) {
      consumed.add(id);
    }
  }
  const pending: HumanGuidance[] = [];
  for (const event of events.value) {
    if (event.type !== "human.guidance_recorded") continue;
    const id = event.data.guidance_id;
    const message = event.data.message;
    if (
      typeof id !== "string" ||
      typeof message !== "string" ||
      event.data.target !== "orchestrator" ||
      event.data.advisory_only !== true ||
      event.data.authorization_effect !== "none"
    ) {
      return { ok: false, reason: "durable human guidance evidence is malformed or claims authority" };
    }
    if (consumed.has(id)) continue;
    pending.push({ guidance_id: id, target: "orchestrator", message, recorded_at: event.ts });
  }
  return { ok: true, value: pending };
}

/**
 * Pending guidance, split into what a judgment turn may still read and what has
 * gone stale -- and WHY, in both directions.
 *
 * Guidance is advisory and consumed on the next judgment turn. Two things
 * follow that nothing used to say out loud. A run on the deterministic happy
 * path may have no judgment turn at all, so guidance can sit unread for the
 * whole run while the composer's own reply said "saved for the next step". And
 * guidance written against one run's state is not advice about the next one:
 * landing it hours later, against a plan it was never written for, is worse
 * than dropping it, because it reads as current intent.
 *
 * The boundary is trail ORDER, not the clock: guidance recorded before the most
 * recent run start is stale. Order is the authority the trail actually
 * guarantees -- timestamps come from whichever machine wrote them, and this
 * project has already had one verdict travel between machines.
 *
 * Nothing here mutates the trail. Staleness is a READING of durable evidence,
 * so a stale entry stays in the record and can still be read by a person; what
 * changes is that a judgment turn is not handed it and the surface says which
 * bucket each entry is in.
 */
export interface GuidanceStanding {
  /** Recorded during this run, not yet consumed. A judgment turn may read it. */
  pending: HumanGuidance[];
  /** Recorded before this run started and never consumed. */
  stale: Array<HumanGuidance & { why: string }>;
}

export async function readHumanGuidanceStanding(
  repoRoot: string
): Promise<GuidanceResult<GuidanceStanding>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const all = await readPendingHumanGuidance(repoRoot);
  if (!all.ok) return all;

  /* The last run start in trail order. `autonomy.decision_recorded` with
     `decision: "run_started"` is what `manager.start` writes, so this needs no
     new event type -- the boundary was already being recorded. */
  let latestRunStartIndex = -1;
  events.value.forEach((event, index) => {
    if (event.type === "autonomy.decision_recorded" && event.data.decision === "run_started") {
      latestRunStartIndex = index;
    }
  });
  if (latestRunStartIndex < 0) {
    return { ok: true, value: { pending: all.value, stale: [] } };
  }

  const recordedIndex = new Map<string, number>();
  events.value.forEach((event, index) => {
    if (event.type !== "human.guidance_recorded") return;
    const id = event.data.guidance_id;
    if (typeof id === "string" && !recordedIndex.has(id)) recordedIndex.set(id, index);
  });

  const pending: HumanGuidance[] = [];
  const stale: Array<HumanGuidance & { why: string }> = [];
  for (const entry of all.value) {
    const at = recordedIndex.get(entry.guidance_id);
    if (at !== undefined && at < latestRunStartIndex) {
      stale.push({
        ...entry,
        why: "recorded before this run started, and no judgment turn read it. It is kept in the record but will not be given to the agent, because advice written for the previous state reads as current intent when it lands later."
      });
      continue;
    }
    pending.push(entry);
  }
  return { ok: true, value: { pending, stale } };
}

export async function markHumanGuidanceConsumed(
  repoRoot: string,
  guidanceIds: string[],
  sessionId: string | undefined
): Promise<GuidanceResult<void>> {
  if (guidanceIds.length === 0) return { ok: true, value: undefined };
  const appended = await appendEvent(repoRoot, {
    type: "human.guidance_consumed",
    task_id: null,
    data: {
      version: 1,
      guidance_ids: [...new Set(guidanceIds)].sort(),
      manager_session_id: sessionId ?? null,
      consumed_on: "next_proposal",
      authorization_effect: "none"
    }
  });
  return appended.ok ? { ok: true, value: undefined } : appended;
}
