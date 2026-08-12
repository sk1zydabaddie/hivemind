/* Internal identifiers, and the one rule about them: a person never sees one.
 *
 * `T-001`, `G-1`, `S-001`, `V-335aa795-…` are Core's names for things. They are
 * load-bearing in the trail, in every payload and in every support conversation,
 * and they are meaningless to the person who typed a sentence and is watching
 * machines build it. A task is identified by its title. Two tasks with the same
 * title are a planner problem, not a reason to put `T-002` on screen.
 *
 * This has been asked for five times and kept coming back as "lead with the
 * title, keep the identifier secondary", which is not the same thing. So the
 * removal lives in one function with one pattern, `test/identifiers.test.ts`
 * RENDERS the primary surfaces against real replayed trails and scans the
 * markup, and a sixth regression fails a test rather than a review.
 *
 * Where an identifier is genuinely needed — a support conversation, or reading
 * the durable record — it is in exactly two places: the run's own "copy details"
 * action and the full-record dialog, both of which a person has to ask for.
 */

/* Deliberately narrow. It matches Core's own identifier shapes and nothing that
   merely looks like one: `T-001`, `G-1`, `S-001`, `V-<uuid>`, and the bare
   40-hex object names git uses. A version string like `v2` is not matched — it
   is lowercase and has no separator — and neither is `COVID-19` in a title,
   because the letter set is exactly the four Core uses. */
export const IDENTIFIER_PATTERN = /\b(?:[TGSV]-[0-9a-f]{1,}(?:-[0-9a-f]+)*|[TGSV]-\d+)\b/gu;

/** Does this string carry an identifier a person should never be shown? */
export function hasIdentifier(value: string): boolean {
  IDENTIFIER_PATTERN.lastIndex = 0;
  return IDENTIFIER_PATTERN.test(value);
}

/**
 * The same sentence with the identifiers taken out, and the spacing repaired.
 *
 * Removing a token from the middle of a sentence leaves a double space, and
 * removing one from the end leaves a trailing space before punctuation. Core
 * writes "T-209 stopped" and "rejected add src/ledger.js", so both the leading
 * and the embedded case are real.
 */
export function stripIdentifiers(value: string): string {
  return value
    .replace(IDENTIFIER_PATTERN, "")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s+([,.;:)\]])/gu, "$1")
    .replace(/([([])\s+/gu, "$1")
    /* An identifier alone inside brackets leaves the brackets holding nothing. */
    .replace(/\(\s*\)|\[\s*\]/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/**
 * A task's name, or nothing.
 *
 * `null` rather than the identifier when no title is known. The caller then has
 * to say something honest — "a task" — instead of leaking `T-101`. Trails that
 * predate `task.created` carrying titles genuinely cannot be made to name their
 * tasks, and inventing a name would be worse than admitting it.
 */
export function taskTitleOrNull(
  taskId: string | null,
  taskTitles: Record<string, string>
): string | null {
  if (taskId === null) return null;
  const title = taskTitles[taskId];
  if (title === undefined) return null;
  const trimmed = title.trim();
  return trimmed === "" || trimmed === taskId ? null : trimmed;
}

/** What to call a task in a sentence when its title is not known. */
export const ANONYMOUS_TASK = "One of the tasks";
