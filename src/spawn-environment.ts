import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  REFUSED_ENVIRONMENT,
  WINDOWS_PROVIDER_BIN_ENVIRONMENT,
  WINDOWS_PROVIDER_EXECUTABLE_LOCATIONS
} from "./agent-catalogue.js";

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
  return withProviderExecutablePath({ ...built, ...chosen });
}

/**
 * Add the vendor-owned user bin directories a desktop-launched Windows app
 * cannot reliably inherit.
 *
 * The existing PATH remains first: this is fallback discovery, not a way for
 * Hivemind to override the command a person already runs. Every added path is
 * either a documented per-user CLI install directory or the exact directory
 * containing Codex Desktop's bundled `codex.exe`. No repository path is ever
 * searched, and no executable is run during discovery.
 */
export function withProviderExecutablePath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;

  const result = { ...environment };
  const existingPathKey = Object.keys(result).find((name) => name.toUpperCase() === "PATH");
  const pathKey = existingPathKey ?? "PATH";
  const current = (result[pathKey] ?? "").split(";").filter(Boolean);
  const seen = new Set(current.map(normalizeWindowsDirectory));
  const append = (directory: string | undefined): void => {
    if (directory === undefined || !path.win32.isAbsolute(directory) || !existsSync(directory)) return;
    const normalized = normalizeWindowsDirectory(directory);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    current.push(directory);
  };

  const home = environment.USERPROFILE;
  const local = environment.LOCALAPPDATA;
  for (const location of WINDOWS_PROVIDER_BIN_ENVIRONMENT) {
    const base = environment[location.variable];
    append(base === undefined || location.suffix === undefined
      ? base
      : path.win32.join(base, ...location.suffix));
  }
  append(environment.NVM_SYMLINK);
  append(environment.PNPM_HOME);
  append(environment.BUN_INSTALL === undefined ? undefined : path.win32.join(environment.BUN_INSTALL, "bin"));
  append(environment.ChocolateyInstall === undefined ? undefined : path.win32.join(environment.ChocolateyInstall, "bin"));
  append(environment.APPDATA === undefined ? undefined : path.win32.join(environment.APPDATA, "npm"));
  append(home === undefined ? undefined : path.win32.join(home, "scoop", "shims"));
  append(home === undefined ? undefined : path.win32.join(home, "bin"));
  append(home === undefined ? undefined : path.win32.join(home, ".local", "bin"));
  append(local === undefined ? undefined : path.win32.join(local, "Microsoft", "WindowsApps"));

  for (const location of WINDOWS_PROVIDER_EXECUTABLE_LOCATIONS) {
    const root = location.root === "user" ? home : local;
    if (root === undefined) continue;
    const directory = path.win32.join(root, ...location.segments);
    if (location.nestedExecutable === undefined) append(directory);
    else {
      for (const nested of nestedExecutableDirectories(directory, location.nestedExecutable)) append(nested);
    }
  }

  if (existingPathKey !== undefined || current.length > 0) result[pathKey] = current.join(";");
  return result;
}

function nestedExecutableDirectories(root: string, executable: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.win32.join(root, entry.name))
      .filter((directory) => existsSync(path.win32.join(directory, executable)))
      .map((directory) => ({ directory, modified: statSync(path.win32.join(directory, executable)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified || left.directory.localeCompare(right.directory))
      .map((entry) => entry.directory);
  } catch {
    return [];
  }
}

function normalizeWindowsDirectory(directory: string): string {
  return path.win32.resolve(directory).replace(/[\\/]+$/u, "").toLowerCase();
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
