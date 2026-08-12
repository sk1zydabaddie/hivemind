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
const WINDOWS = ["cmd.exe", "/d", "/s", "/c", "codex.cmd", "exec", "--model", "gpt-5.6-terra", "-"];

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
    program: "codex.cmd",
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
  assert.match(message, /`where codex\.cmd`/u);
  /* The command, not the relative pronoun the sentence around it uses. */
  assert.equal(message.includes("`which"), false);
});
