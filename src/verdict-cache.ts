import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import type { AdapterProbeResult } from "./adapter-probe.js";
import type { MachineIdentity } from "./verification-standing.js";

/**
 * A capability verdict, remembered for the MACHINE rather than the project.
 *
 * ## Why this is sound
 *
 * A probe measures one binary, one account, one machine. It does not measure a
 * project: the argv it runs is built from the catalogue, not from the
 * repository, and every capability it decides -- bypass flags, confinement,
 * model pinning, usage reporting, endpoint -- is a property of that binary
 * running as that account. So re-probing the same binary, same account, same
 * machine for a second project pays a real provider call to learn what is
 * already known. Setting up three providers on a new project cost three paid
 * calls and roughly a minute, per project, and that was the worst friction in
 * the product.
 *
 * What a probe genuinely cannot carry across is a CHANGE. So a cached verdict
 * is adopted only when every input that could change the answer is identical:
 *
 *   - the same agent entry (harness plus model)
 *   - the same binary VERSION, read for free with `--version`; these harnesses
 *     update themselves weekly
 *   - the same harness configuration digest -- the instruction files and
 *     settings any harness reads, which is what `configStanding` already
 *     watches on a per-project record
 *   - the same account home, because a different plan can change which models
 *     exist and whether usage is reported at all
 *   - the same machine, by the identity `machineStanding` already compares
 *
 * Any difference misses the cache and pays for a fresh probe. That is the same
 * staleness rule the per-project record already enforces, applied one scope up.
 *
 * ## How this stays apart from a verdict that arrived by clone
 *
 * Connection records are gitignored because a verdict measured on somebody
 * else's machine must never be inherited. This cache is a different object and
 * the separation is structural, not a convention:
 *
 *   - it lives OUTSIDE every repository, in the user's own state directory, so
 *     it is not in any working tree. It cannot be committed, cannot be cloned,
 *     and `git status` will never see it.
 *   - every entry stores the machine identity it was measured on, and adoption
 *     compares it. An entry that somehow arrived from elsewhere -- a synced
 *     home directory, a copied profile -- fails that comparison and is ignored.
 *   - the project's connection record still records the machine and the digest
 *     exactly as before, so every per-project staleness check keeps working on
 *     the record it always checked.
 *
 * ## Honesty
 *
 * An adopted verdict is not a fresh measurement and is not recorded as one.
 * `verdict_source` says where it came from and when the measurement actually
 * happened, so a surface can say "checked on this machine" rather than implying
 * this project paid for a probe it did not run.
 */

export interface CachedVerdict {
  /** Everything the contract decided, exactly as the probe returned it. */
  capabilities: AdapterProbeResult["capabilities"];
  effective_tokens: number;
  readback_source: string | null;
  provider_version: string | null;
  /** When the provider call that produced this actually happened. */
  measured_at: string;
  /** The machine it was measured on, compared before adoption. */
  machine: MachineIdentity;
  /** The harness configuration digest it was measured under. */
  config_digest: string | null;
}

export interface VerdictKeyInputs {
  agentId: string;
  harness: string;
  providerVersion: string | null;
  configDigest: string | null;
  machine: MachineIdentity;
}

interface VerdictFile {
  version: 1;
  verdicts: Record<string, CachedVerdict>;
}

/**
 * Where the cache lives: the user's own state directory, never a repository.
 *
 * Honoured in the order each platform expects, with the environment variable
 * first so a locked-down machine or a test can put it somewhere else without
 * this module knowing why.
 */
export function verdictCacheDirectory(): string {
  const explicit = process.env.HIVEMIND_STATE_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local !== undefined && local !== "") return path.join(local, "Hivemind");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Hivemind");
  }
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg !== undefined && xdg !== "") return path.join(xdg, "hivemind");
  return path.join(homedir(), ".local", "state", "hivemind");
}

function verdictFilePath(): string {
  return path.join(verdictCacheDirectory(), "capability-verdicts.json");
}

/**
 * The identity of a verdict: every input that could change the answer.
 *
 * Hashed rather than concatenated because an account home is a filesystem path
 * and paths are not safe as object keys. The inputs are kept in the VALUE too,
 * so a cache file can be read and understood without this function.
 */
export function verdictKey(inputs: VerdictKeyInputs): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        inputs.agentId,
        inputs.harness,
        inputs.providerVersion ?? "",
        inputs.configDigest ?? "",
        inputs.machine.host,
        inputs.machine.platform,
        inputs.machine.account_home ?? ""
      ])
    )
    .digest("hex")
    .slice(0, 32);
}

async function readVerdictFile(): Promise<VerdictFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(verdictFilePath(), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as VerdictFile).version === 1 &&
      typeof (parsed as VerdictFile).verdicts === "object"
    ) {
      return parsed as VerdictFile;
    }
  } catch {
    /* No cache, or one this version cannot read. Both mean "probe". */
  }
  return { version: 1, verdicts: {} };
}

/**
 * A verdict for these exact inputs, or null.
 *
 * The machine is compared again here rather than trusted from the key: the key
 * is a hash and a hash collision, however unlikely, must not be able to hand
 * back somebody else's measurement. Cheap, and it makes the guarantee local.
 */
export async function readCachedVerdict(
  inputs: VerdictKeyInputs
): Promise<CachedVerdict | null> {
  const file = await readVerdictFile();
  const entry = file.verdicts[verdictKey(inputs)];
  if (entry === undefined) return null;
  if (
    entry.machine.host !== inputs.machine.host ||
    entry.machine.platform !== inputs.machine.platform ||
    (entry.machine.account_home ?? null) !== (inputs.machine.account_home ?? null)
  ) {
    return null;
  }
  if ((entry.provider_version ?? null) !== (inputs.providerVersion ?? null)) return null;
  if ((entry.config_digest ?? null) !== (inputs.configDigest ?? null)) return null;
  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) return null;
  return entry;
}

/** Remember a verdict this machine just measured. Failure is never fatal. */
export async function writeCachedVerdict(
  inputs: VerdictKeyInputs,
  verdict: CachedVerdict
): Promise<void> {
  try {
    const file = await readVerdictFile();
    file.verdicts[verdictKey(inputs)] = verdict;
    /* Bounded: a machine accumulates one entry per (agent, version, digest,
       account) and versions churn weekly. Oldest measurements go first, so the
       file cannot grow without limit on a long-lived machine. */
    const entries = Object.entries(file.verdicts);
    if (entries.length > 64) {
      entries.sort((left, right) => right[1].measured_at.localeCompare(left[1].measured_at));
      file.verdicts = Object.fromEntries(entries.slice(0, 64));
    }
    await mkdir(verdictCacheDirectory(), { recursive: true });
    await writeJsonAtomic(verdictFilePath(), file);
  } catch {
    /* A cache that cannot be written costs a probe next time, which is the
       behaviour that existed before it. Never a reason to fail a connection. */
  }
}
