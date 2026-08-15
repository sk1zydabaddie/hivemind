import type { BoardProjection, HivemindEvent, TaskProjection } from "./projection";

/**
 * The gates, drawn.
 *
 * Hivemind's differentiator is that an agent's work has to get past something
 * before it counts, and until now that was invisible until one fired. A screen
 * where nothing has gone wrong showed no evidence that anything was being
 * enforced — which is the one thing a screenshot of this product should say
 * that a screenshot of any other cannot.
 *
 * So a gate is a rule the lanes pass through. The hard part is restraint:
 *
 * > **The rules must not become chrome.** A line at every phase boundary is
 * > horizontal noise in an already dense interface, and it would compete with
 * > the amber attention edge for the same glance.
 *
 * Three rules follow from that, and they are why this module returns so little:
 *
 * 1. **One rule per GATE, never per task and never per phase.** Three tasks
 *    that each cleared the scope gate produce one rule reading "3 leases
 *    approved", not three rules.
 * 2. **Drawn only where something actually passed through.** These are counted
 *    from durable events — `lease.approved`, `write_intent.approved`,
 *    `manager.action_approved`. A gate nothing has reached yet is not drawn,
 *    because drawing it would be describing the product rather than reporting
 *    the run.
 * 3. **Quiet until it holds.** A passed rule is a hairline at 45% against the
 *    rule colour, thinner and lighter than any lane. A holding rule is clay,
 *    doubled, and is the only one that gets to compete for attention.
 *
 * The result on a healthy run is one or two hairlines. That is the intent: on
 * this surface the gates should be felt rather than read, right up until one
 * stops something.
 */

export interface GateRule {
  id: string;
  /** What the gate is called, in the product's own words. */
  label: string;
  /** What actually passed through it, counted from the trail. */
  detail: string;
  /** Held gates are the only loud ones. */
  standing: "passed" | "held";
}

/* The durable events that mean "something got past a gate", and what to call
   the gate they got past. Keyed by event type so a new event type is a
   deliberate addition here rather than something this quietly misses. */
const PASSAGE: Record<string, { id: string; label: string; noun: string }> = {
  "lease.approved": { id: "scope", label: "Scope", noun: "file claim" },
  "write_intent.approved": { id: "write", label: "Write", noun: "edit" },
  "manager.action_approved": { id: "manager", label: "Next step", noun: "decision" }
};

function countBy(events: HivemindEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!(type in PASSAGE)) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/**
 * The rules to draw above a group of lanes.
 *
 * Deliberately at most one per gate kind, and only for kinds something has
 * actually been through. `recentEvents` is a window rather than the whole
 * trail, so these counts are "in view", which is what the label says.
 */
export function passedGates(projection: BoardProjection): GateRule[] {
  const counts = countBy(projection.recentEvents);
  const rules: GateRule[] = [];
  for (const [type, spec] of Object.entries(PASSAGE)) {
    const count = counts.get(type) ?? 0;
    if (count === 0) continue;
    rules.push({
      id: spec.id,
      label: spec.label,
      detail: `${count} ${spec.noun}${count === 1 ? "" : "s"} approved`,
      standing: "passed"
    });
  }
  return rules;
}

/**
 * The gate holding this task, if one is.
 *
 * A task carrying an issue while it is stopped is a task something refused, and
 * the reason Core recorded is what the rule says. There is no second source of
 * truth here and no rewriting: if Core did not say why, no rule is drawn, and
 * the row's own issue text stands alone rather than a rule inventing a name for
 * something nobody named.
 */
export function holdingGate(task: TaskProjection): GateRule | null {
  const issue = typeof task.issue === "string" ? task.issue.trim() : "";
  if (issue === "") return null;
  if (task.state !== "paused" && task.state !== "blocked" && task.state !== "failed") {
    return null;
  }
  return {
    id: `hold-${task.task_id}`,
    label: "Held",
    detail: issue,
    standing: "held"
  };
}
