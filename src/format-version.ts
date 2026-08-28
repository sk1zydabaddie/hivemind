/**
 * The version gate every durable format runs before it validates anything else.
 *
 * INVARIANT: upgrading Hivemind must not lose in-flight work, and a durable
 * format gaining a field must not make existing records unreadable -- without
 * loosening closed-world validation, which is a real floor. So: version, then
 * upcast at read, never a rewrite.
 *
 * ORDER IS THE POINT. Every format here used to check `version !== 1` somewhere
 * in the middle of its shape validation, which has two consequences the moment
 * anyone bumps a version:
 *
 * - the failure is illegible. A v2 record trips a field or shape check first
 *   and reports "unsupported field: x" or "manifest is malformed", which reads
 *   as corruption and sends a person hunting damage that is not there.
 * - there is nowhere to put an upcast, because by the time the version is known
 *   the record has already been rejected.
 *
 * Twenty-one modules declared `version: 1` and hard-failed on anything else,
 * and no format in this repository was ever version 2. That convention was
 * present and inert: a version that can only be 1 is worse than none, because
 * it looks like migration support while guaranteeing a hard failure the instant
 * someone uses it. This gate is what makes it real.
 *
 * Applying it is deliberately behaviour-preserving today. Every format below
 * has always written its version, so an absent version means a malformed
 * record rather than an old one, and `whenAbsent: "refuse"` keeps exactly the
 * outcome those records already got. What changes is that the refusal is
 * legible and that there is now one obvious place to add an upcast.
 */

export interface FormatVersionGate {
  /** Named in the refusal, so a person knows which format is being discussed. */
  format: string;
  /** The newest version this build can read and the version it writes. */
  current: number;
  /**
   * What an absent version means.
   *
   * A number names a real pre-versioning era -- only task contracts have one.
   * "refuse" is correct for every format that has always stamped its version,
   * because there absence is damage, not age.
   */
  whenAbsent: number | "refuse";
}

export type FormatVersionResult =
  | { ok: true; version: number }
  | { ok: false; reason: string };

/**
 * Establishes the version BEFORE any shape validation.
 *
 * A record from a newer build is refused rather than read leniently, and that
 * is a safety position rather than caution: a later version may add a field
 * that NARROWS what something permits, and a build that ignores it would grant
 * more than was intended.
 */
export function checkFormatVersion(
  raw: unknown,
  gate: FormatVersionGate,
  label: string
): FormatVersionResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${label} is not a JSON object` };
  }
  const declared = (raw as Record<string, unknown>).version;

  if (declared === undefined) {
    if (gate.whenAbsent === "refuse") {
      return {
        ok: false,
        reason: `${label} declares no ${gate.format} version; this build writes version ${gate.current}`
      };
    }
    return { ok: true, version: gate.whenAbsent };
  }

  if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 0) {
    return {
      ok: false,
      reason: `${label} has an invalid ${gate.format} version (${JSON.stringify(declared)}); it must be a non-negative integer`
    };
  }

  if (declared > gate.current) {
    return {
      ok: false,
      reason:
        `${label} was written by a newer Hivemind (${gate.format} format ${declared}). ` +
        `This build reads up to format ${gate.current}. Upgrade Hivemind to use it. ` +
        "The file has not been changed, so an older build can still read it."
    };
  }

  return { ok: true, version: declared };
}

/**
 * Every versioned durable format, in one place, so the set is reviewable and a
 * new one cannot quietly skip the gate.
 *
 * Deliberately absent: the lease-lock record and project-temp's owner.json.
 * Both are ephemeral and already fail closed in the right direction -- an
 * unparseable lock is reaped as stale, and an owner record that does not match
 * means "not mine", which is the answer either way. Versioning them would add
 * ceremony and no safety.
 */
export const formatVersions = {
  config: { format: "config", current: 1, whenAbsent: "refuse" },
  spec: { format: "spec", current: 1, whenAbsent: "refuse" },
  tentativePlan: { format: "plan", current: 1, whenAbsent: "refuse" },
  replan: { format: "replan", current: 1, whenAbsent: "refuse" },
  ideation: { format: "ideation", current: 1, whenAbsent: "refuse" },
  intent: { format: "write-intent", current: 1, whenAbsent: "refuse" },
  memoryCanon: { format: "memory canon", current: 1, whenAbsent: "refuse" },
  routingPolicy: { format: "routing policy", current: 1, whenAbsent: "refuse" },
  valueQualityPolicy: { format: "value-quality policy", current: 1, whenAbsent: "refuse" },
  verificationPolicy: { format: "verification policy", current: 1, whenAbsent: "refuse" },
  verificationSet: { format: "verification-set manifest", current: 1, whenAbsent: "refuse" },
  qualityDraftManifest: { format: "quality draft manifest", current: 1, whenAbsent: "refuse" },
  qualitySelection: { format: "quality selection", current: 1, whenAbsent: "refuse" },
  capabilityCorpusManifest: { format: "capability corpus manifest", current: 1, whenAbsent: "refuse" },
  capabilityCorpusReport: { format: "capability corpus report", current: 1, whenAbsent: "refuse" },
  capabilityCorpusEvidence: { format: "capability corpus evidence", current: 1, whenAbsent: "refuse" },
  routingObservation: { format: "routing observation", current: 1, whenAbsent: "refuse" },
  quotaLedger: { format: "quota ledger", current: 1, whenAbsent: "refuse" },
  meteredReservation: { format: "metered reservation", current: 1, whenAbsent: "refuse" },
  managerSession: { format: "manager session", current: 1, whenAbsent: "refuse" },
  daemonState: { format: "daemon state", current: 2, whenAbsent: "refuse" }
} as const satisfies Record<string, FormatVersionGate>;
