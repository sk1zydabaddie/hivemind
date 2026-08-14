import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import {
  parseTaskTypePreferences,
  preferenceFor,
  providerCanBeChosenDeliberately,
  VISUAL_TASK_TYPES
} from "../src/routing-preferences.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

/* Choosing which agent handles which KIND of work.
 *
 * Three guardrails, and the tests are mostly about them rather than about the
 * happy path: the tier cap still binds, promotion is still how a LEARNED change
 * takes effect, and a provider that cannot prove it honours a model pin cannot
 * be aimed at deliberately.
 */

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "routing-preferences",
    async (repo) => {
      await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await execFileAsync("git", ["add", "."], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
      await initProject(repo);
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-routing-preferences-test-"
  );
}

async function writeConnection(
  repo: string,
  tool: string,
  pin: string | null,
  stale: string | null = null
): Promise<void> {
  const dir = path.join(repo, ".hivemind", "adapters");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${tool}.connection.json`),
    JSON.stringify({
      agent_id: `${tool}-agent`,
      capabilities: pin === null ? [] : [{ id: "pins_one_model", status: pin }],
      capabilities_stale: stale
    })
  );
}

test("a preference names a real kind of work, or it is refused", () => {
  assert.equal(parseTaskTypePreferences({ ui: { preference: "strongest" } }).ok, true);
  assert.equal(parseTaskTypePreferences({ ui: { tool: "worker" } }).ok, true);

  /* Refused rather than repaired: an unknown task type is a mistake worth
     surfacing, and silently dropping it would leave a person believing their
     choice took effect. */
  const unknown = parseTaskTypePreferences({ frontend: { preference: "strongest" } });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /unknown kind of work: frontend/u);

  const bad = parseTaskTypePreferences({ ui: { preference: "fastest" } });
  assert.equal(bad.ok, false);

  assert.equal(parseTaskTypePreferences([]).ok, false);
  /* Absent means absent -- not "the default preference". */
  const empty = parseTaskTypePreferences(undefined);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.value, {});

  /* An entry naming nothing is dropped rather than treated as an instruction. */
  const hollow = parseTaskTypePreferences({ ui: { tool: null, preference: null } });
  assert.equal(hollow.ok, true);
  if (hollow.ok) assert.equal(preferenceFor(hollow.value, "ui"), null);
});

test("a provider that cannot prove its model pin cannot be chosen deliberately", async () => {
  await withRepo(async (repo) => {
    /* The guard that makes the whole feature meaningful rather than theatre:
       picking "the strong model for visual work" is worthless if the harness
       cannot confirm which model it loaded. */
    await writeConnection(repo, "unverified", "unverified");
    const refused = await providerCanBeChosenDeliberately(repo, "unverified");
    assert.equal(refused.allowed, false);
    assert.match(refused.reason ?? "", /does not report which model/u);

    await writeConnection(repo, "good", "verified");
    const allowed = await providerCanBeChosenDeliberately(repo, "good");
    assert.equal(allowed.allowed, true);

    /* Probed, then the account changed. The verification no longer describes
       what would run, so it cannot support a deliberate choice either. */
    await writeConnection(repo, "switched", "verified", "account_changed");
    const stale = await providerCanBeChosenDeliberately(repo, "switched");
    assert.equal(stale.allowed, false);
    assert.match(stale.reason ?? "", /different account/u);

    /* Never connected at all. */
    const missing = await providerCanBeChosenDeliberately(repo, "nobody");
    assert.equal(missing.allowed, false);
    assert.match(missing.reason ?? "", /has not been checked/u);
  });
});

test("the tier cap binds before a preference is even consulted", async () => {
  /* Structural rather than a check somebody has to remember: the preference is
     applied to the pool AFTER tier filtering, so a provider the floor excluded
     is not in the list to be chosen. Asserted at the source because
     constructing a full multi-provider routing fixture would test the fixture
     more than the ordering. */
  const routing = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.resolve("src/routing.ts"), "utf8")
  );
  const eligibleAt = routing.indexOf("const eligible = candidates.filter");
  const preferenceAt = routing.indexOf("applyTaskTypePreference(repoRoot");
  assert.ok(eligibleAt > 0 && preferenceAt > 0);
  assert.ok(
    eligibleAt < preferenceAt,
    "the preference is applied before the tier floor narrows the pool"
  );
  /* And it receives the narrowed pool, not the raw candidate list. */
  assert.match(routing, /applyTaskTypePreference\(repoRoot, contract, config, pool\)/u);
});

test("a preference does not touch the promoted-policy path", async () => {
  const routing = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.resolve("src/routing.ts"), "utf8")
  );
  /* A person choosing a model is an explicit instruction; a system changing its
     own weights still needs promotion. Conflating them would let a preference
     launder itself as evidence. */
  assert.match(routing, /chooseWithPromotedPolicy/u);
  const preferences = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.resolve("src/routing-preferences.ts"), "utf8")
  );
  /* Comments stripped first. The prose in that module legitimately EXPLAINS
     that promotion is untouched, and banning the word would catch the sentence
     stating the rule -- this project's most-repeated trap. Code is what is
     constrained. */
  const preferenceCode = preferences
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(preferenceCode, /promot|learned_policy|routing\.observed/u);
});

test("the preference is writable through the audited action and validated there", async () => {
  await withRepo(async (repo) => {
    const ok = await executeWorkspaceAction(repo, {
      type: "config.set",
      payload: { task_type_routing: { ui: { preference: "strongest" } } }
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const value = ok.value as { config: { task_type_routing: Record<string, unknown> } };
      assert.deepEqual(value.config.task_type_routing, {
        ui: { tool: null, preference: "strongest" }
      });
    }

    const refused = await executeWorkspaceAction(repo, {
      type: "config.set",
      payload: { task_type_routing: { frontend: { preference: "strongest" } } }
    });
    assert.equal(refused.ok, false);
  });
});

test("visual work is a suggestion, and nothing applies it on its own", async () => {
  /* The argument, asserted so it cannot drift into a default: a default spends
     money nobody asked to spend, and the claim that visual work benefits most
     is unmeasured in this repository. Offered and declined costs nothing;
     applied silently, nobody learns whether it helped. */
  assert.ok(VISUAL_TASK_TYPES.includes("ui"));
  const preferences = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.resolve("src/routing-preferences.ts"), "utf8")
  );
  const code = preferences.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  /* No default map anywhere: the constant is a list of task types and a
     sentence, never a preapplied preference. */
  assert.doesNotMatch(code, /DEFAULT_PREFERENCES|defaultPreference|=\s*\{\s*ui:\s*\{/u);

  await withRepo(async (repo) => {
    /* A fresh project has no preference at all until someone sets one. */
    const inspected = await executeWorkspaceAction(repo, { type: "config.inspect", payload: {} });
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      const value = inspected.value as { config: { task_type_routing: Record<string, unknown> } };
      assert.deepEqual(value.config.task_type_routing, {});
    }
  });
});
