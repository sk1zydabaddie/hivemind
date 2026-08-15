import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { plainConnectionProblem } from "../src/components/workspace/setup-screen";
import { PROJECT_FAULT, projectFaultFrom } from "../src/lib/project-session";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* What a person who has never used this sees, and what they are told to do.
 *
 * Every assertion here comes from walking a cold open rather than from reading
 * the code, which is why they are worth having: each one is a place somebody
 * following the on-screen instructions correctly stopped. */
describe("cold open", () => {
  /* The rule, mechanised. Three earlier instances of "control flow depends on
     message text" were recorded in docs/STATE.md before this fourth one was
     WRITTEN -- so writing the rule down demonstrably did not prevent it. What
     prevents it is a test that fails when a branch reads prose. */
  test("what to offer is decided by a code, never by the message", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    const branch = source.slice(source.indexOf("export function plainConnectionProblem"));

    /* The one permitted read of `detail` is the emptiness check that decides
       whether there is anything at all to show. No regex, no substring, no
       comparison against a sentence. */
    expect(branch).not.toMatch(/detail\s*\.(?:includes|match|startsWith|indexOf)/u);
    expect(branch).not.toMatch(/\/[^/\n]*\/[iu]*\.test\(\s*detail/u);
    expect(branch).toMatch(/code === PROJECT_FAULT\./u);
  });

  /* The exact string the shell produces, against the branch that is supposed to
     catch it. This is the failure: `/not a git repository|git root/` never
     matched "not INSIDE a git repository", so the button offering to start
     tracking a folder was unreachable from the day it was written -- and the
     commonest first-run case there is (somebody who has been editing a folder
     without git) fell through to a generic error with no way forward. */
  test("an untracked folder is offered the step, not a generic failure", () => {
    const shellSays = "selected directory is not inside a git repository";
    expect(/not a git repository|git root/iu.test(shellSays)).toBe(false);

    const problem = plainConnectionProblem(PROJECT_FAULT.notAGitRepository, shellSays);
    expect(problem?.action).toBe("git");
    expect(problem?.title).toMatch(/not tracked by git/iu);
  });

  test("each failure a person can act on offers its action", () => {
    expect(plainConnectionProblem(PROJECT_FAULT.noProjectSelected, "")?.action).toBe("choose");
    expect(plainConnectionProblem(PROJECT_FAULT.notInitialized, "")?.action).toBe("initialize");
    expect(plainConnectionProblem(PROJECT_FAULT.daemonUnavailable, "")?.action).toBeUndefined();
    /* Unknown offers nothing rather than guessing. A wrong button is worse. */
    expect(plainConnectionProblem(PROJECT_FAULT.unknown, "something odd")?.action).toBeUndefined();
    /* Connected: no problem at all. */
    expect(plainConnectionProblem("", "")).toBeNull();
  });

  test("a fault without a code is unknown rather than guessed", () => {
    expect(projectFaultFrom({ code: "not_a_git_repository", message: "x" }).code).toBe(
      PROJECT_FAULT.notAGitRepository
    );
    expect(projectFaultFrom(new Error("no code here")).code).toBe(PROJECT_FAULT.unknown);
    expect(projectFaultFrom("a bare string").code).toBe(PROJECT_FAULT.unknown);
  });

  /* The app opened `"."` on launch. For an installed build that is the process
     working directory, which the Start menu shortcut sets to the INSTALLATION
     directory -- so a brand-new install's first act was to try to open Hivemind
     itself as a project. */
  test("nothing is opened until a project is chosen", async () => {
    const source = await readFile(path.join(desktopRoot, "src", "hooks", "use-workspace.ts"), "utf8");
    expect(source).not.toMatch(/get\("project"\)\s*\?\?\s*"\."/u);
    expect(source).toMatch(/recent_projects/u);
  });

  /* Step 2 claimed setup wrote the agent profiles. Core deliberately writes
     none, and says why in its own comment: a profile written by setup is a
     declaration no probe has checked. So the screen told a new person that the
     one step they had to take themselves -- the only one that costs money --
     was already done for them. */
  test("the setup screen does not claim that setup connects an agent", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    const rendered = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(rendered).not.toMatch(/Setting up the folder writes these/iu);
    expect(rendered).not.toMatch(/Setting up the folder does all three/iu);
    /* And it connects here rather than sending somebody to find the gear. */
    expect(rendered).toMatch(/adapter\.connect/u);
  });

  /* Per-role cost is disclosed next to each button, which is only ever read by
     somebody already committed to clicking that button. The total has to be
     visible before any of them is. */
  test("the total cost of connecting is stated before anything is clicked", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    expect(source).toMatch(/TOKENS_PER_CONNECT \* REQUIRED_ROLES\.length/u);
    expect(source).toMatch(/Nothing\s*\n?\s*is spent until you click|Nothing is spent until you click/u);
  });

  /* Found by walking the rebuilt screen, not by reading it. `connectable` means
     "Hivemind knows how to start this", NOT "you have it" — so the first walk
     offered Grok Build, which needs an account nobody has, as a button
     indistinguishable from the agent that actually works. */
  test("an unverified agent does not look like a verified one", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    expect(source).toMatch(/agent\.status === "supported"/u);
    expect(source).toMatch(/Not verified yet/u);
    /* And the reason is shown rather than found by clicking. */
    expect(source).toMatch(/agent\.caveat/u);
  });

  /* A disabled control that does not say what it is waiting for is
     indistinguishable from a broken one. */
  test("a step that is waiting says what it is waiting for", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "setup-screen.tsx"),
      "utf8"
    );
    expect(source).toMatch(/Waiting on step 2/u);
  });
});
