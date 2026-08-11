/* The words this product does not say, in one place.
 *
 * The client is not the only thing writing user-facing text: Core composes the
 * `detail` on every queue item, and that text is gate output. Replaying a real
 * trail put "Run the real project checks again before adoption" on the primary
 * attention bar -- Core's sentence, rendered verbatim, using vocabulary that is
 * banned from every surface a person sees.
 *
 * This is deliberately NOT a translation table. The client does not own Core's
 * strings and cannot guess what they mean; DESIGN-NOTES records three separate
 * attempts to do that. What it can do safely is *recognise its own banned
 * vocabulary* and decline to render a sentence containing it, falling back to
 * wording chosen by the item's typed `kind` -- a contract field, not prose.
 *
 * The durable fix is a `plain_reason` written where the reason is produced.
 * When Core writes it, this guard stops firing on its own.
 */

export const BANNED_VOCABULARY = [
  "lease",
  "canon",
  "oracle",
  "tier-1",
  "tier 1",
  "tier-2",
  "tier 2",
  "write-intent",
  "write intent",
  "integrate_shadow",
  "adoption",
  "adopt",
  "execution group",
  "worktree",
  "task_type",
  "routing policy",
  "quality run",
  "admission",
  "provenance",
  "durable trail",
  "provider evidence"
] as const;

/** True when a string Core wrote uses vocabulary this product does not say. */
export function containsInternalVocabulary(text: string): boolean {
  const haystack = text.toLowerCase();
  return BANNED_VOCABULARY.some((term) => haystack.includes(term));
}
