import path from "node:path";

/**
 * Finding the coding agent, and saying so when it cannot be found.
 *
 * Hivemind runs your agent as a program. `invoke[0]` is a bare name -- `codex`
 * -- which means the operating system resolves it against `PATH`, and `PATH`
 * is not the same everywhere the app can be started from.
 *
 * A terminal gets your shell's `PATH`, including whatever npm, Homebrew or nvm
 * added. A GUI launch does not. Windows hides this completely, because Explorer
 * hands GUI processes the full user `PATH` from the registry; macOS launchd
 * gives a Finder-launched `.app` four system directories and nothing else, and
 * a Linux `.desktop` launch inherits whatever the session manager had. So the
 * agent that works when you test it from a terminal is exactly the agent that
 * cannot be found when a person double-clicks the icon.
 *
 * `node` already had an escape hatch on the shell side (`HIVEMIND_NODE_PATH`).
 * The agent had none, and it is the one that matters: without it the failure is
 * `spawn codex ENOENT`, which tells a person nothing they can act on.
 */

/** Which element of `invoke` is the program that actually has to exist. */
export interface AdapterCommandTarget {
  /** Index into `invoke`. */
  index: number;
  /** The program as written, e.g. `codex` or `codex.cmd`. */
  program: string;
  /** The environment variable that overrides it, e.g. `HIVEMIND_CODEX_PATH`. */
  envVar: string;
}

/**
 * `invoke[0]` is the program, except on Windows where it is `cmd.exe`.
 *
 * Windows cannot spawn a `.cmd` directly, so every generated Windows profile
 * reads `["cmd.exe", "/d", "/s", "/c", "codex.cmd", …]`. Overriding element
 * zero there would replace the interpreter rather than the agent, so the
 * element after the `/c` is the one that counts.
 */
export function adapterCommandTarget(invoke: string[]): AdapterCommandTarget | null {
  if (invoke.length === 0) return null;

  let index = 0;
  if (isCommandInterpreter(invoke[0]!)) {
    const flagIndex = invoke.findIndex((argument) => /^[/-]c$/iu.test(argument));
    if (flagIndex === -1 || flagIndex + 1 >= invoke.length) return null;
    index = flagIndex + 1;
  }

  const program = invoke[index]!;
  return { index, program, envVar: overrideEnvVar(program) };
}

/**
 * `HIVEMIND_CODEX_PATH`, derived rather than listed.
 *
 * A hardcoded table would need editing every time a harness is added, and
 * would be wrong for anyone running an agent this build has never heard of.
 * The extension is dropped so one variable covers `codex` and `codex.cmd` --
 * a person setting this has one agent in mind, not one spelling of it.
 */
function overrideEnvVar(program: string): string {
  const base = path.basename(program).replace(/\.(cmd|bat|exe|ps1)$/iu, "");
  return `HIVEMIND_${base.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_PATH`;
}

/**
 * The argv to actually spawn, with an override applied if one is set.
 *
 * An override is used verbatim. Validating that it exists here would mean a
 * `stat` before every adapter call for a check the spawn itself performs, and
 * a wrong override produces the same ENOENT the diagnosis below explains.
 */
export function resolveAdapterInvocation(
  invoke: string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const target = adapterCommandTarget(invoke);
  if (target === null) return invoke;
  const override = env[target.envVar];
  if (override === undefined || override.trim() === "") return invoke;
  const resolved = [...invoke];
  resolved[target.index] = override.trim();
  return resolved;
}

/**
 * What to say when the agent could not be started.
 *
 * Written for the person who installed a coding agent, watched it work in a
 * terminal, and is now looking at a desktop app that says it cannot find it.
 * It names the program, says why the two contexts differ, and gives the exact
 * command that produces the value the escape hatch wants.
 */
export function explainMissingAdapterProgram(invoke: string[], platform: NodeJS.Platform = process.platform): string | null {
  const target = adapterCommandTarget(invoke);
  if (target === null) return null;
  const which = platform === "win32" ? `where ${target.program}` : `which ${target.program}`;
  return (
    `We could not find ${target.program} on this computer's PATH, so there is no coding agent to run. ` +
    `If ${target.program} works when you type it in a terminal but not here, the app was started without ` +
    `your terminal's PATH, which is normal for an app launched from the desktop. Run \`${which}\` in a ` +
    `terminal, then set ${target.envVar} to the full path it prints and start Hivemind again.`
  );
}

function isCommandInterpreter(program: string): boolean {
  const base = path.basename(program).toLowerCase();
  return base === "cmd" || base === "cmd.exe";
}
