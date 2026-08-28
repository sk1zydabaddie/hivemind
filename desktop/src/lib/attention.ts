import { list } from "@/lib/durable";
import type { WorkspaceQueueItem } from "@/lib/workspace-actions";

/**
 * Breaking silence, and only for that.
 *
 * ## Why this exists at all
 *
 * A Hivemind run is minutes to hours — one measured worker turn ran 281
 * seconds, and a plan is many of those. The product is *supervised* autonomy,
 * and a supervisor who has to keep the window open is not being supervised by
 * the tool: they are babysitting it. Every comparable environment ships an
 * inbox, an activity feed or a phone app for exactly this moment.
 *
 * ## The rule the whole design turns on
 *
 * > **Silence means fine.**
 *
 * So this notifies for one thing: something has entered the state where work
 * has stopped and a person has to decide. Never progress, never completion of
 * a step, never "your agent said something". If a notification arrives that did
 * not need a decision, the next real one gets ignored, and then the feature is
 * worse than not having it.
 *
 * ## Autonomy is mirrored, not re-implemented
 *
 * This reads `needs_you` exactly as Core computes it, and does no filtering of
 * its own. That is deliberate and it is structural rather than polite: Core
 * builds a `plan_review` item only when a plan review exists, and a
 * `manager_approval` item only when the session has a pending action. Under
 * Auto neither is produced, so neither can be notified. A second filter here
 * would be a second opinion about autonomy, and the two would drift — the
 * failure this project has recorded as "two true things, one drawn as the
 * other".
 *
 * ## Why the first sight of an item is silent
 *
 * Opening the app on a project with four pending decisions must not fire four
 * toasts — the person is looking at them. So the first inspection after mount
 * records a baseline and says nothing; only items appearing *after* that are
 * new. That also means a restart is silent about work that was already waiting,
 * which is correct: it is on screen.
 */

/** What a notification is allowed to be about. */
export interface Attention {
  /** Stable across polls, so the same decision is never announced twice. */
  id: string;
  title: string;
  body: string;
}

/**
 * Kinds that mean "stopped, and a person must decide".
 *
 * An allowlist rather than a denylist, for the reason the shell denial is an
 * allowlist: a kind added to Core later should be silent until somebody decides
 * it is worth interrupting for, not loud by default. The cost of the wrong
 * default here is the feature being switched off.
 */
const INTERRUPTS: Record<string, string> = {
  plan_review: "A plan is waiting for you",
  manager_approval: "A step needs your approval",
  verification_blocked: "The checks could not finish",
  reverification_required: "This needs checking again",
  run_stalled: "Work has stopped",
  recovery_required: "Recorded work stopped reporting",
  run_cancel_failed: "This run did not stop cleanly",
  quality_cancel_failed: "A cancellation did not take",
  plan_amendment: "The plan changed and needs you",
  /* Both are Later items, not attention: a waiting note is not a question,
     and a note that expired needs reading rather than answering. */
  guidance_pending: "A note is waiting to be read",
  guidance_expired: "A note was never read",
  adoption_ready: "Ready to adopt",
  /* The two that were missing entirely. A run that ends without shipping, and
     one whose outcome is unknown, are the clearest cases of "work stopped and a
     person must decide" in the whole product -- and neither could fire, because
     the client's queue-kind union did not carry them. */
  adoption_failed: "This did not ship",
  adoption_indeterminate: "Hivemind cannot tell whether this shipped"
};

/*
 * Deliberately NOT interrupting:
 *
 * - `task_attention` — one task inside a running plan wants something. The run
 *   continues, so it is a screen state rather than a stop.
 * - `memory_review` and `quality_review` — proposals with no deadline. They
 *   are the definition of a thing that can wait, and interrupting for them is
 *   how a person learns to ignore the toast.
 */

/** The queue, reduced to what is worth interrupting for. */
export function attentionItems(queue: readonly WorkspaceQueueItem[] | undefined): Attention[] {
  return list(queue)
    .filter((item) => INTERRUPTS[item.kind] !== undefined)
    .map((item) => ({
      id: item.id,
      title: INTERRUPTS[item.kind] ?? "Something needs you",
      /* Core's own sentence. It already says what happened in plain language,
         and rewriting it here would be a second voice for the same fact. */
      body: item.detail.trim() === "" ? item.title : item.detail
    }));
}

/**
 * What is new since the last look, and the state to remember.
 *
 * `seen === null` means this is the first look: everything is recorded and
 * nothing is announced. An item that leaves the queue is forgotten, so if it
 * comes back it is new again — which is right, because it stopped and started
 * needing a person twice.
 */
export function newAttention(
  seen: ReadonlySet<string> | null,
  current: readonly Attention[]
): { announce: Attention[]; seen: Set<string> } {
  const next = new Set(current.map((item) => item.id));
  if (seen === null) return { announce: [], seen: next };
  return { announce: current.filter((item) => !seen.has(item.id)), seen: next };
}

/**
 * One notification, or a summary of several.
 *
 * Four decisions arriving at once should be one interruption, not four. The
 * summary names the count and the first, because a stack of toasts is the same
 * mistake as a chatty one: it teaches the person to dismiss without reading.
 */
export function announcement(items: readonly Attention[]): Attention | null {
  if (items.length === 0) return null;
  const first = items[0]!;
  if (items.length === 1) return first;
  return {
    id: items.map((item) => item.id).join("+"),
    title: `${String(items.length)} things need you`,
    body: `${first.title} — ${first.body}`
  };
}
