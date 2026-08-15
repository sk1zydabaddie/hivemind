/**
 * Reading a record that may be older than the field you want.
 *
 * ## The pattern, after three instances in one session
 *
 * Every one of these crashed the surface it was on, and every one was found by
 * replaying a real or older trail rather than by a test:
 *
 * | Field | Surface it took down |
 * | --- | --- |
 * | `ChecksView.provenance` | the ship moment |
 * | the accounts view's `roles` | the Project tab |
 * | `config.task_type_routing` | the settings dialog |
 *
 * All three read a property straight off a value that was absent, because the
 * record predated the field. Not three bugs — one bug, three times, and the
 * third was found the same week as the first two.
 *
 * **A record written before a field existed is a PERMANENT input, not a
 * transitional one.** Trails are durable by design; the whole architecture
 * rests on rebuilding state from events that were written months ago. There is
 * no future in which the client only ever sees records from its own version.
 *
 * ## Why the types were the bug
 *
 * The client typed daemon responses as though the daemon were always current.
 * `task_type_routing: Record<string, …>` is a claim that the field is always
 * there, so TypeScript — correctly, given the claim — allowed indexing it
 * directly. The type described the code that produces records today, not the
 * records that exist.
 *
 * So the fix is to stop lying to the compiler:
 *
 * > **Every collection-valued field on a daemon response is optional to the
 * > client.** Absent is a value it will really see.
 *
 * With `strict` on, that turns `tsc` into the lint: a direct `.length`,
 * `.map()` or `[key]` on one of these is a build error, and `tsc --noEmit`
 * already gates the ship path through `bundle:prepare`. No new tooling, and
 * nothing that depends on anyone remembering the rule.
 *
 * Scoped to COLLECTIONS on purpose. An absent scalar renders as a blank, which
 * is a cosmetic problem; an absent array or object is dereferenced and takes
 * the surface down. That is the difference between the class that has bitten
 * three times and the class that has never bitten once, and a rule that covers
 * both would be noise around the part that matters.
 *
 * ## The same family as schema migration, one layer out
 *
 * Core has 21 modules declaring `version: 1` and hard-failing on anything else
 * — a convention that is present and inert because no format has ever reached
 * version 2. This is that same problem on the client, except it is not
 * hypothetical: the records are already in the wild, the versions already
 * differ, and the failure has already happened three times. The difference in
 * posture is deliberate. Core refuses a format it does not understand, because
 * acting on a misread contract is unbounded. A surface reading a missing field
 * degrades to the empty case and says so, because refusing to render a settings
 * dialog is worse than rendering one with nothing chosen yet.
 */

/** An array off a durable record, or the empty one. */
export function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : EMPTY_LIST;
}

/** A keyed table off a durable record, or the empty one. */
export function table<V>(
  value: Record<string, V> | null | undefined
): Record<string, V> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : (EMPTY_TABLE as Record<string, V>);
}

/**
 * Whether a nested record is really there.
 *
 * For the case `list` and `table` do not cover: a field whose value is an
 * object with its own shape, where the honest answer to "is it absent?" is to
 * render something different rather than to substitute an empty one. The ship
 * moment does this — a run recorded before provenance existed says so, instead
 * of showing a provenance with nothing in it.
 */
export function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/* Frozen and shared: a fresh `[]` per call would defeat the referential checks
   React uses to decide whether anything changed, and a mutable shared default
   is a bug waiting for somebody to push to it. */
const EMPTY_LIST: readonly never[] = Object.freeze([]);
const EMPTY_TABLE: Readonly<Record<string, never>> = Object.freeze({});
