/**
 * Typed failure codes, so control flow never reads prose.
 *
 * INVARIANT: control flow must never depend on the text of a message. A reason
 * is for humans; a code is for code. Rewording an error must be a copy change,
 * never a behaviour change.
 *
 * Twenty-eight sites resolved control flow by pattern-matching human-readable
 * error strings. The worst FAIL OPEN -- they proceed when the message matches,
 * so a reworded message silently disables a floor rather than degrading a
 * message. Three separate copies of one such check keyed on wording produced in
 * a completely different module, which nothing connected them to.
 *
 * The rules:
 *
 * - A producer that a caller needs to DISTINGUISH sets a code. Producers whose
 *   failures are only ever shown to a person do not need one.
 * - A caller branches on the code and never on the reason.
 * - A code is part of the contract between two modules. Changing one is a
 *   behaviour change and should be as visible as changing a function signature;
 *   changing a reason should be invisible.
 *
 * `code` is optional so every existing failure construction still compiles and
 * so adding one is a local change. Absence means "no caller distinguishes this"
 * -- and a caller must therefore treat an absent code as no match, never as a
 * wildcard.
 */

export const failureCodes = [
  /** No tentative plan file exists for the spec. Produced by loadTentativePlan. */
  "tentative_plan_not_found",
  /** No active spec has been selected. Produced by readActiveSpec. */
  "no_active_spec",
  /** No integration queue file exists. Produced by loadIntegrationQueue. */
  "integration_queue_not_found",

  /**
   * Worktree cleanup could not finish because something still holds a file, so
   * retrying may succeed. Produced by removeTaskWorktree from a real errno
   * where one exists, and only otherwise from git's stderr.
   */
  "worktree_busy",

  /**
   * Adoption readiness. These drive what a person is told about a failed write
   * to their own branch, so each comes from the check that made the decision
   * rather than from re-reading its sentence.
   */
  "adoption_base_moved",
  "adoption_inputs_changed",
  "adoption_lease_problem",
  "adoption_oracle_block",
  "adoption_base_worktree",

  /**
   * A metered call was refused because the SESSION ceiling would be exceeded,
   * as opposed to one lane failing. The scheduler stops a whole wave on this,
   * so it must not rest on the shape of a sentence about tokens.
   */
  "session_reservation_refused"
] as const;

export type FailureCode = (typeof failureCodes)[number];

export interface CodedFailure {
  ok: false;
  reason: string;
  code?: FailureCode;
}

/**
 * Builds a failure that carries both halves: the code callers branch on, and
 * the sentence a person reads. Keeping them in one call makes it hard to add a
 * code without a reason or to reword a reason and forget the code exists.
 */
export function codedFailure(code: FailureCode, reason: string): { ok: false; reason: string; code: FailureCode } {
  return { ok: false, reason, code };
}

/**
 * The only way a caller should ask "which failure is this?".
 *
 * Fails closed by construction: a result with no code, or with a different
 * code, is not a match. A caller that treated absence as a match would be
 * re-inventing the fail-open this exists to remove.
 */
export function hasFailureCode(result: { ok: boolean; code?: FailureCode }, code: FailureCode): boolean {
  return result.ok === false && result.code === code;
}
