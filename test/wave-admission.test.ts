import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../src/ideation.js";
import { initProject } from "../src/init.js";
import { readActiveLeases } from "../src/lease.js";
import {
  createTentativePlan,
  groundTentativePlan,
  lintTentativePlan,
  ratifyPlan,
  reviewPlanForRatification
} from "../src/plan.js";
import { createSpec, ratifySpec } from "../src/spec.js";
import { captureVerificationInputs, writeVerificationSet } from "../src/verification-set.js";
import { admitExecutionWave } from "../src/wave-admission.js";

const execFileAsync = promisify(execFile);

test("parallel admission permits disjoint writes and shared read-only dependencies without mutation", async () => {
  await withTempRepo(async ({ repo }) => {
    await prepareRatifiedPlan(repo, {
      tasks: [
        task("T-ONE", ["src/one.ts"], { readOnly: ["src/shared.ts"] }),
        task("T-TWO", ["src/two.ts"], { readOnly: ["src/shared.ts"] })
      ],
      execution_groups: [group("G-PARALLEL", "parallel", ["T-ONE", "T-TWO"])]
    });
    const beforeEvents = await readEvents(repo);
    assert.equal(beforeEvents.ok, true);
    const beforeLeases = await readActiveLeases(repo);
    assert.equal(beforeLeases.ok, true);

    const admitted = await admitExecutionWave(repo, "S-001", "G-PARALLEL");

    assert.equal(admitted.ok, true, admitted.ok ? undefined : admitted.reason);
    if (admitted.ok) {
      assert.deepEqual(admitted.value.admitted_task_ids, ["T-ONE", "T-TWO"]);
      assert.deepEqual(admitted.value.waiting_task_ids, []);
    }
    const afterEvents = await readEvents(repo);
    assert.equal(afterEvents.ok, true);
    if (beforeEvents.ok && afterEvents.ok) assert.deepEqual(afterEvents.value, beforeEvents.value);
    const afterLeases = await readActiveLeases(repo);
    assert.deepEqual(afterLeases, beforeLeases);
  });
});

test("parallel admission holds a task until every dependency is verified", async () => {
  await withTempRepo(async ({ repo }) => {
    await prepareRatifiedPlan(repo, {
      tasks: [
        task("T-DEP", ["src/shared.ts"]),
        task("T-READY", ["src/one.ts"]),
        task("T-WAITS", ["src/two.ts"], { dependsOn: ["T-DEP"] })
      ],
      execution_groups: [
        group("G-FIRST", "sequence", ["T-DEP"]),
        group("G-WAVE", "parallel", ["T-READY", "T-WAITS"])
      ]
    });

    const before = await admitExecutionWave(repo, "S-001", "G-WAVE");
    assert.equal(before.ok, true, before.ok ? undefined : before.reason);
    if (before.ok) {
      assert.deepEqual(before.value.admitted_task_ids, ["T-READY"]);
      assert.deepEqual(before.value.waiting_task_ids, ["T-WAITS"]);
    }

    assert.equal((await appendEvent(repo, { type: "patch.submitted", task_id: "T-DEP", data: {} })).ok, true);
    assert.equal((await appendEvent(repo, { type: "patch.accepted", task_id: "T-DEP", data: { verdict: "accept" } })).ok, true);
    assert.equal((await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-DEP"] } })).ok, true);
    const bareEvent = await admitExecutionWave(repo, "S-001", "G-WAVE");
    assert.equal(bareEvent.ok, true, bareEvent.ok ? undefined : bareEvent.reason);
    if (bareEvent.ok) assert.deepEqual(bareEvent.value.waiting_task_ids, ["T-WAITS"]);

    await recordVerified(repo, "T-DEP");
    const after = await admitExecutionWave(repo, "S-001", "G-WAVE");
    assert.equal(after.ok, true, after.ok ? undefined : after.reason);
    if (after.ok) {
      assert.deepEqual(after.value.admitted_task_ids, ["T-READY", "T-WAITS"]);
      assert.deepEqual(after.value.waiting_task_ids, []);
    }
  });
});

test("runtime admission refuses a canonical alias conflict missed by lexical plan lint", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, "real"));
    await mkdir(path.join(repo, "alias"));
    await prepareRatifiedPlan(repo, {
      tasks: [
        task("T-REAL", ["real/new.ts"], { create: true }),
        task("T-ALIAS", ["alias/new.ts"], { create: true })
      ],
      execution_groups: [group("G-ALIAS", "parallel", ["T-REAL", "T-ALIAS"])]
    });
    await rm(path.join(repo, "alias"), { recursive: true });
    await symlink(path.join(repo, "real"), path.join(repo, "alias"), process.platform === "win32" ? "junction" : "dir");

    const admitted = await admitExecutionWave(repo, "S-001", "G-ALIAS");

    assert.equal(admitted.ok, false);
    if (!admitted.ok) assert.match(admitted.reason, /canonical write conflict.*T-REAL and T-ALIAS.*real\/new\.ts/);
  });
});

test("runtime admission fails closed if a ratified parallel task is not parallel-safe", async () => {
  await withTempRepo(async ({ repo }) => {
    await prepareRatifiedPlan(repo, {
      tasks: [task("T-ONE", ["src/one.ts"])],
      execution_groups: [group("G-PARALLEL", "parallel", ["T-ONE"])]
    });
    const ratifiedPath = path.join(repo, ".hivemind", "plans", "ratified", "S-001");
    const files = await readdir(ratifiedPath);
    const raw = JSON.parse(await readFile(path.join(ratifiedPath, files[0]), "utf8")) as {
      base_commit: string;
      tasks: Array<{ task_id: string; parallel_safe: boolean }>;
    };
    raw.tasks[0].parallel_safe = false;
    const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const relativePath = `.hivemind/plans/ratified/S-001/${hash}.json`;
    await writeFile(path.join(repo, relativePath), `${JSON.stringify(raw, null, 2)}\n`);
    assert.equal((await appendEvent(repo, {
      type: "plan.ratified",
      task_id: null,
      data: {
        version: 1,
        spec_id: "S-001",
        plan_hash: hash,
        plan_path: relativePath,
        base_commit: raw.base_commit,
        task_count: raw.tasks.length,
        confirmation: "exact_plan_hash",
        authorization_source: "human",
        autonomy_level: "review_everything"
      }
    })).ok, true);

    const admitted = await admitExecutionWave(repo, "S-001", "G-PARALLEL");

    assert.equal(admitted.ok, false);
    if (!admitted.ok) assert.match(admitted.reason, /task T-ONE is not parallel_safe/);
  });
});

test("sequence admission preserves one-at-a-time plan order", async () => {
  await withTempRepo(async ({ repo }) => {
    await prepareRatifiedPlan(repo, {
      tasks: [task("T-FIRST", ["src/one.ts"]), task("T-SECOND", ["src/two.ts"])],
      execution_groups: [group("G-SEQUENCE", "sequence", ["T-FIRST", "T-SECOND"])]
    });

    const first = await admitExecutionWave(repo, "S-001", "G-SEQUENCE");
    assert.equal(first.ok, true, first.ok ? undefined : first.reason);
    if (first.ok) assert.deepEqual(first.value.admitted_task_ids, ["T-FIRST"]);

    await recordVerified(repo, "T-FIRST");
    const second = await admitExecutionWave(repo, "S-001", "G-SEQUENCE");
    assert.equal(second.ok, true, second.ok ? undefined : second.reason);
    if (second.ok) assert.deepEqual(second.value.admitted_task_ids, ["T-SECOND"]);
  });
});

async function withTempRepo(run: (context: { repo: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-wave-admission-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "one.ts"), "export const one = 1;\n");
    await writeFile(path.join(repo, "src", "two.ts"), "export const two = 2;\n");
    await writeFile(path.join(repo, "src", "shared.ts"), "export const shared = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function prepareRatifiedPlan(repo: string, proposal: Record<string, unknown>): Promise<void> {
  const created = await createTentativePlan(repo, "S-001", proposal);
  assert.equal(created.ok, true, created.ok ? undefined : created.reason);
  const grounded = await groundTentativePlan(repo, "S-001");
  assert.equal(grounded.ok, true, grounded.ok ? undefined : grounded.reason);
  const linted = await lintTentativePlan(repo, "S-001");
  assert.equal(linted.ok, true, linted.ok ? undefined : linted.reason);
  const review = await reviewPlanForRatification(repo, "S-001");
  assert.equal(review.ok, true, review.ok ? undefined : review.reason);
  if (!review.ok) return;
  const ratified = await ratifyPlan(repo, "S-001", review.value.plan_hash);
  assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);
}

async function createRatifiedSpec(repo: string): Promise<void> {
  assert.equal((await createSpec(repo, "S-001", "Concurrent execution fixture")).ok, true);
  assert.equal((await startIdeationSession(repo, "S-001", "Concurrent execution fixture", "Concurrent execution fixture")).ok, true);
  assert.equal((await recordIdeationRound(repo, "S-001", {
    alternatives: [
      { title: "Bounded wave", tradeoffs: ["Small initial cap"] },
      { title: "Serial", tradeoffs: ["No speedup"] }
    ],
    self_critique: { weakest_point: "Runtime aliases remain possible.", cut_or_change: "Recheck paths at admission." },
    spec_updates: { "Non-goals": "No concurrent scheduler in M10.1.", "Open questions": "" },
    substantive_change: true,
    orchestrator_calls_convergence: true
  })).ok, true);
  assert.equal((await markIdeationConvergence(repo, "S-001", "user")).ok, true);
  assert.equal((await ratifySpec(repo, "S-001")).ok, true);
}

function task(
  taskId: string,
  allowedFiles: string[],
  options: { readOnly?: string[]; dependsOn?: string[]; create?: boolean } = {}
): Record<string, unknown> {
  return {
    task_id: taskId,
    title: `Task ${taskId}`,
    task_type: "deterministic",
    routing_task_type: "other",
    mode: "write",
    agent_role: "builder",
    draft_scope: {
      allowed_files: allowedFiles,
      ...(options.create ? { allowed_file_intents: Object.fromEntries(allowedFiles.map((file) => [file, "create"])) } : {}),
      read_only_files: options.readOnly ?? [],
      forbidden_files: [],
      must_not_change: []
    },
    depends_on: options.dependsOn ?? [],
    parallel_safe: true,
    acceptance_criterion: "The deterministic fixture result is correct.",
    required_tests: ["npm test"],
    patch_requirements: ["Submit only the scoped diff."]
  };
}

function group(groupId: string, mode: "parallel" | "sequence", taskIds: string[]): Record<string, unknown> {
  return { group_id: groupId, mode, task_ids: taskIds };
}

async function recordVerified(repo: string, taskId: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "patches", taskId), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`), `${JSON.stringify({ task_id: taskId })}\n`);
  await writeFile(path.join(repo, ".hivemind", "patches", taskId, "diff.patch"), `fixture patch for ${taskId}\n`);
  const inputs = await captureVerificationInputs(repo, [taskId]);
  assert.equal(inputs.ok, true, inputs.ok ? undefined : inputs.reason);
  if (!inputs.ok) return;
  const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
  const resultTree = await gitStdout(repo, ["rev-parse", "HEAD^{tree}"]);
  const verification = await writeVerificationSet(repo, {
    base_branch: await gitStdout(repo, ["branch", "--show-current"]),
    base_commit: baseCommit,
    task_ids: [taskId],
    inputs: inputs.value.inputs,
    changed_files: ["src/shared.ts"],
    result_tree: resultTree,
    config_path: ".hivemind/config.json",
    config_sha256: inputs.value.config_sha256,
    verification: { audit: {}, checks: {}, runtime_coverage: {}, tests: "pass" },
    oracle: {
      coverage_configured: false,
      binding: false,
      task_tier: "medium",
      status: "unconfigured",
      decision: "proceed",
      diagnostic: "fixture verification passed",
      uncovered_changed_lines: [],
      uncovered_impact_files: [],
      unknown_files: [],
      unknown_reasons: [],
      recommendation: null,
      automatic_generation_launched: false
    }
  });
  assert.equal(verification.ok, true, verification.ok ? undefined : verification.reason);
  if (!verification.ok) return;
  assert.equal((await appendEvent(repo, { type: "patch.submitted", task_id: taskId, data: {} })).ok, true);
  assert.equal((await appendEvent(repo, { type: "patch.accepted", task_id: taskId, data: { verdict: "accept" } })).ok, true);
  assert.equal((await appendEvent(repo, {
    type: "integration.passed",
    task_id: null,
    data: {
      applied: [taskId],
      verification_id: verification.value.manifest.verification_id,
      verification_manifest_path: verification.value.manifest_path,
      verification_manifest_sha256: verification.value.manifest_sha256
    }
  })).ok, true);
}

async function git(repo: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repo, windowsHide: true });
}

async function gitStdout(repo: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: repo, windowsHide: true })).stdout.trim();
}
