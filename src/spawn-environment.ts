import { REFUSED_ENVIRONMENT } from "./agent-catalogue.js";

export { REFUSED_ENVIRONMENT };

/**
 * The environment a worker is spawned with, chosen rather than inherited.
 *
 * ## What made this necessary
 *
 * `CLAUDE_CONFIG_DIR` relocates Claude Code's entire configuration directory —
 * settings, hooks, and credentials together. Measured: pointed at an empty
 * directory, the CLI answers "Not logged in · Please run /login", so it really
 * does move everything. A person who has that variable set in their shell, and
 * who starts Hivemind from that shell, gets workers running against a
 * configuration Hivemind never inspected — including a config digest computed
 * against one home and a run that happened in another.
 *
 * It is not hypothetical for the others either. The shell this was measured in
 * carried `CLAUDECODE=1`, `CLAUDE_EFFORT=high`, `CLAUDE_CODE_ENTRYPOINT`,
 * `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_EXECPATH` — because it was itself
 * inside a Claude Code session. Starting a desktop app from a terminal is
 * ordinary, and every one of those would have reached a worker.
 *
 * ## The rule, and why it is narrow
 *
 * **Remove control, never remove authentication.**
 *
 * Hivemind holds no provider credential and must not start behaving as though
 * it does. Stripping a variable a harness authenticates with would break the
 * one promise the product is built on — that whatever authentication each
 * harness uses stays with the harness. So the refusal list names variables that
 * RELOCATE or RECONFIGURE a harness, and anything that looks like a secret is
 * kept even if it matches, which is why `keepsAuthentication` exists.
 *
 * A blanket allowlist was the other option and is wrong here. A process needs
 * far more of the environment than it is comfortable to enumerate — `PATH`,
 * `SystemRoot`, `TEMP`, `APPDATA`, the loader variables, the locale — and
 * getting that list wrong does not fail loudly, it fails as `spawn ENOENT` on
 * somebody else's machine. Removing a known-dangerous few is the change whose
 * failure mode is visible.
 *
 * ## Hivemind's own choice still passes
 *
 * The three home variables are exactly the ones account switching SETS
 * deliberately (`ACCOUNT_HOME_VARIABLES`). Dropping the inherited value and
 * then applying the chosen one is the whole point: the account a role runs as
 * is a decision recorded in the project, not a leftover in somebody's shell.
 */

/**
 * Whether a variable is something a harness signs in with.
 *
 * Deliberately generous. A false positive here keeps a control variable that
 * should have been dropped, which is a gap; a false negative strips somebody's
 * credential and breaks their agent with an error that points nowhere. Between
 * a gap and a broken sign-in, the gap is recoverable.
 */
export function keepsAuthentication(name: string): boolean {
  return /KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH/iu.test(name);
}

/**
 * The environment to spawn with.
 *
 * `chosen` is applied last and wins — it is Hivemind's own decision about which
 * account a role runs as, and it is the reason the home variables are on the
 * refusal list at all.
 */
export function spawnEnvironment(
  inherited: NodeJS.ProcessEnv,
  chosen: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const refused = new Set(REFUSED_ENVIRONMENT);
  const built: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (refused.has(name) && !keepsAuthentication(name)) continue;
    built[name] = value;
  }
  return { ...built, ...chosen };
}

/**
 * What was dropped, so a connection can say so.
 *
 * Silently changing somebody's environment is the same class of surprise as
 * silently writing a file into their repository. If a variable they set is
 * being ignored, that is a fact about their machine they are entitled to.
 */
export function refusedEnvironmentNames(inherited: NodeJS.ProcessEnv): string[] {
  return REFUSED_ENVIRONMENT.filter(
    (name) => inherited[name] !== undefined && !keepsAuthentication(name)
  ).sort();
}
