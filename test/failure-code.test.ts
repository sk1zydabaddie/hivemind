import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { codedFailure, failureCodes, hasFailureCode } from "../src/failure-code.js";
import { loadIntegrationQueue } from "../src/integration-state.js";
import { loadTentativePlan } from "../src/plan.js";
import { readActiveSpec } from "../src/spec.js";

/**
 * INVARIANT: control flow must never depend on the text of a message. A reason
 * is for humans; a code is for code. Rewording an error must be a copy change,
 * never a behaviour change.
 *
 * The load-bearing tests here are the REWORDING ones. Everything else checks
 * that a code is produced; only those prove the coupling is gone, and only
 * those would have caught the original class.
 */

test("hasFailureCode fails closed: no code and a different code are both no match", () => {
  assert.equal(hasFailureCode({ ok: false }, "no_active_spec"), false);
  assert.equal(
    hasFailureCode({ ok: false, code: "tentative_plan_not_found" }, "no_active_spec"),
    false
  );
  assert.equal(hasFailureCode({ ok: false, code: "no_active_spec" }, "no_active_spec"), true);
  // A success is never a failure match, whatever it carries.
  assert.equal(hasFailureCode({ ok: true }, "no_active_spec"), false);
});

test("codedFailure carries both halves", () => {
  const failure = codedFailure("no_active_spec", "some human sentence");
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "no_active_spec");
  assert.equal(failure.reason, "some human sentence");
  assert.deepEqual([...failureCodes].sort(), [
    "integration_queue_not_found",
    "no_active_spec",
    "tentative_plan_not_found"
  ]);
});

test("a missing tentative plan is reported by code, not by its sentence", async () => {
  await withRepo(async (repo) => {
    const missing = await loadTentativePlan(repo, "S-001");
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, "tentative_plan_not_found");
  });
});

test("a malformed tentative plan carries NO code, so no caller can mistake it for absent", async () => {
  await withRepo(async (repo) => {
    // This is the distinction the fail-open destroyed: "there is no plan" and
    // "the plan is broken" must never be the same answer.
    const planDir = path.join(repo, ".hivemind", "plans");
    await mkdir(planDir, { recursive: true });
    await writeFile(path.join(planDir, "S-001.tentative.json"), "{ not json", "utf8");

    const broken = await loadTentativePlan(repo, "S-001");

    assert.equal(broken.ok, false);
    if (broken.ok) return;
    assert.equal(broken.code, undefined);
    assert.equal(hasFailureCode(broken, "tentative_plan_not_found"), false);
  });
});

test("a missing active spec and a missing integration queue are reported by code", async () => {
  await withRepo(async (repo) => {
    const spec = await readActiveSpec(repo);
    assert.equal(spec.ok, false);
    if (!spec.ok) assert.equal(spec.code, "no_active_spec");

    const queue = await loadIntegrationQueue(repo);
    assert.equal(queue.ok, false);
    if (!queue.ok) assert.equal(queue.code, "integration_queue_not_found");
  });
});

/* ---------------------------------------------------------------------------
 * The regression that proves the coupling is gone.
 *
 * Each of these rewrites the human sentence in the compiled producer and
 * asserts the branch still goes the same way. Under the old code every one of
 * them would have flipped a decision -- a fail-open silently disabled, or a
 * missing file suddenly reported as a hard error.
 * ------------------------------------------------------------------------ */

test("rewording a producer's message does not change any consumer's branch", async () => {
  await withRepo(async (repo) => {
    const before = {
      plan: await loadTentativePlan(repo, "S-001"),
      spec: await readActiveSpec(repo),
      queue: await loadIntegrationQueue(repo)
    };
    assert.equal(before.plan.ok, false);
    assert.equal(before.spec.ok, false);
    assert.equal(before.queue.ok, false);

    // Reword a private COPY of the compiled tree rather than the real one.
    // The test runner runs files in parallel, so mutating shared modules --
    // even briefly -- could hand a sibling test a half-rewritten module.
    const copyRoot = await mkdtemp(path.join(tmpdir(), "hivemind-reword-"));
    try {
      await cp(path.resolve("dist/src"), copyRoot, { recursive: true });

      // Every consumer used to key on one of these exact phrases.
      const rewordings = [
        ["plan.js", "tentative plan not found: ", "no plan has been drafted yet for "],
        ["spec.js", "no active spec; create and ratify a spec", "nothing is selected; pick a spec"],
        ["integration-state.js", "integration queue not found: ", "nothing is queued for integration: "]
      ] as const;
      for (const [file, from, to] of rewordings) {
        const full = path.join(copyRoot, file);
        const source = await readFile(full, "utf8");
        assert.ok(source.includes(from), `${file} no longer contains the phrase being reworded: ${from}`);
        await writeFile(full, source.replaceAll(from, to), "utf8");
      }

      const moduleUrl = (file: string) => `file://${path.join(copyRoot, file).replaceAll("\\", "/")}`;
      const plan = await import(moduleUrl("plan.js"));
      const spec = await import(moduleUrl("spec.js"));
      const queue = await import(moduleUrl("integration-state.js"));

      const after = {
        plan: await plan.loadTentativePlan(repo, "S-001"),
        spec: await spec.readActiveSpec(repo),
        queue: await queue.loadIntegrationQueue(repo)
      };

      // The sentences really did change...
      assert.notEqual(after.plan.reason, before.plan.ok ? undefined : before.plan.reason);
      assert.notEqual(after.spec.reason, before.spec.ok ? undefined : before.spec.reason);
      assert.notEqual(after.queue.reason, before.queue.ok ? undefined : before.queue.reason);
      assert.match(after.plan.reason, /no plan has been drafted yet/u);

      // ...and every decision is identical, because decisions read the code.
      // Under the old string matching each of these would have flipped: a
      // fail-open silently disabled, or a missing file reported as a hard
      // error.
      assert.equal(hasFailureCode(after.plan, "tentative_plan_not_found"), true);
      assert.equal(hasFailureCode(after.spec, "no_active_spec"), true);
      assert.equal(hasFailureCode(after.queue, "integration_queue_not_found"), true);
    } finally {
      await rm(copyRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-failure-code-"));
  try {
    await mkdir(path.join(repo, ".hivemind"), { recursive: true });
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}
