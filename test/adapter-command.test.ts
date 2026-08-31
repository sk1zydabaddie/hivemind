import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterCommandTarget,
  explainMissingAdapterProgram,
  resolveAdapterInvocation
} from "../src/adapter-command.js";

/**
 * The agent that works in a terminal and cannot be found from the desktop.
 *
 * `invoke[0]` is a bare name resolved against PATH, and a GUI launch does not
 * get the PATH a terminal does -- launchd hands a Finder-launched `.app` four
 * system directories, and a Linux `.desktop` launch inherits the session's.
 * Windows hides it entirely because Explorer passes the full user PATH, which
 * is why nothing has caught it yet.
 */

const POSIX = ["codex", "exec", "--model", "gpt-5.6-terra", "-"];
const WINDOWS = ["cmd.exe", "/d", "/s", "/c", "codex", "exec", "--model", "gpt-5.6-terra", "-"];

test("the program that has to exist is the agent, not the interpreter in front of it", () => {
  assert.deepEqual(adapterCommandTarget(POSIX), {
    index: 0,
    program: "codex",
    envVar: "HIVEMIND_CODEX_PATH"
  });

  /* Windows cannot spawn a .cmd directly, so element zero is cmd.exe and
     overriding it would replace the interpreter rather than the agent. */
  assert.deepEqual(adapterCommandTarget(WINDOWS), {
    index: 4,
    program: "codex",
    envVar: "HIVEMIND_CODEX_PATH"
  });
});

test("one variable covers an agent, not one spelling of it", () => {
  assert.equal(adapterCommandTarget(["codex"])?.envVar, "HIVEMIND_CODEX_PATH");
  assert.equal(adapterCommandTarget(["codex.cmd"])?.envVar, "HIVEMIND_CODEX_PATH");
  assert.equal(adapterCommandTarget(["codex.exe"])?.envVar, "HIVEMIND_CODEX_PATH");
  assert.equal(adapterCommandTarget(["claude"])?.envVar, "HIVEMIND_CLAUDE_PATH");
  assert.equal(adapterCommandTarget(["/opt/homebrew/bin/codex"])?.envVar, "HIVEMIND_CODEX_PATH");
  assert.equal(adapterCommandTarget(["open-code"])?.envVar, "HIVEMIND_OPEN_CODE_PATH");
  assert.equal(adapterCommandTarget([]), null);
});

test("an override replaces the agent and leaves every argument alone", () => {
  assert.deepEqual(resolveAdapterInvocation(POSIX, { HIVEMIND_CODEX_PATH: "/opt/homebrew/bin/codex" }), [
    "/opt/homebrew/bin/codex",
    "exec",
    "--model",
    "gpt-5.6-terra",
    "-"
  ]);

  assert.deepEqual(
    resolveAdapterInvocation(WINDOWS, { HIVEMIND_CODEX_PATH: "C:\\tools\\codex.cmd" }),
    ["cmd.exe", "/d", "/s", "/c", "C:\\tools\\codex.cmd", "exec", "--model", "gpt-5.6-terra", "-"]
  );
});

test("no override, or an empty one, changes nothing", () => {
  assert.deepEqual(resolveAdapterInvocation(POSIX, {}), POSIX);
  assert.deepEqual(resolveAdapterInvocation(POSIX, { HIVEMIND_CODEX_PATH: "   " }), POSIX);
  /* A variable for a different agent must not capture this one. */
  assert.deepEqual(resolveAdapterInvocation(POSIX, { HIVEMIND_CLAUDE_PATH: "/usr/bin/claude" }), POSIX);
});

test("the failure names the program, the reason, and the exact command that fixes it", () => {
  const message = explainMissingAdapterProgram(POSIX, "darwin");
  assert.notEqual(message, null);
  if (message === null) return;

  assert.match(message, /could not find codex/u);
  assert.match(message, /which codex/u, "the command that prints the value the hatch wants");
  assert.match(message, /HIVEMIND_CODEX_PATH/u);
  assert.match(message, /started without\s+your terminal's PATH|launched from the desktop/u);

  /* No internal vocabulary: this is read by someone who installed a coding
     agent, not by someone who knows what an adapter profile is. */
  for (const term of ["adapter", "invoke", "profile", "spawn", "ENOENT", "argv"]) {
    assert.equal(message.includes(term), false, `"${term}" does not belong in a message to a person`);
  }
});

test("Windows is told to run where rather than which", () => {
  const message = explainMissingAdapterProgram(WINDOWS, "win32");
  assert.notEqual(message, null);
  if (message === null) return;
  assert.match(message, /`where codex`/u);
  /* The command, not the relative pronoun the sentence around it uses. */
  assert.equal(message.includes("`which"), false);
});

/* CROSS-PLATFORM item 7 — the Linux half of the launcher-PATH question.
 *
 * A `.desktop` launcher runs its `Exec` line with the graphical session's
 * environment, which is set by the display manager and does NOT include what a
 * shell rc adds. nvm's node directory and a user-local `codex` both live there
 * and both disappear. It is the same exposure as a Finder-launched `.app`, on a
 * platform that is already here — which is why this item was flagged as the one
 * worth doing without any hardware.
 *
 * What can be settled without a desktop session is the half that matters most:
 * under a genuinely minimal PATH, does the failure explain itself, and does the
 * escape hatch actually resolve? Both are behavioural, and neither needs a GUI.
 *
 * What CANNOT be settled here is whether a real display manager hands the app a
 * minimal PATH in the first place. That still needs a machine with a desktop
 * environment, and CROSS-PLATFORM records it as still open.
 */
test("under a launcher-minimal PATH the failure names the program and the hatch resolves", async () => {
  /* The PATH a graphical session typically provides -- no /usr/local/bin, no
     nvm, no ~/.local/bin. Written out rather than mutating process.env, so the
     test says what it is simulating. */
  const LAUNCHER_PATH = process.platform === "win32"
    ? "C:\Windows\system32;C:\Windows"
    : "/usr/bin:/bin:/usr/sbin:/sbin";

  const invoke = ["definitely-not-installed-agent", "exec", "-"];

  /* 1. It explains itself. The message must name the program, say why a
        desktop launch differs from a terminal, and give the command that
        prints the value the variable wants -- a bare "not found" would send a
        person hunting a broken install that is not broken. */
  const explanation = explainMissingAdapterProgram(invoke);
  assert.ok(explanation !== null, "a missing program produced no explanation at all");
  assert.match(explanation, /definitely-not-installed-agent/u);
  assert.match(explanation, /HIVEMIND_DEFINITELY_NOT_INSTALLED_AGENT_PATH/u);

  /* 2. The hatch resolves. Given the variable, the invocation points at the
        absolute path and no longer depends on PATH at all. */
  const resolvedPath = process.platform === "win32" ? "C:\tools\agent.exe" : "/opt/agent/bin/agent";
  const resolved = resolveAdapterInvocation(invoke, {
    PATH: LAUNCHER_PATH,
    HIVEMIND_DEFINITELY_NOT_INSTALLED_AGENT_PATH: resolvedPath
  });
  assert.equal(resolved[0], resolvedPath, "the escape hatch did not reach the invocation");
  assert.deepEqual(resolved.slice(1), ["exec", "-"], "the hatch changed more than the program");

  /* 3. Without the hatch, nothing is silently substituted. The invocation is
        returned unchanged so the spawn fails on the real name, which is what
        makes the message above the thing a person sees. */
  const unresolved = resolveAdapterInvocation(invoke, { PATH: LAUNCHER_PATH });
  assert.deepEqual(unresolved, invoke, "a missing program was quietly rewritten");
});
