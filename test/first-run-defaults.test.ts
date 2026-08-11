import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadConfig, DEFAULT_RUN_TOKEN_CEILING, DEFAULT_SESSION_TOKEN_CEILING } from "../src/config.js";
import { initProject } from "../src/init.js";
import { MEASURED_WORST_SINGLE_CALL_TOKENS } from "../src/project-defaults.js";
import { routeTaskProvider } from "../src/routing.js";
import type { TaskContract } from "../src/contract.js";

const execFileAsync = promisify(execFile);

/**
 * A fresh project's defaults have to work *together*.
 *
 * They did not. Tier globs were written correctly and only strong-tier profiles
 * existed, so every task ran on the flagship; and the run ceiling was 150,000
 * while one flagship worker call cost 152,229. Each number was defensible on its
 * own. Together they guaranteed that a first run stopped on quota *after* the
 * work was done and the money was spent.
 *
 * So these assert the pairing rather than the values. Changing a ceiling or a
 * provider is allowed; changing them into a combination that cannot complete a
 * one-task run is not.
 */

test("the default ceiling clears the worst call the default configuration can make", () => {
  /* The trap, stated as a property. Not "the ceiling is 300,000" -- that number
     may move -- but "a default run can afford its own most expensive call". */
  assert.ok(
    DEFAULT_RUN_TOKEN_CEILING > MEASURED_WORST_SINGLE_CALL_TOKENS,
    `run ceiling ${DEFAULT_RUN_TOKEN_CEILING} must exceed the worst measured single call ${MEASURED_WORST_SINGLE_CALL_TOKENS}`
  );
  // With enough room that a call running longer than the measured one still fits.
  assert.ok(
    DEFAULT_RUN_TOKEN_CEILING >= Math.ceil(MEASURED_WORST_SINGLE_CALL_TOKENS * 1.5),
    "a run ceiling with no headroom is a trap waiting for a slightly longer call"
  );
  /* And a session has to hold a real run: drafting, planning, and several
     workers, plus the revisions a normal run makes. */
  assert.ok(
    DEFAULT_SESSION_TOKEN_CEILING >= DEFAULT_RUN_TOKEN_CEILING * 5,
    "a session ceiling must hold a multi-task run, not one call"
  );
});

test("a fresh project has somewhere for every tier to land", async () => {
  await withFreshProject(async (repo) => {
    const profiles = (await readdir(path.join(repo, ".hivemind", "adapters")))
      .filter((name) => name.endsWith(".profile.json"));
    const tiers = new Set<string>();
    for (const name of profiles) {
      const profile = JSON.parse(
        await readFile(path.join(repo, ".hivemind", "adapters", name), "utf8")
      ) as { routing_tier?: string; roles?: string[]; invoke?: string[] };
      if (profile.roles?.includes("worker")) tiers.add(String(profile.routing_tier));

      // Same discipline as the profiles that were already there.
      const invoke = (profile.invoke ?? []).join(" ");
      assert.match(invoke, /--model \S+/u, `${name} must pin an exact model`);
      assert.match(invoke, /--sandbox workspace-write/u, `${name} must stay inside the project`);
      assert.doesNotMatch(invoke, /ultra|--dangerously|--yolo|bypass/iu, `${name} carries a bypass flag`);
    }

    /* The floor for Medium is standard and for High is strong. A project with
       only strong profiles computes the right tier and then has nothing cheaper
       to route to, which is how every task ended up on the flagship. */
    assert.ok(tiers.has("standard"), "a fresh project needs a standard-tier worker");
    assert.ok(tiers.has("cheap"), "a fresh project needs a cheap-tier worker");
    assert.ok(tiers.has("strong"), "a fresh project still needs a strong-tier worker");
  });
});

test("a fresh project routes ordinary work below the flagship", async () => {
  await withFreshProject(async (repo) => {
    const config = await loadConfig(repo);
    assert.equal(config.ok, true);
    if (!config.ok) return;

    const contract = (files: string[]): TaskContract =>
      ({
        task_id: "T-001",
        title: "fixture",
        agent_role: "builder",
        base_commit: "0".repeat(40),
        allowed_files: files,
        read_only_files: [],
        forbidden_files: [],
        must_not_change: [],
        acceptance_criterion: "npm test passes",
        required_tests: ["npm test"],
        deterministic_validity_check: null,
        patch_requirements: [],
        depends_on: [],
        routing_task_type: "feature"
      }) as unknown as TaskContract;

    const source = await routeTaskProvider(repo, contract(["src/thing.js"]), config.config);
    assert.equal(source.ok, true);
    if (source.ok) {
      assert.equal(source.value.task_tier, "medium");
      assert.notEqual(
        source.value.tool,
        "worker",
        "ordinary source work must not fall through to the last-resort flagship worker"
      );
    }

    const docs = await routeTaskProvider(repo, contract(["README.md"]), config.config);
    assert.equal(docs.ok, true);
    if (docs.ok) assert.equal(docs.value.task_tier, "low");

    // The floor still holds where it should.
    const critical = await routeTaskProvider(repo, contract([".github/deploy.yml"]), config.config);
    assert.equal(critical.ok, true);
    if (critical.ok) assert.equal(critical.value.task_tier, "critical");
  });
});

async function withFreshProject(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-defaults-")));
  try {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
    await git(["init"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await initProject(repo);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}
