import { hostname } from "node:os";

import { compareAdapterVersion, readAdapterVersion } from "./adapter-version.js";
import type { AdapterProfile } from "./adapter.js";

/**
 * Whether a recorded verification still describes what would actually run.
 *
 * A connection record proves capabilities were measured on ONE binary, at ONE
 * version, under ONE account, on ONE machine. Until now it carried none of
 * those facts except the version, and the version was never compared — so a
 * record was treated as true wherever and whenever it was read.
 *
 * That is the capability contract accepting a declaration again. The contract
 * exists because a flag being ACCEPTED is not a flag being APPLIED; a record
 * arriving by `git pull` is the same category of claim, made by somebody else's
 * computer instead of by a config file. It is the stale-wrapper shape exactly:
 * evidence gathered against one binary, applied to a different one, with
 * nothing in the record able to tell them apart.
 *
 * Two questions, and a record has to answer both:
 *
 * 1. **Was it checked HERE?** Cheap — a comparison of recorded facts. Runs
 *    anywhere, including on every read of the settings surface.
 * 2. **Was it checked against THIS binary?** Costs a subprocess, so it runs
 *    where an adapter is about to be used rather than on a polling read.
 *
 * Both answer `stale`, never `absent`. The difference matters: absent means
 * nobody has checked, and the surface says "connect this". Stale means somebody
 * checked something that is no longer what would run, and the surface says what
 * changed. Silently inheriting is the only answer that is never right.
 */

export interface MachineIdentity {
  /** The machine the probe ran on. */
  host: string;
  /** `win32`, `linux`, `darwin` — the argv is platform-shaped. */
  platform: string;
  /**
   * The harness home the probe ran against, when an account selects one.
   *
   * Null is a real value: it means the harness's own default home was used.
   * A record with null and a machine with an account selected are genuinely
   * different situations, which is why this is nullable rather than defaulted.
   */
  account_home: string | null;
}

export function currentMachine(accountHome: string | null): MachineIdentity {
  return {
    host: hostname(),
    platform: process.platform,
    account_home: accountHome
  };
}

export interface VerificationStanding {
  /** A reason string when the record no longer describes what would run. */
  stale: string | null;
}

/**
 * The cheap half: was this record made here?
 *
 * Deliberately conservative about what counts as a mismatch. A missing
 * `machine` block is a record written before this existed — it is reported, but
 * as "cannot tell", because treating every pre-existing record as foreign would
 * invalidate every verification this project has ever made in one release, and
 * an alarm that fires on everything is one nobody reads.
 */
export function machineStanding(
  recorded: Partial<MachineIdentity> | null | undefined,
  current: MachineIdentity
): VerificationStanding {
  if (recorded === null || recorded === undefined || typeof recorded.host !== "string") {
    return {
      stale: "This was checked before Hivemind recorded which machine it checked on, so it cannot tell whether the check was made here. Reconnect it to be sure."
    };
  }
  if (recorded.host !== current.host) {
    return {
      stale: `This was checked on ${recorded.host}, not on this machine. Reconnect it to check it here.`
    };
  }
  if (recorded.platform !== current.platform) {
    return {
      stale: `This was checked on ${recorded.platform} and this machine is ${current.platform}. Reconnect it to check it here.`
    };
  }
  if ((recorded.account_home ?? null) !== current.account_home) {
    return {
      stale: "This was checked against a different account home, so what it can do may differ. Reconnect it to check it here."
    };
  }
  return { stale: null };
}

/**
 * The costly half: is the binary still the one that was checked?
 *
 * `compareAdapterVersion` was built for exactly this and had no caller — it
 * existed, was unit-tested, and was imported by nothing but its own test. So
 * the check it implements has never run.
 *
 * That matters on ONE machine, not only across two. These harnesses update
 * themselves: `claude doctor` reports auto-updates enabled. A binary that
 * updates itself silently invalidates its own verdict, and nothing noticed.
 *
 * Advisory: it reports, and the caller decides. A version that moved is a
 * reason to re-check, not a reason to refuse work somebody asked for.
 */
export async function versionStanding(
  profile: AdapterProfile,
  recordedVersion: string | null,
  cwd: string
): Promise<VerificationStanding> {
  /* `readAdapterVersion` already derives the `--version` argv from the profile
     and reads it back; a second runner here would be a second place for the
     platform detail to be wrong. */
  const observed = await readAdapterVersion(profile.invoke, cwd);
  const check = compareAdapterVersion(recordedVersion, observed);
  /* `unknown` is not stale. Being unable to read a version is a gap in what
     Hivemind can see, not evidence that anything changed, and refusing a run
     over it would stop work for a reason nobody can act on. `stale` is the one
     that means the verdict no longer describes the binary. */
  return { stale: check.standing === "stale" ? check.detail : null };
}
