import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveAdapterInvocation } from "./adapter-command.js";
import { spawnEnvironment } from "./spawn-environment.js";

const execFileAsync = promisify(execFile);

/**
 * A verification is a fact about the version that was verified.
 *
 * Every one of these harnesses ships weekly and updates itself. `claude doctor`
 * on this machine reports "Auto-updates: enabled", so a capability confirmed on
 * Monday is being relied on by a different binary on Friday. That is not
 * hypothetical and it is not something the person did — it happened while
 * nobody was looking.
 *
 * The rule: a connection records the provider version it verified, and a run
 * against a different version is **stale**, not invalid. Stale means the person
 * is asked to reconnect; it never means Hivemind quietly proceeds against
 * capabilities nobody has checked on the binary that is actually there.
 *
 * Stale rather than invalid because an update is the normal case and the
 * remedy is one click. Refusing outright would train people to ignore it, and
 * proceeding silently is the failure this whole contract exists to prevent.
 */

export type VersionStanding =
  /** The binary reports the version this connection was verified against. */
  | "current"
  /** It reports a different version. Nothing verified here has been rechecked. */
  | "stale"
  /** The version could not be read, so staleness cannot be decided either way. */
  | "unknown";

export interface VersionCheck {
  standing: VersionStanding;
  verified: string | null;
  observed: string | null;
  /** One sentence for the person, naming the remedy where there is one. */
  detail: string;
}

/**
 * The argv that asks a harness its version, derived from the argv that runs it.
 *
 * Deliberately derived rather than configured: a second place to write down how
 * to start an agent is a second place for it to be wrong, and this has to work
 * for a harness nobody has written a record for. It takes the program the
 * profile already resolved -- including the `cmd.exe /c` prefix Windows needs --
 * and replaces the arguments with `--version`.
 */
export function versionInvocation(invoke: string[]): string[] | null {
  if (invoke.length === 0) return null;
  const interpreter = /^(?:.*[\\/])?cmd(?:\.exe)?$/iu.test(invoke[0]!);
  if (!interpreter) return [invoke[0]!, "--version"];
  const flag = invoke.findIndex((argument) => /^[/-]c$/iu.test(argument));
  if (flag === -1 || flag + 1 >= invoke.length) return null;
  return [...invoke.slice(0, flag + 2), "--version"];
}

/**
 * Whatever a harness prints for `--version`, reduced to something comparable.
 *
 * Not parsed into semver, because these five print five different things --
 * `codex-cli 0.147.0`, `2.1.229 (Claude Code)`, a bare `1.18.15`. Any parser
 * would be a fourth place provider knowledge lives. The whole trimmed first
 * line is the identity, compared for equality; a harness that changes how it
 * prints its version reads as an update, which is the safe way to be wrong.
 */
export function normalizeVersionOutput(output: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return line === undefined ? null : line.slice(0, 200);
}

export async function readAdapterVersion(
  invoke: string[],
  cwd: string,
  timeoutMs = 20_000
): Promise<string | null> {
  const environment = spawnEnvironment(process.env);
  const argv = versionInvocation(resolveAdapterInvocation(invoke, environment));
  if (argv === null) return null;
  try {
    const result = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: environment
    });
    return normalizeVersionOutput(`${result.stdout}\n${result.stderr}`);
  } catch (error: unknown) {
    /* A harness that fails `--version` has told us nothing about its version.
       That is `unknown`, not `current`: silence is never reassurance. */
    const stdout = isExecOutput(error) ? `${error.stdout ?? ""}\n${error.stderr ?? ""}` : "";
    return normalizeVersionOutput(stdout);
  }
}

export function compareAdapterVersion(
  verified: string | null,
  observed: string | null
): VersionCheck {
  if (verified === null) {
    return {
      standing: "unknown",
      verified,
      observed,
      detail:
        "This agent was connected before Hivemind started recording which version it checked. Reconnect it to record one."
    };
  }
  if (observed === null) {
    return {
      standing: "unknown",
      verified,
      observed,
      detail: "Hivemind could not read this agent's version, so it cannot tell whether it has changed since it was checked."
    };
  }
  if (observed === verified) {
    return {
      standing: "current",
      verified,
      observed,
      detail: `Checked against ${verified}, which is what is installed.`
    };
  }
  return {
    standing: "stale",
    verified,
    observed,
    detail: `This agent has updated since Hivemind checked it — ${verified} became ${observed}. Reconnect it to check the version you now have.`
  };
}

function isExecOutput(value: unknown): value is { stdout?: string; stderr?: string } {
  return typeof value === "object" && value !== null;
}
