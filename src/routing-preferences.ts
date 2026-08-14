import { readFile } from "node:fs/promises";
import path from "node:path";

import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";

/**
 * Which agent handles which KIND of work, chosen by a person.
 *
 * Routing already knew two things and was missing a third. It knew the task's
 * **tier** — how dangerous the files are — and it knew a **learned policy**
 * promoted from measured outcomes. It did not know that a `ui` task and a
 * `data_model` task at the same tier are different work. Both got the same
 * model, and none of it was reachable from the app.
 *
 * This is the third input, and it is deliberately the weakest of the three:
 *
 * 1. **The tier cap still binds.** A preference cannot route Critical work to a
 *    cheap provider. `checkTierEligibility` runs on the chosen candidate
 *    exactly as it does on a tool named by hand — a preference is a *request*,
 *    and the floor is not negotiable by anyone.
 * 2. **A promoted policy is still how a learned change takes effect.** This
 *    does not touch that machinery. A person choosing a model is an explicit
 *    instruction; a system changing its own weights still needs promotion, and
 *    conflating the two would let a preference launder itself as evidence.
 * 3. **A provider that cannot prove it honours a model pin cannot be chosen
 *    deliberately.** This is the guard that makes the feature meaningful rather
 *    than theatre: choosing "the strong model for visual work" is worthless if
 *    the harness cannot confirm the model it loaded. `pins_one_model` must be
 *    `verified` — the same evidence standard the rest of the contract uses.
 *
 * Absent means absent. No preference for a task type is not "the default
 * preference"; it is routing behaving exactly as it did before this existed.
 */

export interface TaskTypePreference {
  /** A named adapter profile, or null to express only a strength preference. */
  tool: string | null;
  /** How to pick when no tool is named. */
  preference: "cheapest" | "strongest" | null;
}

export type TaskTypePreferences = Partial<Record<RoutingTaskType, TaskTypePreference>>;

/**
 * The task types where a stronger model plausibly buys the most.
 *
 * **A suggestion, never a default**, and the distinction is the point. Three
 * reasons, in order of weight:
 *
 * - **A default spends money nobody asked to spend.** Silently upgrading every
 *   `ui` task to a stronger provider changes a project's bill without anyone
 *   choosing it, and this project's standing posture is that spend is explicit.
 * - **The claim is unmeasured here.** "The capability gap between cheap and
 *   strong models is largest on visual work" is plausible and widely believed
 *   and *this repository has not measured it*. Encoding an unmeasured belief
 *   into routing is exactly what the capability contract exists to prevent —
 *   the whole project refuses declared capabilities in favour of measured ones,
 *   and a default here would be a declaration.
 * - **A suggestion is falsifiable and a default is not.** Offered and declined,
 *   it costs nothing. Applied silently, nobody ever learns whether it helped.
 *
 * So the surface offers it, says why, and the person decides.
 */
export const VISUAL_TASK_TYPES: RoutingTaskType[] = ["ui", "architecture"];

export const VISUAL_SUGGESTION =
  "Visual work is where a stronger model is most often worth it — layout, spacing and " +
  "the shape of a screen are judged by eye, and a cheap model's output tends to need " +
  "more revisions. Hivemind does not do this on its own: it costs more per task, and " +
  "this project has not measured the difference on your work.";

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Validate a preferences object read from config. Refuses rather than repairs. */
export function parseTaskTypePreferences(value: unknown): Result<TaskTypePreferences> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "task_type_routing must be an object" };
  }
  const out: TaskTypePreferences = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isRoutingTaskType(key)) {
      return { ok: false, reason: `task_type_routing has an unknown kind of work: ${key}` };
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `task_type_routing.${key} must be an object` };
    }
    const record = entry as Record<string, unknown>;
    const tool = record.tool;
    const preference = record.preference;
    if (tool !== undefined && tool !== null && typeof tool !== "string") {
      return { ok: false, reason: `task_type_routing.${key}.tool must be an agent name` };
    }
    if (
      preference !== undefined &&
      preference !== null &&
      preference !== "cheapest" &&
      preference !== "strongest"
    ) {
      return { ok: false, reason: `task_type_routing.${key}.preference must be cheapest or strongest` };
    }
    /* An entry that names nothing is a mistake, not a subtle instruction. */
    if ((tool ?? null) === null && (preference ?? null) === null) continue;
    out[key] = {
      tool: typeof tool === "string" ? tool : null,
      preference: preference === "cheapest" || preference === "strongest" ? preference : null
    };
  }
  return { ok: true, value: out };
}

/**
 * Whether a provider may be **deliberately chosen** for a kind of work.
 *
 * Guard 3, and the reason it is a hard refusal rather than a warning: the whole
 * value of naming a model for visual work is that the named model runs. A
 * harness that cannot report which model it loaded turns that choice into a
 * hope. Routing may still *fall back* to such a provider — that is the existing
 * degraded behaviour and is unchanged — but it will not be aimed at one.
 */
export async function providerCanBeChosenDeliberately(
  repoRoot: string,
  tool: string
): Promise<{ allowed: boolean; reason: string | null }> {
  let record: unknown;
  try {
    record = JSON.parse(
      await readFile(path.join(repoRoot, ".hivemind", "adapters", `${tool}.connection.json`), "utf8")
    );
  } catch {
    return {
      allowed: false,
      reason: `${tool} has not been checked, so Hivemind cannot confirm it runs the model you pick. Connect it first.`
    };
  }
  if (typeof record !== "object" || record === null) {
    return { allowed: false, reason: `${tool} has no readable connection record` };
  }
  const shaped = record as { capabilities?: unknown; capabilities_stale?: unknown };
  if (typeof shaped.capabilities_stale === "string") {
    return {
      allowed: false,
      reason: `What Hivemind checked about ${tool} was measured under a different account. Reconnect it before choosing it for specific work.`
    };
  }
  const capabilities = Array.isArray(shaped.capabilities) ? shaped.capabilities : [];
  const pin = capabilities.find(
    (entry): entry is { id: string; status: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { id?: unknown }).id === "pins_one_model"
  );
  if (pin?.status !== "verified") {
    return {
      allowed: false,
      reason: `${tool} does not report which model it actually loaded, so choosing one for this work would not be something Hivemind could confirm.`
    };
  }
  return { allowed: true, reason: null };
}

/** The preference for a task type, or null when none applies. */
export function preferenceFor(
  preferences: TaskTypePreferences,
  taskType: string
): TaskTypePreference | null {
  return isRoutingTaskType(taskType) ? (preferences[taskType] ?? null) : null;
}
