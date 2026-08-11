import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { adoptVerifiedSet, inspectLatestAdoptionReadiness, reconcileAdoptionsOnStartup, reviewVerifiedSetAdoption } from "../src/adoption.js";
import { createDaemonServer } from "../src/daemon.js";
import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { captureIntegrationQueueExpectation, enqueueIntegrationPatch, integrateShadow } from "../src/integrate.js";
import { loadIntegrationQueue } from "../src/integration-state.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { inspectWorkspace } from "../src/workspace-inspection.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("one exact reviewed verification set advances the base once and retains both refs", async () => {
  await withAdoptionFixture(async ({ repo, baseCommit, verificationId }) => {
    const integrationPassed = [...await requireEvents(repo)].reverse().find((event) => event.type === "integration.passed");
    assert.equal(integrationPassed?.data.verification_id, verificationId);
    const manifestPath = String(integrationPassed?.data.verification_manifest_path);
    const manifest = JSON.parse(await readFile(path.join(repo, manifestPath), "utf8"));
    assert.equal(manifest.verification_id, verificationId);
    assert.equal(manifest.base_commit, baseCommit);
    assert.deepEqual(manifest.task_ids, ["T-001"]);
    assert.match(manifest.config_sha256, /^[a-f0-9]{64}$/u);
    assert.match(manifest.inputs[0].contract_sha256, /^[a-f0-9]{64}$/u);
    assert.match(manifest.inputs[0].patch_sha256, /^[a-f0-9]{64}$/u);
    assert.match(manifest.result_tree, /^[a-f0-9]{40,64}$/u);
    assert.equal(manifest.verification.tests, "pass");
    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), baseCommit);

    const awaitingReview = await inspectWorkspace(repo);
    assert.equal(awaitingReview.ok, true, awaitingReview.ok ? undefined : awaitingReview.reason);
    if (!awaitingReview.ok) return;
    const changeSet = awaitingReview.value.needs_you.find((item) => item.kind === "adoption_ready")?.change_set;
    assert.deepEqual(changeSet, {
      verification_id: verificationId,
      base_branch: manifest.base_branch,
      task_ids: ["T-001"],
      changed_files: ["README.md"]
    });

    const review = await reviewVerifiedSetAdoption(repo, verificationId);
    assert.equal(review.ok, true, review.ok ? undefined : review.reason);
    if (!review.ok) return;

    const adopted = await adoptVerifiedSet(repo, review.value);
    assert.equal(adopted.ok, true, adopted.ok ? undefined : adopted.reason);
    if (!adopted.ok) return;
    assert.equal(adopted.value.pre_adoption_ref, baseCommit);
    assert.equal(adopted.value.adopted_ref, await gitStdout(repo, ["rev-parse", "HEAD"]));
    assert.notEqual(adopted.value.adopted_ref, baseCommit);
    assert.match(await readFile(path.join(repo, "README.md"), "utf8"), /adopted change/u);
    assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8")), {});

    const events = await requireEvents(repo);
    const completed = [...events].reverse().find((event) => event.type === "adoption.completed");
    assert.equal(completed?.data.pre_adoption_ref, baseCommit);
    assert.equal(completed?.data.adopted_ref, adopted.value.adopted_ref);
    assert.deepEqual(completed?.data.recoverability, {
      pre_adoption_ref: baseCommit,
      adopted_ref: adopted.value.adopted_ref,
      automatic_rollback: false
    });
    /* The trail has to be able to rebuild what shipped, not merely attest that
       something did. Without this the record proves a commit landed but cannot
       say which files it carried, and the shipped card read "0 files changed"
       over a commit that changed eight. */
    const changedFiles = completed?.data.changed_files;
    assert.ok(Array.isArray(changedFiles), "adoption.completed must record what it changed");
    assert.deepEqual(changedFiles, review.value.changed_files);
    assert.ok((changedFiles as string[]).length > 0);
    const started = [...events].reverse().find((event) => event.type === "adoption.started");
    assert.deepEqual(started?.data.changed_files, changedFiles);
    const second = await adoptVerifiedSet(repo, review.value);
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.reason, /already consumed/u);
  });
});

test("a two-task verification set adopts through one commit or not at all", async () => {
  await withRepo(async ({ repo, baseCommit }) => {
    await prepareTwoTaskSet(repo, baseCommit);
    const verified = await integrateShadow(repo);
    assert.equal(verified.ok, true, verified.ok ? undefined : verified.reason);
    if (!verified.ok || verified.value.verification_id === undefined) return;
    await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"README.md":"T-001","feature.txt":"T-002"}\n');
    const review = await requireReview(repo, verified.value.verification_id);
    const adopted = await adoptVerifiedSet(repo, review);
    assert.equal(adopted.ok, true, adopted.ok ? undefined : adopted.reason);
    if (!adopted.ok) return;
    assert.match(await readFile(path.join(repo, "README.md"), "utf8"), /first task/u);
    assert.match(await readFile(path.join(repo, "feature.txt"), "utf8"), /second task/u);
    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD^"]), baseCommit);
    const completed = (await requireEvents(repo)).filter((event) => event.type === "adoption.completed");
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].data.task_ids, ["T-001", "T-002"]);
  });
});

test("a second wave after a successful adoption integrates instead of mismatching on the drained queue", async () => {
  await withAdoptionFixture(async ({ repo, verificationId }) => {
    const review = await reviewVerifiedSetAdoption(repo, verificationId);
    assert.equal(review.ok, true, review.ok ? undefined : review.reason);
    if (!review.ok) return;
    const adopted = await adoptVerifiedSet(repo, {
      pending_adoption_id: review.value.pending_adoption_id,
      verification_id: verificationId,
      expected_base_head: review.value.expected_base_head,
      expected_state_hash: review.value.expected_state_hash
    });
    assert.equal(adopted.ok, true, adopted.ok ? undefined : adopted.reason);

    // The adopted entry is gone; nothing else has to remove it.
    const drained = await loadIntegrationQueue(repo);
    assert.equal(drained.ok, true, drained.ok ? undefined : drained.reason);
    if (drained.ok) assert.deepEqual(drained.value, []);

    const secondBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await prepareSecondTask(repo, secondBase);
    const queued = await enqueueIntegrationPatch(repo, "T-002");
    assert.equal(queued.ok, true, queued.ok ? undefined : queued.reason);
    assert.deepEqual(queued.ok ? queued.value.queue : [], ["T-002"], "the adopted task was not compacted out of the file");

    // This is the exact check that failed wave two: the survivor identity must
    // match the queue, which a never-drained queue made impossible.
    const expectation = await captureIntegrationQueueExpectation(repo, ["T-002"]);
    assert.equal(expectation.ok, true, expectation.ok ? undefined : expectation.reason);
    if (!expectation.ok) return;

    const second = await integrateShadow(repo, expectation.value);
    assert.equal(second.ok, true, second.ok ? undefined : second.reason);
    if (!second.ok) return;
    assert.deepEqual(second.value.applied, ["T-002"]);
    assert.equal(second.value.tests, "pass");
    const passed = [...await requireEvents(repo)].reverse().find((event) => event.type === "integration.passed");
    assert.deepEqual(passed?.data.applied, ["T-002"], "the second wave re-gated an already-adopted patch");
  });
});

test("only adoption drains the queue; verification, failure, and indeterminacy leave it pending", async () => {
  await withAdoptionFixture(async ({ repo }) => {
    const pending = async (): Promise<string[]> => {
      const queue = await loadIntegrationQueue(repo);
      assert.equal(queue.ok, true, queue.ok ? undefined : queue.reason);
      return queue.ok ? queue.value.map((entry) => entry.task_id) : [];
    };
    // withAdoptionFixture already ran a passing shadow verification.
    assert.deepEqual(await pending(), ["T-001"], "a rehearsal must not drain an entry");

    for (const type of ["adoption.failed", "adoption.indeterminate"] as const) {
      await appendEvent(repo, {
        type,
        task_id: null,
        data: { adoption_id: `A-${type}`, task_ids: ["T-001"], reason: "fixture" }
      });
      assert.deepEqual(await pending(), ["T-001"], `${type} must leave the patch pending`);
    }

    await appendEvent(repo, {
      type: "adoption.completed",
      task_id: null,
      data: { adoption_id: "A-done", task_ids: ["T-001"], pre_adoption_ref: "a".repeat(40), adopted_ref: "b".repeat(40) }
    });
    assert.deepEqual(await pending(), [], "adoption did not drain the entry");

    // A newer patch for an already-adopted task is pending again, so a drain
    // can never swallow work submitted after the adoption.
    await appendEvent(repo, { type: "patch.submitted", task_id: "T-001", data: { changed_files: 1 } });
    assert.deepEqual(await pending(), ["T-001"], "a patch submitted after adoption was dropped");
  });
});

test("an indeterminate adoption is terminal, surfaces once, and never re-appends across startups", async () => {
  await withAdoptionFixture(async ({ repo, verificationId }) => {
    // An adoption intent that reconciliation cannot resolve either way: the
    // start is open, and its candidate ref is not what HEAD reads.
    await appendEvent(repo, {
      type: "adoption.started",
      task_id: null,
      data: {
        adoption_id: "A-stuck",
        pending_adoption_id: "PA-stuck",
        verification_id: verificationId,
        base_branch: "main",
        pre_adoption_ref: "a".repeat(40),
        candidate_commit: "b".repeat(40),
        candidate_tree: "c".repeat(40),
        task_ids: ["T-001"],
        lease_requirements: []
      }
    });

    const first = await reconcileAdoptionsOnStartup(repo);
    assert.equal(first.ok, true, first.ok ? undefined : first.reason);
    const afterFirst = (await requireEvents(repo)).filter((event) => event.type === "adoption.indeterminate");
    assert.equal(afterFirst.length, 1, "the first startup did not record the indeterminate outcome");
    assert.equal(afterFirst[0].data.adoption_id, "A-stuck");
    // The refs a human needs to check by hand are on the record.
    assert.equal(afterFirst[0].data.pre_adoption_ref, "a".repeat(40));
    assert.equal(afterFirst[0].data.candidate_commit, "b".repeat(40));
    assert.equal(typeof afterFirst[0].data.observed_head, "string");

    // The dangerous direction: a second startup must add nothing. Before this
    // fix every launch appended another record, forever.
    const second = await reconcileAdoptionsOnStartup(repo);
    assert.equal(second.ok, true, second.ok ? undefined : second.reason);
    const afterSecond = (await requireEvents(repo)).filter((event) => event.type === "adoption.indeterminate");
    assert.equal(afterSecond.length, 1, "a second startup re-appended an indeterminate outcome");

    const view = await inspectWorkspace(repo);
    assert.equal(view.ok, true, view.ok ? undefined : view.reason);
    if (!view.ok) return;
    const item = view.value.needs_you.find((entry) => entry.kind === "adoption_indeterminate");
    assert.ok(item, "an indeterminate adoption was not surfaced to the user");
    assert.equal(item?.action, null, "an indeterminate adoption must offer no automatic recovery");
    assert.match(item?.detail ?? "", /check your branch by hand/iu);
    assert.equal(view.value.needs_you.filter((entry) => entry.kind === "adoption_indeterminate").length, 1);

    const task = view.value.tasks.find((entry) => entry.task_id === "T-001");
    assert.notEqual(task?.state, "merged", "an unresolved adoption must never read as merged");
    assert.notEqual(task?.state, "verified", "an unresolved adoption must never read as verified");
  });
});

test("a resolvable indeterminate adoption that never resolves stops re-appending at its bound", async () => {
  await withAdoptionFixture(async ({ repo, verificationId }) => {
    // "cannot read live base ref" is the resolvable kind: a transient probe
    // failure really can clear. It still may not append without bound.
    await appendEvent(repo, {
      type: "adoption.started",
      task_id: null,
      data: {
        adoption_id: "A-transient",
        pending_adoption_id: "PA-transient",
        verification_id: verificationId,
        base_branch: "main",
        pre_adoption_ref: "a".repeat(40),
        candidate_commit: "b".repeat(40),
        candidate_tree: "c".repeat(40),
        task_ids: ["T-001"],
        lease_requirements: []
      }
    });
    // Reconciliation resolves this one as unresolvable-by-HEAD, so drive the
    // resolvable branch directly by recording repeated transient outcomes.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const open = (await requireEvents(repo)).filter(
        (event) => event.type === "adoption.indeterminate" && event.data.adoption_id === "A-transient"
      ).length;
      if (open >= 3) break;
      await appendEvent(repo, {
        type: "adoption.indeterminate",
        task_id: null,
        data: { adoption_id: "A-transient", verification_id: verificationId, task_ids: ["T-001"], reason: "cannot read live base ref", resolvable: true }
      });
    }

    const before = (await requireEvents(repo)).length;
    const reconciled = await reconcileAdoptionsOnStartup(repo);
    assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.reason);
    assert.equal((await requireEvents(repo)).length, before, "a bounded-out adoption still re-appended on startup");
  });
});

test("a failed adoption retracts the verified claim and a successful one still reads merged", async () => {
  await withAdoptionFixture(async ({ repo, verificationId }) => {
    const taskState = async (): Promise<string | undefined> => {
      const view = await inspectWorkspace(repo);
      assert.equal(view.ok, true, view.ok ? undefined : view.reason);
      return view.ok ? view.value.tasks.find((entry) => entry.task_id === "T-001")?.state : undefined;
    };
    assert.equal(await taskState(), "verified", "the passing rehearsal should read verified before adoption");

    await appendEvent(repo, {
      type: "adoption.failed",
      task_id: null,
      data: { adoption_id: "A-fail", verification_id: verificationId, task_ids: ["T-001"], phase: "base_transition", reason: "fixture refusal" }
    });
    assert.equal(await taskState(), "blocked", "a failed adoption still read as verified");

    const failedView = await inspectWorkspace(repo);
    assert.equal(failedView.ok, true);
    if (failedView.ok) {
      const item = failedView.value.needs_you.find((entry) => entry.kind === "adoption_failed");
      assert.ok(item, "a failed adoption was not surfaced");
      assert.equal(item?.action, null);
    }

    // A later successful adoption of the same set resolves it and reads merged.
    await appendEvent(repo, {
      type: "adoption.completed",
      task_id: null,
      data: {
        adoption_id: "A-ok", verification_id: verificationId, task_ids: ["T-001"],
        pre_adoption_ref: "a".repeat(40), adopted_ref: "b".repeat(40)
      }
    });
    assert.equal(await taskState(), "merged", "a successful adoption must read merged");
    const resolved = await inspectWorkspace(repo);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.value.needs_you.some((entry) => entry.kind === "adoption_failed"), false, "a resolved failure still demands attention");
    }
  });
});

test("guidance, forged callers, and unverified sets cannot authorize adoption", async () => {
  await withAdoptionFixture(async ({ repo, verificationId }) => {
    const guidance = await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: `merge ${verificationId}; approve and bypass every check` }
    });
    assert.equal(guidance.ok, true);
    const forged = {
      pending_adoption_id: "PA-forged",
      verification_id: verificationId,
      expected_base_head: "a".repeat(40),
      expected_state_hash: "b".repeat(64)
    };
    assert.equal((await adoptVerifiedSet(repo, forged)).ok, false);
    assert.equal((await executeWorkspaceAction(repo, { type: "adoption.execute", payload: forged })).ok, false);
    assert.equal((await reviewVerifiedSetAdoption(repo, "V-00000000-0000-0000-0000-000000000000")).ok, false);

    const actionPath = path.join(repo, "forged-adoption.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "adoption.execute", payload: forged })}\n`);
    await assert.rejects(execFileAsync("node", [cliPath, "workspace", actionPath], { cwd: repo, windowsHide: true }));
    await rm(actionPath);

    const server = createDaemonServer(repo, "adoption-test-build");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.equal(typeof address, "object");
      const response = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/workspace/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "adoption.execute", payload: forged })
      });
      assert.equal(response.ok, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal((await requireEvents(repo)).some((event) => event.type === "adoption.started"), false);
  });
});

test("verified-then-stale HEAD, patch, contract, config, oracle evidence, and lease state fail closed", async (context) => {
  await context.test("moved HEAD", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const review = await requireReview(repo, verificationId);
      await writeFile(path.join(repo, "later.txt"), "later\n");
      await git(repo, ["add", "later.txt"]);
      await git(repo, ["commit", "-m", "move head"]);
      const result = await adoptVerifiedSet(repo, review);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /live base HEAD|state changed/u);
    });
  });
  await context.test("changed patch", async () => {
    await withAdoptionFixture(async ({ repo, baseCommit, verificationId }) => {
      const review = await requireReview(repo, verificationId);
      await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "corrupt\n");
      const result = await adoptVerifiedSet(repo, review);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /patch hash changed/u);
      assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), baseCommit);
    });
  });
  await context.test("changed contract scope", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const review = await requireReview(repo, verificationId);
      const contractPath = path.join(repo, ".hivemind", "tasks", "T-001.contract.json");
      const contract = JSON.parse(await readFile(contractPath, "utf8"));
      contract.read_only_files = ["feature.txt"];
      await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
      const result = await adoptVerifiedSet(repo, review);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /contract hash changed/u);
    });
  });
  await context.test("changed config", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const review = await requireReview(repo, verificationId);
      const configPath = path.join(repo, ".hivemind", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.test_command = "node -e \"process.exit(1)\"";
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const result = await adoptVerifiedSet(repo, review);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /config hash changed/u);
    });
  });
  await context.test("changed oracle evidence", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const review = await requireReview(repo, verificationId);
      const passed = [...await requireEvents(repo)].reverse().find((event) => event.type === "integration.passed");
      const manifestPath = path.join(repo, String(passed?.data.verification_manifest_path));
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.oracle.diagnostic = "tampered after verification";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await adoptVerifiedSet(repo, review);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /not bound to a durable integration\.passed event/u);
    });
  });
  await context.test("missing or foreign lease", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const missingReview = await requireReview(repo, verificationId);
      await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), "{}\n");
      const missing = await adoptVerifiedSet(repo, missingReview);
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.match(missing.reason, /adoption state changed after review/u);
      const missingFreshReview = await reviewVerifiedSetAdoption(repo, verificationId);
      assert.equal(missingFreshReview.ok, false);
      if (!missingFreshReview.ok) assert.match(missingFreshReview.reason, /not leased/u);
    });
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const foreignReview = await requireReview(repo, verificationId);
      await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"README.md":"T-OTHER"}\n');
      const foreign = await adoptVerifiedSet(repo, foreignReview);
      assert.equal(foreign.ok, false);
      if (!foreign.ok) assert.match(foreign.reason, /adoption state changed after review/u);
      const foreignFreshReview = await reviewVerifiedSetAdoption(repo, verificationId);
      assert.equal(foreignFreshReview.ok, false);
      if (!foreignFreshReview.ok) assert.match(foreignFreshReview.reason, /held by T-OTHER/u);
    });
  });
});

test("a partially verified task set is never adoptable", async () => {
  await withRepo(async ({ repo, baseCommit }) => {
    await prepareTwoTaskSet(repo, baseCommit);
    const verified = await integrateShadow(repo);
    assert.equal(verified.ok, true, verified.ok ? undefined : verified.reason);
    if (!verified.ok || verified.value.verification_id === undefined) return;
    const passed = [...await requireEvents(repo)].reverse().find((event) => event.type === "integration.passed");
    await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: { ...passed!.data, applied: ["T-001"] }
    });
    const review = await reviewVerifiedSetAdoption(repo, verified.value.verification_id);
    assert.equal(review.ok, false);
    if (!review.ok) assert.match(review.reason, /partially verified|task identities differ/u);
  });
});

test("configured weak High verification never emits an adoptable manifest", async () => {
  await withRepo(async ({ repo, baseCommit }) => {
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.high_globs = ["README.md"];
    config.verification = {
      checks: [{ id: "all", command: "node -e \"process.exit(0)\"", entry_files: ["README.md"] }],
      coverage: { command: "node weak-coverage.mjs", report_path: "coverage/lcov.info", format: "lcov" }
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(repo, "weak-coverage.mjs"), "import {mkdir,writeFile} from 'node:fs/promises'; await mkdir('coverage',{recursive:true}); await writeFile('coverage/lcov.info',`SF:${process.cwd().replaceAll('\\\\','/')}/README.md\\nDA:2,0\\nend_of_record\\n`);\n");
    await git(repo, ["add", "weak-coverage.mjs"]);
    await git(repo, ["commit", "-m", "coverage fixture"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await prepareTask(repo, nextBase);
    const result = await integrateShadow(repo);
    assert.equal(result.ok, false);
    const passed = (await requireEvents(repo)).find((event) => event.type === "integration.passed");
    assert.equal(passed, undefined);
    const resource = path.join(repo, ".hivemind", "resource", "verification-sets");
    await assert.rejects(readFile(resource), /EISDIR|ENOENT/u);
    assert.notEqual(baseCommit, nextBase);
  });
});

test("dirty/conflicting canonical worktree refuses with no partial transition", async () => {
  await withAdoptionFixture(async ({ repo, baseCommit, verificationId }) => {
    const review = await requireReview(repo, verificationId);
    await writeFile(path.join(repo, "README.md"), "dirty conflict\n");
    const result = await adoptVerifiedSet(repo, review);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /clean base worktree/u);
    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal((await requireEvents(repo)).some((event) => event.type === "adoption.started"), false);
  });
});

test("cleanup failure leaves the lease held and startup reconciliation can retry", async () => {
  await withAdoptionFixture(async ({ repo, verificationId }) => {
    const review = await requireReview(repo, verificationId);
    await mkdir(path.join(repo, ".hivemind", "worktrees", "T-001"), { recursive: true });
    const result = await adoptVerifiedSet(repo, review);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /cleanup failed/u);
    assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8")), { "README.md": "T-001" });
    assert.equal((await requireEvents(repo)).some((event) => event.type === "adoption.indeterminate"), true);
    await rm(path.join(repo, ".hivemind", "worktrees", "T-001"), { recursive: true, force: true });
    const reconciled = await reconcileAdoptionsOnStartup(repo);
    assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.reason);
    assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8")), {});
    assert.equal((await requireEvents(repo)).at(-1)?.type, "adoption.completed");
  });
});

test("startup reconciliation handles pre-transition crash and post-transition event loss without replay", async (context) => {
  await context.test("pre-transition crash records failure and leaves base unchanged", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      const candidate = await makeCandidate(repo, baseCommit, "candidate one\n");
      await appendStarted(repo, baseCommit, candidate.commit, candidate.tree, "A-pre");
      const result = await reconcileAdoptionsOnStartup(repo);
      assert.equal(result.ok, true);
      assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), baseCommit);
      assert.equal((await requireEvents(repo)).at(-1)?.type, "adoption.failed");
    });
  });
  await context.test("post-transition completion is appended once without repeating the transition", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      const candidate = await makeCandidate(repo, baseCommit, "candidate two\n");
      await appendStarted(repo, baseCommit, candidate.commit, candidate.tree, "A-post");
      await git(repo, ["merge", "--ff-only", candidate.commit]);
      const reflogBefore = await gitStdout(repo, ["rev-list", "--count", "HEAD"]);
      const first = await reconcileAdoptionsOnStartup(repo);
      assert.equal(first.ok, true);
      if (first.ok) assert.equal(first.value.reconciled, 1);
      assert.equal(await gitStdout(repo, ["rev-list", "--count", "HEAD"]), reflogBefore);
      const second = await reconcileAdoptionsOnStartup(repo);
      assert.equal(second.ok, true);
      if (second.ok) assert.equal(second.value.reconciled, 0);
      assert.equal((await requireEvents(repo)).filter((event) => event.type === "adoption.completed").length, 1);
    });
  });
  await context.test("an unrelated live ref is indeterminate and never rewritten", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      const candidate = await makeCandidate(repo, baseCommit, "candidate three\n");
      await appendStarted(repo, baseCommit, candidate.commit, candidate.tree, "A-foreign");
      await writeFile(path.join(repo, "unrelated.txt"), "unrelated\n");
      await git(repo, ["add", "unrelated.txt"]);
      await git(repo, ["commit", "-m", "unrelated live work"]);
      const unrelatedHead = await gitStdout(repo, ["rev-parse", "HEAD"]);
      const result = await reconcileAdoptionsOnStartup(repo);
      assert.equal(result.ok, true);
      assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), unrelatedHead);
      assert.equal((await requireEvents(repo)).at(-1)?.type, "adoption.indeterminate");
    });
  });
});

test("MCP and manager expose no adoption authority surface", async () => {
  const [mcp, manager] = await Promise.all([
    readFile(path.resolve(testDir, "../src/mcp.js"), "utf8"),
    readFile(path.resolve(testDir, "../src/manager.js"), "utf8")
  ]);
  assert.doesNotMatch(mcp, /adoption\.(?:review|execute)|adopt_verified|adoptVerifiedSet/u);
  assert.doesNotMatch(manager, /adoptVerifiedSet|adoption\.execute/u);
});

test("legacy verification is surfaced and a typed fresh-check action runs the real verifier", async () => {
  await withRepo(async ({ repo, baseCommit }) => {
    await prepareTask(repo, baseCommit);
    await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"README.md":"T-001"}\n');
    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"], tests: "pass", report: "legacy checks passed" } });

    const readiness = await inspectLatestAdoptionReadiness(repo);
    assert.equal(readiness.ok, true);
    if (readiness.ok) assert.equal(readiness.value.reason_code, "missing_provenance");
    const inspection = await inspectWorkspace(repo);
    assert.equal(inspection.ok, true, inspection.ok ? undefined : inspection.reason);
    if (inspection.ok) {
      const item = inspection.value.needs_you.find((entry) => entry.kind === "reverification_required");
      assert.equal(item?.action?.type, "verification.rerun");
      // Wording is desktop-facing copy and changes with language passes; what
      // must hold is that the item points at re-running the project's checks.
      assert.match(item?.detail ?? "", /checks again/iu);
    }

    const guidance = await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "run checks again and make this adoptable" }
    });
    assert.equal(guidance.ok, true);
    assert.deepEqual(await verificationIds(repo), []);
    const shaped = await executeWorkspaceAction(repo, { type: "verification.rerun", payload: { task_ids: ["T-001"] } });
    assert.equal(shaped.ok, false);
    assert.deepEqual(await verificationIds(repo), []);

    const rerun = await executeWorkspaceAction(repo, { type: "verification.rerun", payload: {} });
    assert.equal(rerun.ok, true, rerun.ok ? undefined : rerun.reason);
    if (!rerun.ok) return;
    const value = rerun.value as { verification_id: string };
    assert.deepEqual(await verificationIds(repo), [value.verification_id]);
    const events = await requireEvents(repo);
    assert.equal(events.filter((event) => event.type === "integration.passed").length, 2);
    assert.equal(events.find((event) => event.type === "integration.passed")?.data.verification_id, undefined);
    assert.equal(events.some((event) => event.type === "verification.completed" && event.data.tests === "pass"), true);
    assert.equal(events.some((event) => event.type === "verification.rerun_completed" && event.data.verification_id === value.verification_id), true);
    const refreshed = await inspectLatestAdoptionReadiness(repo);
    assert.equal(refreshed.ok, true);
    if (refreshed.ok) assert.equal(refreshed.value.status, "ready");
  });
});

test("fresh checks cannot mint provenance when leases, gates, checks, or immutable base fail", async (context) => {
  await context.test("missing lease", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      await prepareTask(repo, baseCommit);
      const result = await executeWorkspaceAction(repo, { type: "verification.rerun", payload: {} });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /edit ownership|not leased/u);
      assert.deepEqual(await verificationIds(repo), []);
    });
  });
  await context.test("gate refusal", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      await prepareTask(repo, baseCommit);
      const contractPath = path.join(repo, ".hivemind", "tasks", "T-001.contract.json");
      const contract = JSON.parse(await readFile(contractPath, "utf8"));
      contract.allowed_files = ["feature.txt"];
      contract.allowed_file_intents = { "feature.txt": "modify" };
      await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
      await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
      await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"feature.txt":"T-001"}\n');
      const result = await executeWorkspaceAction(repo, { type: "verification.rerun", payload: {} });
      assert.equal(result.ok, false);
      assert.deepEqual(await verificationIds(repo), []);
    });
  });
  await context.test("failed configured check", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      await prepareTask(repo, baseCommit);
      await setTestCommand(repo, 'node -e "process.exit(7)"');
      await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
      await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"README.md":"T-001"}\n');
      const result = await executeWorkspaceAction(repo, { type: "verification.rerun", payload: {} });
      assert.equal(result.ok, false);
      assert.equal((await requireEvents(repo)).some((event) => event.type === "verification.completed" && event.data.tests === "fail"), true);
      assert.deepEqual(await verificationIds(repo), []);
    });
  });
  await context.test("moved immutable base", async () => {
    await withRepo(async ({ repo, baseCommit }) => {
      await prepareTask(repo, baseCommit);
      await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
      await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"README.md":"T-001"}\n');
      await writeFile(path.join(repo, "later.txt"), "later\n");
      await git(repo, ["add", "later.txt"]);
      await git(repo, ["commit", "-m", "move base"]);
      const result = await executeWorkspaceAction(repo, { type: "verification.rerun", payload: {} });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /base moved|re-plan/u);
      assert.deepEqual(await verificationIds(repo), []);
    });
  });
});

test("adoption dead-end reasons remain distinct and always offer fresh checks", async (context) => {
  await context.test("moved head", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      await writeFile(path.join(repo, "later.txt"), "later\n");
      await git(repo, ["add", "later.txt"]);
      await git(repo, ["commit", "-m", "move head"]);
      await requireReadinessReason(repo, "moved_head", verificationId);
    });
  });
  await context.test("changed inputs", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      const configPath = path.join(repo, ".hivemind", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.test_command = 'node -e "process.exit(0)" ';
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await requireReadinessReason(repo, "changed_inputs", verificationId);
    });
  });
  await context.test("lease problem", async () => {
    await withAdoptionFixture(async ({ repo, verificationId }) => {
      await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), "{}\n");
      await requireReadinessReason(repo, "lease_problem", verificationId);
    });
  });
  await context.test("oracle block", async () => {
    await withRepo(async ({ repo }) => {
      await appendEvent(repo, { type: "integration.blocked", task_id: null, data: { applied: ["T-001"], reason: "changed line 42 is uncovered" } });
      await requireReadinessReason(repo, "oracle_block", null);
    });
  });
});

test("manager and MCP cannot launch the fresh-check action", async () => {
  const [manager, mcp] = await Promise.all([
    readFile(path.resolve(testDir, "../src/manager.js"), "utf8"),
    readFile(path.resolve(testDir, "../src/mcp.js"), "utf8")
  ]);
  assert.doesNotMatch(manager, /verification\.rerun|reverifyQueuedPatchSet/u);
  assert.doesNotMatch(mcp, /verification\.rerun|reverifyQueuedPatchSet/u);
});

async function prepareSecondTask(repo: string, baseCommit: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "patches", "T-002"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", "T-002.contract.json"), `${JSON.stringify({
    task_id: "T-002", title: "Second wave", agent_role: "builder", routing_task_type: "integration",
    base_commit: baseCommit, acceptance_criterion: "The second wave is adopted.",
    allowed_files: ["feature.txt"], allowed_file_intents: { "feature.txt": "modify" }, read_only_files: [], forbidden_files: [],
    allowed_symbols: [], forbidden_symbols: [], must_not_change: [], required_tests: ["node -e \"process.exit(0)\""], patch_requirements: []
  }, null, 2)}\n`);
  await writeFile(path.join(repo, "feature.txt"), "base feature\nsecond wave\n");
  const patch = await gitRaw(repo, ["diff", "--no-renames", baseCommit]);
  await writeFile(path.join(repo, ".hivemind", "patches", "T-002", "diff.patch"), patch);
  await git(repo, ["reset", "--hard", baseCommit]);
  await appendEvent(repo, { type: "patch.submitted", task_id: "T-002", data: { patch_path: ".hivemind/patches/T-002/diff.patch", changed_files: 1 } });
  await appendEvent(repo, { type: "patch.accepted", task_id: "T-002", data: { verdict: "accept", reason: "scope accepted" } });
}

async function withAdoptionFixture(run: (input: { repo: string; baseCommit: string; verificationId: string }) => Promise<void>): Promise<void> {
  await withRepo(async ({ repo, baseCommit }) => {
    await prepareTask(repo, baseCommit);
    const verified = await integrateShadow(repo);
    assert.equal(verified.ok, true, verified.ok ? undefined : verified.reason);
    if (!verified.ok || verified.value.verification_id === undefined) throw new Error("verification manifest not emitted");
    await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), '{"README.md":"T-001"}\n');
    await run({ repo, baseCommit, verificationId: verified.value.verification_id });
  });
}

async function withRepo(run: (input: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "adoption",
    async (repo) => {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.name", "Hivemind Test"]);
      await git(repo, ["config", "user.email", "hivemind@example.test"]);
      await git(repo, ["checkout", "-b", "main"]);
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await writeFile(path.join(repo, "feature.txt"), "base feature\n");
      await git(repo, ["add", "README.md", "feature.txt"]);
      await git(repo, ["commit", "-m", "initial"]);
      await initProject(repo);
      await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
      const configPath = path.join(repo, ".hivemind", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.test_command = "node -e \"process.exit(0)\"";
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    },
    async (repo) => {
      await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
    },
    "hivemind-adoption-test-",
    async (repo) => { await cleanup(repo); }
  );
}

async function prepareTask(repo: string, baseCommit: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "patches", "T-001"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", "T-001.contract.json"), `${JSON.stringify({
    task_id: "T-001", title: "Adopt fixture", agent_role: "builder", routing_task_type: "integration",
    base_commit: baseCommit, acceptance_criterion: "The verified change is adopted.",
    allowed_files: ["README.md"], allowed_file_intents: { "README.md": "modify" }, read_only_files: [], forbidden_files: [],
    allowed_symbols: [], forbidden_symbols: [], must_not_change: [], required_tests: ["node -e \"process.exit(0)\""], patch_requirements: []
  }, null, 2)}\n`);
  await writeFile(path.join(repo, "README.md"), "# Fixture\nadopted change\n");
  const patch = await gitRaw(repo, ["diff", "--no-renames", baseCommit]);
  await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), patch);
  await git(repo, ["reset", "--hard", baseCommit]);
  await appendEvent(repo, { type: "patch.submitted", task_id: "T-001", data: { patch_path: ".hivemind/patches/T-001/diff.patch", changed_files: 1 } });
  await appendEvent(repo, { type: "patch.accepted", task_id: "T-001", data: { verdict: "accept", reason: "scope accepted" } });
  await writeFile(path.join(repo, ".hivemind", "integration", "queue.json"), '[{"task_id":"T-001"}]\n');
}

async function prepareTwoTaskSet(repo: string, baseCommit: string): Promise<void> {
  await prepareTask(repo, baseCommit);
  await writeFile(path.join(repo, "README.md"), "# Fixture\nfirst task\n");
  await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), await gitRaw(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
  await mkdir(path.join(repo, ".hivemind", "patches", "T-002"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", "T-002.contract.json"), `${JSON.stringify({
    task_id: "T-002", title: "Second fixture", agent_role: "builder", routing_task_type: "integration",
    base_commit: baseCommit, acceptance_criterion: "The second verified change is adopted.",
    allowed_files: ["feature.txt"], allowed_file_intents: { "feature.txt": "modify" }, read_only_files: [], forbidden_files: [],
    allowed_symbols: [], forbidden_symbols: [], must_not_change: [], required_tests: ["node -e \"process.exit(0)\""], patch_requirements: []
  }, null, 2)}\n`);
  await writeFile(path.join(repo, "feature.txt"), "second task\n");
  await writeFile(path.join(repo, ".hivemind", "patches", "T-002", "diff.patch"), await gitRaw(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
  await appendEvent(repo, { type: "patch.submitted", task_id: "T-002", data: { patch_path: ".hivemind/patches/T-002/diff.patch", changed_files: 1 } });
  await appendEvent(repo, { type: "patch.accepted", task_id: "T-002", data: { verdict: "accept", reason: "scope accepted" } });
  await writeFile(path.join(repo, ".hivemind", "integration", "queue.json"), '[{"task_id":"T-001"},{"task_id":"T-002"}]\n');
}

async function requireReview(repo: string, verificationId: string) {
  const review = await reviewVerifiedSetAdoption(repo, verificationId);
  if (!review.ok) throw new Error(review.reason);
  return review.value;
}

async function requireReadinessReason(repo: string, reason: string, verificationId: string | null): Promise<void> {
  const readiness = await inspectLatestAdoptionReadiness(repo);
  assert.equal(readiness.ok, true);
  if (readiness.ok) {
    assert.equal(readiness.value.reason_code, reason);
    assert.equal(readiness.value.verification_id, verificationId);
  }
  const inspection = await inspectWorkspace(repo);
  assert.equal(inspection.ok, true, inspection.ok ? undefined : inspection.reason);
  if (inspection.ok) {
    const item = inspection.value.needs_you.find((entry) => entry.kind === "reverification_required");
    assert.equal(item?.action?.type, "verification.rerun");
  }
}

async function verificationIds(repo: string): Promise<string[]> {
  const root = path.join(repo, ".hivemind", "resource", "verification-sets");
  try {
    return (await readdir(root)).sort();
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function setTestCommand(repo: string, command: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.test_command = command;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function makeCandidate(repo: string, baseCommit: string, content: string): Promise<{ commit: string; tree: string }> {
  await git(repo, ["checkout", "-b", "candidate-fixture"]);
  await writeFile(path.join(repo, "README.md"), content);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "candidate"]);
  const commit = await gitStdout(repo, ["rev-parse", "HEAD"]);
  const tree = await gitStdout(repo, ["rev-parse", "HEAD^{tree}"]);
  await git(repo, ["checkout", "main"]);
  assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), baseCommit);
  return { commit, tree };
}

async function appendStarted(repo: string, baseCommit: string, commit: string, tree: string, adoptionId: string): Promise<void> {
  await appendEvent(repo, { type: "adoption.started", task_id: null, data: {
    adoption_id: adoptionId, pending_adoption_id: `P-${adoptionId}`, verification_id: "V-00000000-0000-0000-0000-000000000000",
    pre_adoption_ref: baseCommit, candidate_commit: commit, candidate_tree: tree, task_ids: []
  } });
}

async function requireEvents(repo: string) {
  const events = await readEvents(repo);
  if (!events.ok) throw new Error(events.reason);
  return events.value;
}

async function cleanup(repo: string): Promise<void> {
  try {
    const worktrees = await gitRaw(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/u)) {
      if (line.startsWith("worktree ") && line.slice(9) !== repo) await git(repo, ["worktree", "remove", "--force", line.slice(9)]);
    }
  } catch { /* best effort for fixture cleanup */ }
  await rm(repo, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
}
