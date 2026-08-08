import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import {
  cancelQualityRun,
  preflightQualityCancellationReconciliation,
  qualityRunCancelled,
  reconcileQualityCancellationsOnStartup
} from "../src/quality-control.js";
import { selectQualityWinner } from "../src/quality-selection.js";
import {
  disposeSpeculativeDraft,
  type SpeculativeDraftOutcome,
  type SpeculativeDraftProducer
} from "../src/speculative-draft.js";
import { admitValueQuality } from "../src/value-quality.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");

test("winner selection re-derives eligibility and applies the recorded minimal-change rule", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) {
      return;
    }
    const canonicalBefore = await canonicalIdentity(repo);
    const canonicalEventsBefore = await canonicalEvents(repo);
    const first = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      successfulProducer(
        [],
        [
          "const candidate = 'first';",
          "const normalized = candidate.trim();",
          "export const value = normalized;",
          ""
        ].join("\n")
      )
    );
    const second = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-002" },
      successfulProducer([], "export const value = 'second';\n")
    );
    assert.equal(first.ok, true, first.ok ? undefined : first.reason);
    assert.equal(second.ok, true, second.ok ? undefined : second.reason);

    const selected = await selectQualityWinner(repo, admission.value.quality_run_id);
    assert.equal(selected.ok, true, selected.ok ? undefined : selected.reason);
    if (!selected.ok) {
      return;
    }
    assert.equal(selected.value.selection_rule.id, "minimal_verified_change_surface_v1");
    assert.deepEqual(selected.value.selection_rule.order, [
      "fewest changed files",
      "fewest changed patch lines",
      "smallest UTF-8 patch byte length",
      "lexical draft_id"
    ]);
    assert.deepEqual(selected.value.eligible_draft_ids, ["D-002", "D-001"]);
    assert.equal(selected.value.selected_draft_id, "D-002");
    assert.equal(selected.value.candidates.every((candidate) => candidate.eligible), true);
    assert.ok(
      selected.value.candidates.find((candidate) => candidate.draft_id === "D-002")!
        .changed_line_count <
      selected.value.candidates.find((candidate) => candidate.draft_id === "D-001")!
        .changed_line_count
    );
    assert.equal(selected.value.advisory_only, true);
    assert.equal(selected.value.automatic_adoption, false);

    const selectionPath = path.join(
      repo,
      ".hivemind",
      "resource",
      "quality-runs",
      admission.value.quality_run_id,
      "selection.json"
    );
    assert.deepEqual(JSON.parse(await readFile(selectionPath, "utf8")), selected.value);
    const immutableHash = createHash("sha256").update(await readFile(selectionPath)).digest("hex");
    const repeated = await selectQualityWinner(repo, admission.value.quality_run_id);
    assert.equal(repeated.ok, false);
    if (!repeated.ok) {
      assert.match(repeated.reason, /immutable quality selection already exists/);
    }
    assert.equal(
      createHash("sha256").update(await readFile(selectionPath)).digest("hex"),
      immutableHash
    );

    assert.deepEqual(await canonicalIdentity(repo), canonicalBefore);
    assert.deepEqual(await canonicalEvents(repo), canonicalEventsBefore);
    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
    if (events.ok) {
      const selectionEvents = events.value.filter(
        (event) => event.type === "quality.selection_decided"
      );
      assert.equal(selectionEvents.length, 1);
      assert.equal(selectionEvents[0].data.selected_draft_id, "D-002");
      assert.deepEqual(selectionEvents[0].data.selection_rule, selected.value.selection_rule);
      assert.deepEqual(selectionEvents[0].data.candidates, selected.value.candidates);
      assert.equal(
        events.value.some((event) =>
          event.type === "task.completed" ||
          event.type === "patch.accepted" ||
          event.type === "integration.queued" ||
          event.type === "integration.passed"
        ),
        false
      );
    }
  });
});

test("empty and shadow-failed drafts produce an immutable no-winner decision", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) {
      return;
    }
    const empty = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      async () => ({ status: "completed" })
    );
    const failed = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-002" },
      successfulProducer([], "export const value = ;\n")
    );
    assert.equal(empty.ok, true, empty.ok ? undefined : empty.reason);
    assert.equal(failed.ok, true, failed.ok ? undefined : failed.reason);
    if (empty.ok) {
      assert.equal(empty.value.outcome, "empty");
    }
    if (failed.ok) {
      assert.equal(failed.value.outcome, "shadow_failed");
    }

    const selected = await selectQualityWinner(repo, admission.value.quality_run_id);
    assert.equal(selected.ok, true, selected.ok ? undefined : selected.reason);
    if (!selected.ok) {
      return;
    }
    assert.deepEqual(selected.value.eligible_draft_ids, []);
    assert.equal(selected.value.selected_draft_id, null);
    assert.equal(selected.value.selected_draft_artifact, null);
    assert.match(selected.value.no_winner_reason ?? "", /no draft had a non-empty patch/);
    assert.deepEqual(
      selected.value.candidates.map((candidate) => ({
        draft_id: candidate.draft_id,
        eligible: candidate.eligible,
        gate: candidate.gate_status,
        shadow: candidate.shadow_status
      })),
      [
        { draft_id: "D-001", eligible: false, gate: "not_run", shadow: "not_run" },
        { draft_id: "D-002", eligible: false, gate: "accept", shadow: "fail" }
      ]
    );
  });
});

test("indeterminate shadow evidence overrides an eligible manifest and cannot win", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) {
      return;
    }
    const valid = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      successfulProducer([], "export const value = 'valid-before-uncertainty';\n")
    );
    const empty = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-002" },
      async () => ({ status: "completed" })
    );
    assert.equal(valid.ok, true, valid.ok ? undefined : valid.reason);
    assert.equal(empty.ok, true, empty.ok ? undefined : empty.reason);
    const shadowPath = path.join(
      repo,
      ".hivemind",
      "resource",
      "quality-runs",
      admission.value.quality_run_id,
      "drafts",
      "D-001",
      "shadow-result.json"
    );
    await writeFile(
      shadowPath,
      `${JSON.stringify({
        disposer: "runVerification",
        status: "indeterminate",
        reason: "fixture could not establish verification identity",
        result: null
      }, null, 2)}\n`
    );

    const selected = await selectQualityWinner(repo, admission.value.quality_run_id);
    assert.equal(selected.ok, true, selected.ok ? undefined : selected.reason);
    if (!selected.ok) {
      return;
    }
    assert.equal(selected.value.selected_draft_id, null);
    assert.equal(selected.value.candidates[0].outcome, "eligible");
    assert.equal(selected.value.candidates[0].shadow_status, "indeterminate");
    assert.equal(selected.value.candidates[0].eligible, false);
    assert.match(selected.value.candidates[0].eligibility_reason, /shadow verification indeterminate/);
  });
});

test("rejected, escalated, and indeterminate drafts cannot enter the winner set", async () => {
  await withSpeculativeRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, baseCommit, {
      allowed_files: ["src/value.js", "package.json"],
      allowed_file_intents: {
        "src/value.js": "modify",
        "package.json": "modify"
      }
    });
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 3 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) {
      return;
    }

    const rejected = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      async (checkoutPath) => {
        await writeFile(path.join(checkoutPath, "README.md"), "# outside scope\n");
        return { status: "completed" };
      }
    );
    const escalated = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-002" },
      async (checkoutPath) => {
        await writeFile(
          path.join(checkoutPath, "package.json"),
          "{\"name\":\"changed-manifest\",\"type\":\"module\"}\n"
        );
        return { status: "completed" };
      }
    );
    const indeterminate = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-003" },
      async (checkoutPath) => {
        await writeFile(path.join(checkoutPath, "src", "value.js"), "export const value = 'committed';\n");
        await git(checkoutPath, ["add", "src/value.js"]);
        await git(checkoutPath, ["commit", "-m", "identity divergence"]);
        return { status: "completed" };
      }
    );
    assert.equal(rejected.ok, true, rejected.ok ? undefined : rejected.reason);
    assert.equal(escalated.ok, true, escalated.ok ? undefined : escalated.reason);
    assert.equal(indeterminate.ok, true, indeterminate.ok ? undefined : indeterminate.reason);
    if (rejected.ok) {
      assert.equal(rejected.value.gate.status, "reject");
    }
    if (escalated.ok) {
      assert.equal(escalated.value.gate.status, "escalate");
    }
    if (indeterminate.ok) {
      assert.equal(indeterminate.value.outcome, "indeterminate");
    }

    const selected = await selectQualityWinner(repo, admission.value.quality_run_id);
    assert.equal(selected.ok, true, selected.ok ? undefined : selected.reason);
    if (!selected.ok) {
      return;
    }
    assert.equal(selected.value.selected_draft_id, null);
    assert.deepEqual(selected.value.eligible_draft_ids, []);
    assert.deepEqual(
      selected.value.candidates.map((candidate) => [
        candidate.draft_id,
        candidate.gate_status,
        candidate.shadow_status,
        candidate.eligible
      ]),
      [
        ["D-001", "reject", "not_run", false],
        ["D-002", "escalate", "not_run", false],
        ["D-003", "not_run", "not_run", false]
      ]
    );
  });
});

test("two same-scope drafts use distinct detached checkouts and immutable advisory artifacts without canonical mutation", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) {
      return;
    }
    assert.match(admission.value.quality_run_id, /^Q-T-001-/u);
    const canonicalBefore = await canonicalIdentity(repo);
    const canonicalEventsBefore = await canonicalEvents(repo);
    const checkoutPaths: string[] = [];

    const first = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      successfulProducer(checkoutPaths, "export const value = 'first';\n")
    );
    const second = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-002" },
      successfulProducer(checkoutPaths, "export const value = 'second';\n")
    );

    assert.equal(first.ok, true, first.ok ? undefined : first.reason);
    assert.equal(second.ok, true, second.ok ? undefined : second.reason);
    if (!first.ok || !second.ok) {
      return;
    }
    assert.equal(first.value.outcome, "eligible");
    assert.equal(second.value.outcome, "eligible");
    assert.equal(first.value.gate.disposer, "runGate");
    assert.equal(first.value.gate.status, "accept");
    assert.equal(first.value.shadow.disposer, "runVerification");
    assert.equal(first.value.shadow.status, "pass");
    assert.notEqual(first.value.checkout_instance_id, second.value.checkout_instance_id);
    assert.notEqual(first.value.checkout_path_sha256, second.value.checkout_path_sha256);
    assert.equal(checkoutPaths.length, 2);
    assert.notEqual(path.resolve(checkoutPaths[0]), path.resolve(checkoutPaths[1]));
    await assertMissing(checkoutPaths[0]);
    await assertMissing(checkoutPaths[1]);

    for (const artifact of [first.value, second.value]) {
      assert.deepEqual(
        await readdir(path.join(repo, artifact.artifact_path)),
        [
          "diff.patch",
          "gate-result.json",
          "manifest.json",
          "output.jsonl",
          "selection-evidence.json",
          "shadow-result.json"
        ]
      );
    }
    const firstArtifactHash = await hashTree(path.join(repo, first.value.artifact_path));
    const repeated = await disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      async () => {
        throw new Error("duplicate draft must refuse before producer invocation");
      }
    );
    assert.equal(repeated.ok, false);
    if (!repeated.ok) {
      assert.match(repeated.reason, /artifact already exists/);
    }
    assert.equal(await hashTree(path.join(repo, first.value.artifact_path)), firstArtifactHash);

    assert.deepEqual(await canonicalIdentity(repo), canonicalBefore);
    assert.deepEqual(await canonicalEvents(repo), canonicalEventsBefore);
    assert.equal(await pathExists(path.join(repo, "provider-spawned.txt")), false);
    await assertOnlyMainCheckoutAndBranch(repo);

    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
    if (events.ok) {
      const qualityEvents = events.value.filter((event) => event.type.startsWith("quality."));
      assert.equal(qualityEvents.filter((event) => event.type === "quality.draft_started").length, 2);
      assert.equal(qualityEvents.filter((event) => event.type === "quality.draft_verified").length, 2);
      assert.equal(qualityEvents.filter((event) => event.type === "quality.draft_disposed").length, 2);
      assert.equal(
        events.value.some((event) =>
          event.type === "task.completed" ||
          event.type === "patch.accepted" ||
          event.type === "integration.passed" ||
          event.type === "verification.completed"
        ),
        false
      );
    }
  });
});

test("all ineligible, failed, exceptional, and identity-divergent drafts clean detached checkouts", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const cases: Array<{
      name: string;
      expected: SpeculativeDraftOutcome;
      producer: (checkoutPaths: string[]) => SpeculativeDraftProducer;
    }> = [
      {
        name: "empty",
        expected: "empty",
        producer: (paths) => async (checkoutPath) => {
          paths.push(checkoutPath);
          return { status: "completed" };
        }
      },
      {
        name: "out-of-scope",
        expected: "gate_rejected",
        producer: (paths) => async (checkoutPath) => {
          paths.push(checkoutPath);
          await writeFile(path.join(checkoutPath, "README.md"), "outside scope\n");
          return { status: "completed" };
        }
      },
      {
        name: "shadow failure",
        expected: "shadow_failed",
        producer: (paths) => successfulProducer(paths, "export const value = ;\n")
      },
      {
        name: "crash",
        expected: "producer_crashed",
        producer: (paths) => async (checkoutPath) => {
          paths.push(checkoutPath);
          await writeFile(path.join(checkoutPath, "src", "value.js"), "export const value = 'partial crash';\n");
          return { status: "crashed", reason: "fixture adapter exited 1" };
        }
      },
      {
        name: "timeout",
        expected: "producer_timed_out",
        producer: (paths) => async (checkoutPath) => {
          paths.push(checkoutPath);
          await writeFile(path.join(checkoutPath, "src", "value.js"), "export const value = 'partial timeout';\n");
          return { status: "timed_out", reason: "fixture adapter timed out" };
        }
      },
      {
        name: "unexpected exception",
        expected: "producer_exception",
        producer: (paths) => async (checkoutPath) => {
          paths.push(checkoutPath);
          await writeFile(path.join(checkoutPath, "src", "value.js"), "export const value = 'partial exception';\n");
          throw new Error("fixture producer exception");
        }
      },
      {
        name: "checkout identity changed",
        expected: "indeterminate",
        producer: (paths) => async (checkoutPath) => {
          paths.push(checkoutPath);
          await writeFile(path.join(checkoutPath, "src", "value.js"), "export const value = 'committed draft';\n");
          await git(checkoutPath, ["add", "src/value.js"]);
          await git(checkoutPath, ["commit", "-m", "must remain speculative"]);
          return { status: "completed" };
        }
      }
    ];

    for (const fixture of cases) {
      const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
      assert.equal(admission.ok, true, `${fixture.name}: ${admission.ok ? "" : admission.reason}`);
      if (!admission.ok) {
        continue;
      }
      const canonicalBefore = await canonicalIdentity(repo);
      const checkoutPaths: string[] = [];
      const result = await disposeSpeculativeDraft(
        repo,
        { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
        fixture.producer(checkoutPaths)
      );
      assert.equal(result.ok, true, `${fixture.name}: ${result.ok ? "" : result.reason}`);
      if (!result.ok) {
        continue;
      }
      assert.equal(result.value.outcome, fixture.expected, fixture.name);
      assert.equal(result.value.eligible_for_selection, false, fixture.name);
      assert.equal(checkoutPaths.length, 1, fixture.name);
      await assertMissing(checkoutPaths[0]);
      await assertOnlyMainCheckoutAndBranch(repo);
      assert.deepEqual(await canonicalIdentity(repo), canonicalBefore, fixture.name);
    }
  });
});

test("an in-flight quality cancellation becomes terminal only after its detached checkout is disposed", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) return;
    let checkoutPath = "";
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const disposal = disposeSpeculativeDraft(
      repo,
      { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" },
      async (checkout) => {
        checkoutPath = checkout;
        releaseStarted();
        while (!(await qualityRunCancelled(repo, admission.value.quality_run_id))) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await writeFile(path.join(checkout, "src", "value.js"), "export const value = 'cancelled partial';\n");
        return { status: "cancelled", reason: "durable quality cancellation observed" };
      }
    );
    await started;
    const cancellation = await cancelQualityRun(repo, {
      quality_run_id: admission.value.quality_run_id,
      reason: "Stop the speculative run."
    });
    const disposed = await disposal;

    assert.equal(cancellation.ok, true, cancellation.ok ? undefined : cancellation.reason);
    assert.equal(disposed.ok, true, disposed.ok ? undefined : disposed.reason);
    if (disposed.ok) assert.equal(disposed.value.outcome, "producer_cancelled");
    await assertMissing(checkoutPath);
    await assertOnlyMainCheckoutAndBranch(repo);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const types = events.value
        .filter((event) => event.data.quality_run_id === admission.value.quality_run_id)
        .map((event) => event.type);
      assert.ok(types.indexOf("quality.cancel_requested") < types.indexOf("quality.draft_disposed"));
      assert.ok(types.indexOf("quality.draft_disposed") < types.indexOf("quality.cancelled"));
    }
  });
});

test("quality cancellation timeout reaches a terminal retryable failure instead of remaining open", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) return;
    await appendEvent(repo, {
      type: "quality.draft_started",
      task_id: "T-001",
      data: { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" }
    });

    const cancellation = await cancelQualityRun(
      repo,
      { quality_run_id: admission.value.quality_run_id, reason: "Bound the cancellation." },
      { waitMs: 5 }
    );
    assert.equal(cancellation.ok, false);
    if (!cancellation.ok) assert.match(cancellation.reason, /remains retryable/u);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const qualityEvents = events.value.filter((event) => event.data.quality_run_id === admission.value.quality_run_id);
      assert.equal(qualityEvents.at(-1)?.type, "quality.cancel_failed");
      assert.equal(qualityEvents.at(-1)?.data.terminal, true);
      assert.equal(qualityEvents.some((event) => event.type === "quality.cancelled"), false);
    }
  });
});

test("quality restart reconciliation does not reclaim an ambiguously-live draft", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) return;
    await appendEvent(repo, { type: "quality.draft_started", task_id: "T-001", data: { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" } });
    await appendEvent(repo, {
      type: "quality.worker_process_started",
      task_id: "T-001",
      data: { quality_run_id: admission.value.quality_run_id, draft_id: "D-001", pid: 4242, process_instance_id: "unknown-quality-worker" }
    });
    await appendEvent(repo, { type: "quality.cancel_requested", task_id: "T-001", data: { quality_run_id: admission.value.quality_run_id, reason: "daemon crashed" } });

    const preflight = await preflightQualityCancellationReconciliation(repo, { probeLiveness: () => "unknown" });
    assert.equal(preflight.ok, true);
    if (preflight.ok) assert.equal(preflight.value.blocked, true);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const qualityEvents = events.value.filter((event) => event.data.quality_run_id === admission.value.quality_run_id);
      assert.equal(qualityEvents.at(-1)?.type, "quality.cancel_failed");
      assert.equal(qualityEvents.some((event) => event.type === "quality.draft_disposed"), false);
      assert.equal(qualityEvents.some((event) => event.type === "quality.cancelled"), false);
    }
  });
});

test("quality restart reconciliation disposes a provably-dead draft and reaches quality.cancelled", async () => {
  await withSpeculativeRepo(async ({ repo }) => {
    const admission = await admitValueQuality(repo, "T-001", { strategy: "best_of_n", n: 2 });
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (!admission.ok) return;
    await appendEvent(repo, { type: "quality.draft_started", task_id: "T-001", data: { quality_run_id: admission.value.quality_run_id, draft_id: "D-001" } });
    await appendEvent(repo, {
      type: "quality.worker_process_started",
      task_id: "T-001",
      data: { quality_run_id: admission.value.quality_run_id, draft_id: "D-001", pid: 4343, process_instance_id: "dead-quality-worker" }
    });
    await appendEvent(repo, { type: "quality.cancel_requested", task_id: "T-001", data: { quality_run_id: admission.value.quality_run_id, reason: "daemon crashed" } });

    const preflight = await preflightQualityCancellationReconciliation(repo, { probeLiveness: () => "dead" });
    assert.equal(preflight.ok, true);
    if (preflight.ok) assert.equal(preflight.value.blocked, false);
    const reconciled = await reconcileQualityCancellationsOnStartup(repo, { probeLiveness: () => "dead" });
    assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.reason);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const qualityEvents = events.value.filter((event) => event.data.quality_run_id === admission.value.quality_run_id);
      assert.equal(qualityEvents.at(-2)?.type, "quality.draft_disposed");
      assert.equal(qualityEvents.at(-1)?.type, "quality.cancelled");
    }
  });
});

test("speculative draft disposal structurally reuses gate and verification without lease or provider paths", async () => {
  const source = await readFile(path.join(projectRoot, "src", "speculative-draft.ts"), "utf8");
  assert.match(source, /import \{ runGate,/u);
  assert.match(source, /await runGate\(/u);
  assert.match(source, /import \{[\s\S]*runShadowVerification,/u);
  assert.match(source, /await runShadowVerification\(/u);
  assert.match(source, /withDetachedCheckout\(/u);
  assert.doesNotMatch(source, /from "\.\/lease|requestLease|grantLease|releaseLease/u);
  assert.doesNotMatch(source, /from "\.\/adapter|runAdapterProcess|invokeAgent|recordAdapterUsage/u);
});

test("quality selection is deterministic, local-only, and structurally unable to adopt a winner", async () => {
  const source = await readFile(path.join(projectRoot, "src", "quality-selection.ts"), "utf8");
  const cli = await readFile(path.join(projectRoot, "src", "cli.ts"), "utf8");
  assert.match(source, /loadAdmittedValueQualityRun/u);
  assert.match(source, /writeImmutableJsonArtifact/u);
  assert.match(source, /quality\.selection_decided/u);
  assert.doesNotMatch(
    source,
    /from "\.\/adapter|runAdapterProcess|invokeAgent|recordAdapterUsage|from "\.\/lease|requestLease|submitTask|analyzeTask|enqueue|integrateShadow/u
  );
  assert.match(cli, /rest\[0\] === "select"/u);
  for (const file of ["manager.ts", "daemon.ts", "mcp.ts", "integrate.ts"]) {
    const contents = await readFile(path.join(projectRoot, "src", file), "utf8");
    assert.doesNotMatch(
      contents,
      /selectQualityWinner|qualitySelectionCommand|quality\.selection_decided/u,
      `${file} must not launch or treat advisory winner selection as canonical`
    );
  }
});

async function withSpeculativeRepo(
  run: (fixture: { repo: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-speculative-draft-"));
  try {
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, ".gitignore"), ".hivemind/\nprovider-spawned.txt\n");
    await writeFile(path.join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "value.js"), "export const value = 'base';\n");
    await writeFile(
      path.join(repo, "test", "smoke.test.js"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('smoke', () => assert.ok(true));\n"
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "speculative fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    assert.equal(await initProject(repo), 0);
    await configureRepo(repo);
    await writeContract(repo, baseCommit);
    await seedCanonicalSentinels(repo);
    await run({ repo, baseCommit });
  } finally {
    await cleanupRepo(repo);
  }
}

async function configureRepo(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  // Declare the tier these cases exercise. Speculative drafting is admitted
  // for High without a promoted value-quality policy, which is the behaviour
  // every case below depends on. Init's default globs route src/** to Medium,
  // so the High intent is stated here instead of inherited from the
  // unmatched-path fallback.
  config.high_globs = ["src/**"];
  config.test_command = "node --check src/value.js";
  config.verification = {
    checks: [{ id: "syntax", command: "node --check src/value.js", entry_files: ["src/value.js"] }]
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    path.join(repo, ".hivemind", "adapters", "marker.profile.json"),
    `${JSON.stringify({
      tool: "marker",
      invoke: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('provider-spawned.txt','spawned')"
      ],
      prompt_transport: "stdin",
      diff_transport: "worktree",
      supports_streaming: false,
      timeout_ms: 1000,
      routing_tier: "strong",
      cost_rank: 1
    }, null, 2)}\n`
  );
}

async function writeContract(
  repo: string,
  baseCommit: string,
  overrides: {
    allowed_files?: string[];
    allowed_file_intents?: Record<string, "create" | "modify">;
  } = {}
): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "tasks", "T-001.contract.json"),
    `${JSON.stringify({
      task_id: "T-001",
      title: "Change value",
      agent_role: "builder",
      routing_task_type: "refactor",
      base_commit: baseCommit,
      acceptance_criterion: "The value module remains syntactically valid.",
      allowed_files: overrides.allowed_files ?? ["src/value.js"],
      allowed_file_intents: overrides.allowed_file_intents ?? { "src/value.js": "modify" },
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node --check src/value.js"],
      patch_requirements: []
    }, null, 2)}\n`
  );
}

async function seedCanonicalSentinels(repo: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "worktrees", "T-001"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "patches", "T-001"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "log", "tasks"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "worktrees", "T-001", "sentinel.txt"), "canonical worktree\n");
  await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "sentinel.txt"), "canonical patch bundle\n");
  await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), "{\"version\":1,\"leases\":[]}\n");
  await writeFile(path.join(repo, ".hivemind", "canon", "sentinel.json"), "{\"canon\":true}\n");
  await writeFile(path.join(repo, ".hivemind", "log", "tasks", "T-001.output.jsonl"), "{\"output\":\"canonical\"}\n");
}

function successfulProducer(checkoutPaths: string[], source: string): SpeculativeDraftProducer {
  return async (checkoutPath) => {
    checkoutPaths.push(checkoutPath);
    await writeFile(path.join(checkoutPath, "src", "value.js"), source);
    return {
      status: "completed",
      output: [{ stream: "stdout", text: "fixture draft complete\n" }]
    };
  };
}

async function canonicalIdentity(repo: string): Promise<Record<string, string>> {
  return {
    head: await gitStdout(repo, ["rev-parse", "HEAD"]),
    status: await gitRawStdout(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    branches: await gitRawStdout(repo, ["branch", "--format=%(refname)"]),
    source: await hashTree(path.join(repo, "src")),
    canonical_worktree: await hashTree(path.join(repo, ".hivemind", "worktrees", "T-001")),
    patch_bundle: await hashTree(path.join(repo, ".hivemind", "patches", "T-001")),
    lease_store: await hashTree(path.join(repo, ".hivemind", "leases")),
    canon: await hashTree(path.join(repo, ".hivemind", "canon")),
    task_output: await hashTree(path.join(repo, ".hivemind", "log", "tasks"))
  };
}

async function canonicalEvents(repo: string): Promise<unknown[]> {
  const events = await readEvents(repo);
  assert.equal(events.ok, true, events.ok ? undefined : events.reason);
  return events.ok
    ? events.value.filter((event) => !event.type.startsWith("quality."))
    : [];
}

async function hashTree(root: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      digest.update(`${relative}\0${entry.isDirectory() ? "dir" : "file"}\0`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        digest.update(await readFile(absolute));
      }
    }
  };
  await visit(root);
  return digest.digest("hex");
}

async function assertOnlyMainCheckoutAndBranch(repo: string): Promise<void> {
  const worktrees = (await gitRawStdout(repo, ["worktree", "list", "--porcelain"]))
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1);
  assert.equal(path.resolve(worktrees[0].slice("worktree ".length)), path.resolve(repo));
  assert.deepEqual(
    (await gitRawStdout(repo, ["branch", "--format=%(refname:short)"]))
      .split(/\r?\n/u)
      .filter(Boolean),
    ["main"]
  );
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cleanupRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitRawStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/u)) {
      if (line.startsWith("worktree ")) {
        const worktreePath = line.slice("worktree ".length);
        if (path.resolve(worktreePath) !== path.resolve(repo)) {
          await git(repo, ["worktree", "remove", "--force", worktreePath]);
        }
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
  return result.stdout;
}
