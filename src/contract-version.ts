/**
 * Reading a task contract that a different build wrote.
 *
 * INVARIANT: upgrading Hivemind must not lose in-flight work, and a durable
 * format gaining a field must not make existing records unreadable -- without
 * loosening closed-world validation, which is a real floor against a worker
 * smuggling data through a contract.
 *
 * The answer is versioning plus a read-time upcast, never a rewrite. Rewriting
 * is not available even in principle: `verificationInputsStillMatch` re-hashes
 * every contract file and `adoption.ts` gates on it, so migrating a contract on
 * disk would report `verified-then-stale: contract hash changed` on work that
 * was already verified. A user's reward for upgrading would be losing exactly
 * the work this invariant exists to protect.
 *
 * So: bytes on disk are never touched, the upcast happens in memory on every
 * read, and old records stay readable by old builds.
 *
 * Two rules keep the upcast trustworthy:
 *
 * - It is PURE and TOTAL. No I/O, no clock, no config. Two reads of the same
 *   bytes must produce the same contract, or a hash-bound artifact could
 *   disagree with itself.
 * - Where no safe default exists it FAILS, naming the field. Inventing a value
 *   for a field that governs behaviour is worse than refusing.
 */

import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";

/**
 * The format this build writes and is the newest it can read.
 *
 * A single integer on purpose. A minor-version escape hatch -- "older readers
 * may ignore fields they do not know" -- is exactly the hole closed-world
 * validation exists to close, because an unknown field rides in under a minor
 * bump. Every known version therefore gets its own exact field set.
 */
export const CONTRACT_FORMAT_VERSION = 1;

/**
 * Contracts written before this field existed. Absence is not a statement
 * about intent, it is evidence of age -- the same reading applied to tier
 * globs and adapter roles.
 */
export const UNVERSIONED_CONTRACT_VERSION = 0;

/**
 * `routing_task_type` became required when learned routing landed, and every
 * contract authored before that has none. It is the reason a pre-upgrade task
 * is unusable today: it gates `loadAndValidateContract`, which gates lease,
 * run, worktree, submit, analyze, verification and adoption.
 *
 * `other` is the enum's own unclassified member, not an invented value, and it
 * is safe in both directions that consume the field: a learned-routing
 * scorecard lookup that misses falls back to the deterministic comparison, and
 * a value-quality policy that does not name it DENIES admission. Neither can
 * spend more or reach a stronger provider because of this default.
 */
const UNVERSIONED_ROUTING_TASK_TYPE: RoutingTaskType = "other";

export interface ContractUpcast {
  contract: Record<string, unknown>;
  /** The version found on disk, for diagnostics and tests. */
  from_version: number;
  /** What the upcast supplied, so a reader can say what it assumed. */
  applied: string[];
}

export type ContractVersionResult =
  | { ok: true; value: ContractUpcast }
  | { ok: false; reason: string };

/**
 * Reads the version BEFORE any schema validation.
 *
 * Order matters and is the structural half of this fix. Validation checks the
 * field set last, so a contract from a newer build used to fail with
 * "unsupported contract field: <whatever was added>" -- which reads as a
 * malformed contract and sends a person looking for a corruption that is not
 * there. The version has to be established first so the refusal can say what
 * is actually true.
 */
export function upcastContract(raw: unknown, contractLabel: string): ContractVersionResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${contractLabel} is not a JSON object` };
  }
  const source = raw as Record<string, unknown>;
  const declared = source.contract_version;

  let version: number;
  if (declared === undefined) {
    version = UNVERSIONED_CONTRACT_VERSION;
  } else if (typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0) {
    version = declared;
  } else {
    return {
      ok: false,
      reason: `${contractLabel} has an invalid contract_version (${JSON.stringify(declared)}); it must be a non-negative integer`
    };
  }

  if (version > CONTRACT_FORMAT_VERSION) {
    return {
      ok: false,
      reason:
        `${contractLabel} was written by a newer Hivemind (contract format ${version}). ` +
        `This build reads up to format ${CONTRACT_FORMAT_VERSION}. Upgrade Hivemind to use this task. ` +
        "The contract has not been changed, so an older build can still read it."
    };
  }

  if (version === CONTRACT_FORMAT_VERSION) {
    return { ok: true, value: { contract: source, from_version: version, applied: [] } };
  }

  return upcastFromUnversioned(source, contractLabel);
}

/**
 * 0 -> 1. Supplies only fields that became required after the contract was
 * written, and only where a default is defensible.
 */
function upcastFromUnversioned(
  source: Record<string, unknown>,
  contractLabel: string
): ContractVersionResult {
  const contract: Record<string, unknown> = { ...source };
  const applied: string[] = [];

  if (!isRoutingTaskType(contract.routing_task_type)) {
    if (contract.routing_task_type !== undefined) {
      // Present but not a member: that is a malformed value, not an old one,
      // and overwriting it would discard something somebody wrote.
      return {
        ok: false,
        reason:
          `${contractLabel} declares routing_task_type ${JSON.stringify(contract.routing_task_type)}, ` +
          "which is not a known routing task type. It was not written by an older Hivemind, so it is not upcast."
      };
    }
    contract.routing_task_type = UNVERSIONED_ROUTING_TASK_TYPE;
    applied.push(`routing_task_type=${UNVERSIONED_ROUTING_TASK_TYPE}`);
  }

  contract.contract_version = CONTRACT_FORMAT_VERSION;
  return { ok: true, value: { contract, from_version: UNVERSIONED_CONTRACT_VERSION, applied } };
}
