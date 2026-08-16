import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HARNESS_PROJECT_CONFIG } from "../src/agent-catalogue.js";
import { ensureHarnessProjectConfig } from "../src/harness-project-config.js";

const scratch = async (): Promise<string> =>
  await mkdtemp(path.join(tmpdir(), "hivemind-harness-config-"));

/* The gap, stated as a test rather than as a comment.
 *
 * `agent-catalogue.ts` claimed `project.init` wrote OpenCode's config. Nothing
 * did -- the filename appeared exactly twice in the repository, once in that
 * sentence and once in an unrelated table. Measured in the Hivemind repository
 * itself, `opencode agent list` resolved `* -> allow` with no rule at all for
 * `bash`, so the shell was permitted on every project Hivemind had set up. */
test("the harness whose denial lives in a file gets that file", async () => {
  const root = await scratch();
  const outcome = await ensureHarnessProjectConfig(root, "opencode");

  assert.equal(outcome.written, "opencode.json");
  assert.notEqual(outcome.because, null);

  const written = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8")) as {
    permission: Record<string, string>;
  };
  /* The two rules `readOpenCodePermissions` reads. Verified against opencode
     1.18.15: with this file present, `opencode agent list` resolves
     `bash -> deny` and `task -> deny`; without it, neither has a rule. */
  assert.equal(written.permission.bash, "deny");
  assert.equal(written.permission.task, "deny");
});

/* Same rule as the adapter profiles: a file that is already there is somebody's
   choice. Repairing it silently would edit a person's own OpenCode config on
   their behalf -- and the honest outcome is available anyway, because the probe
   reads the RESOLVED table and refuses when it finds no denial. */
test("an existing config is never rewritten", async () => {
  const root = await scratch();
  const mine = `${JSON.stringify({ permission: { bash: "allow" } }, null, 2)}\n`;
  await writeFile(path.join(root, "opencode.json"), mine, "utf8");

  const outcome = await ensureHarnessProjectConfig(root, "opencode");

  assert.equal(outcome.written, null);
  assert.equal(outcome.keptExisting, "opencode.json");
  assert.equal(await readFile(path.join(root, "opencode.json"), "utf8"), mine);
});

/* The harnesses that take their denial on the command line get nothing. A rule
   in a file somebody can edit is weaker than a rule in the argv, so this table
   is for harnesses that offer nothing stronger -- not for every harness. */
test("a harness that denies on the command line is left alone", async () => {
  const root = await scratch();
  for (const harness of ["codex-cli", "claude", "grok", "kimi", "not-a-harness"]) {
    const outcome = await ensureHarnessProjectConfig(root, harness);
    assert.equal(outcome.written, null, `${harness} should need no project file`);
    assert.equal(outcome.keptExisting, null);
  }
  assert.deepEqual(Object.keys(HARNESS_PROJECT_CONFIG), ["opencode"]);
});

/* The write is a side effect on somebody's source tree, so it has to be
   reportable. `.hivemind/` reached a git history because a first-run button
   wrote it and said nothing. */
test("the write carries a reason the connection can show", async () => {
  const root = await scratch();
  const outcome = await ensureHarnessProjectConfig(root, "opencode");
  assert.match(outcome.because ?? "", /shell denial|config/iu);
  assert.ok((outcome.because ?? "").length > 40, "a reason, not a label");
});
