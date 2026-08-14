/**
 * A refusal, in a sentence a person can act on.
 *
 * This lives in Core, and that placement is the whole point.
 *
 * The desktop used to carry a regex list matching Core's failure prose and
 * rewriting it. That list was wrong in three ways at once: anything unmapped
 * rendered raw internal text into a polished surface; the list had to be
 * re-derived whenever Core reworded anything; and it made the client the
 * authority on what Core's failures mean, which is exactly the coupling the
 * thin-client boundary exists to prevent.
 *
 * **The producer of a failure is the only thing that knows what it means.** So
 * Core attaches the sentence, the daemon returns it alongside the machine
 * reason, and the client renders what it is given.
 *
 * `reason` is unchanged and stays machine-facing: other code matches on it, and
 * rewording it in place would break those matches. `plain` is additive and
 * optional, which is what lets an older client keep working against a newer
 * daemon and vice versa.
 *
 * Returning `null` is a real answer. It means "no better sentence than the raw
 * one exists", and a caller that renders the raw reason in that case is
 * correct — an invented paraphrase of a failure nobody has mapped would be
 * worse than the original, because it would hide which failure it was.
 */

interface PlainMapping {
  /** Matched against the machine reason. */
  match: RegExp;
  /** What a person is told instead. Never mentions an internal identifier. */
  plain: string;
}

/* Ordered: the first match wins, so narrower patterns come first. The
   skeleton-trap case is above the generic plan case for that reason. */
const MAPPINGS: PlainMapping[] = [
  {
    match: /SKELETON_TRAP_ACCEPTANCE|deterministic_validity_check must be independent/iu,
    plain:
      "The proposed plan was stopped because its contract check duplicated a test the worker would write itself. No work started. Prepare a plan again to get an independent check."
  },
  {
    match: /has started and its contract is immutable/iu,
    plain:
      "This task is already working and cannot be edited. Guide the worker, or stop it and plan again."
  },
  {
    match: /no unhandled rejected write-intent/iu,
    plain: "The worker is not waiting at a safe correction point yet."
  },
  {
    match: /current lint-passed tentative plan|plan hash|re-ratification/iu,
    plain: "The plan changed. Review the latest version before approving it."
  },
  {
    match: /change not found/iu,
    plain: "No submitted change is available for this task yet."
  },
  {
    match: /already terminal/iu,
    plain: "This task has already finished and cannot be stopped again."
  },
  {
    match: /quality run is already cancelled/iu,
    plain: "This draft run has already stopped."
  },
  {
    match: /no unique admitted run/iu,
    plain: "This draft run is not active or cannot be identified safely."
  },
  {
    match: /cleanup|worker death|liveness|termination/iu,
    plain:
      "The stop was recorded, but cleanup could not be proven complete. Ownership stays held so other work cannot collide with it."
  },
  /* Added with the actions that produce them, which is the point of the file
     living here: a new refusal and its sentence are written together. */
  {
    match: /no checks have been run and recorded/iu,
    plain:
      "Hivemind has not run this project's checks yet, so there is no output to show."
  },
  {
    match: /outside repo root|\.\. traversal|absolute paths are not allowed/iu,
    plain: "That path is outside this project, so Hivemind will not open it."
  },
  {
    match: /is not read as project files|the git directory is not project source/iu,
    plain:
      "That is Hivemind's own record rather than your project's code. The run history and settings screens show it instead."
  },
  {
    match: /file is not text/iu,
    plain: "That file is not text, so there is nothing to show line by line."
  },
  {
    match: /cannot supply authority field/iu,
    plain:
      "That request tried to carry its own approval. Approval comes from the buttons in Hivemind, never from the request itself."
  }
];

/** The sentence for a machine reason, or null when none is better than it. */
export function plainReason(reason: string): string | null {
  const text = reason.trim();
  if (text === "") return null;
  return MAPPINGS.find((entry) => entry.match.test(text))?.plain ?? null;
}

/**
 * Attach the sentence to a failed result, leaving a successful one untouched.
 *
 * Additive: `reason` is preserved exactly, so anything matching on it keeps
 * working, and `plain` is simply absent when nothing maps.
 */
export function withPlainReason<T extends { ok: boolean; reason?: unknown }>(
  result: T
): T & { plain?: string } {
  if (result.ok || typeof result.reason !== "string") return result;
  const plain = plainReason(result.reason);
  return plain === null ? result : { ...result, plain };
}
