import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, rename } from "node:fs/promises";
import path from "node:path";

import { loadAndValidateContract } from "../../src/contract.js";
import {
  createTentativePlan,
  groundTentativePlan,
  lintTentativePlan,
  loadCurrentRatifiedPlan,
  ratifyPlan,
  reviewPlanForRatification
} from "../../src/plan.js";
import { requireActiveSpecRatified } from "../../src/spec.js";

/**
 * Older fixtures made a hand-written contract executable through the deleted
 * manual-task exception. Production now requires one ratified plan, so tests
 * that exercise a later gate materialize that same authority instead of
 * preserving a test-only bypass.
 */
export async function ratifyPlanForExistingTask(
  repo: string,
  taskId: string,
  specId = "S-001"
): Promise<void> {
  const spec = await requireActiveSpecRatified(repo);
  assert.equal(spec.ok, true, spec.ok ? undefined : spec.reason);
  if (!spec.ok) return;
  assert.equal(spec.value.spec_id, specId, `test fixture expected active spec ${specId}`);

  const ratified = await loadCurrentRatifiedPlan(repo, specId, "test fixture");
  const review = await reviewPlanForRatification(repo, specId);
  if (review.ok) {
    if (review.value.plan.tasks.some((task) => task.task_id === taskId)) {
      const approved = await ratifyPlan(repo, specId, review.value.plan_hash);
      assert.equal(approved.ok, true, approved.ok ? undefined : approved.reason);
      await assertTaskIsCurrentlyRatified(repo, specId, taskId);
      return;
    }
  }

  const contract = await loadAndValidateContract(repo, taskId);
  /* Invalid-contract tests must reach the contract gate without acquiring
     unrelated plan authority. Their own assertion checks the refusal. */
  if (!contract.ok) return;
  const task = contract.contract;
  const priorPlan = ratified.ok ? ratified.value : review.ok ? review.value.plan : undefined;
  const existingTasks = priorPlan === undefined
    ? []
    : priorPlan.tasks.map((entry) => ({
        task_id: entry.task_id,
        title: entry.title,
        task_type: entry.task_type,
        routing_task_type: entry.routing_task_type,
        mode: entry.mode,
        agent_role: entry.agent_role,
        draft_scope: entry.draft_scope,
        depends_on: entry.depends_on,
        parallel_safe: entry.parallel_safe,
        acceptance_criterion: entry.acceptance_criterion,
        ...(entry.deterministic_validity_check === undefined
          ? {}
          : { deterministic_validity_check: entry.deterministic_validity_check }),
        required_tests: entry.required_tests,
        patch_requirements: entry.patch_requirements,
        critical_path_approved: entry.critical_path_approved
      }));
  const tasks = [
    ...existingTasks.filter((entry) => entry.task_id !== taskId),
    {
      task_id: task.task_id,
      title: task.title,
      task_type: "generative" as const,
      routing_task_type: task.routing_task_type,
      mode: task.allowed_files.length === 0 ? "read_only" as const : "write" as const,
      agent_role: task.agent_role,
      draft_scope: {
        allowed_files: task.allowed_files,
        allowed_file_intents: task.allowed_file_intents,
        /* Legacy downstream fixtures often name absent files as defensive
           exclusions. They do not widen write authority, but grounding quite
           correctly requires cited read/forbidden paths to exist. Keep the
           executable write scope exact; the contract retains both exclusions. */
        read_only_files: [],
        forbidden_files: [],
        must_not_change: task.must_not_change
      },
      depends_on: [],
      parallel_safe: true,
      acceptance_criterion: `Behavioral: human confirms ${task.acceptance_criterion}`,
      required_tests: task.required_tests,
      patch_requirements: task.patch_requirements,
      critical_path_approved: false
    }
  ];
  const hiddenContracts: Array<{ source: string; hidden: string }> = [];
  for (const entry of tasks) {
    const source = path.join(repo, ".hivemind", "tasks", `${entry.task_id}.contract.json`);
    try {
      await access(source);
    } catch {
      continue;
    }
    const hidden = `${source}.plan-fixture-${randomUUID()}`;
    await rename(source, hidden);
    hiddenContracts.push({ source, hidden });
  }

  let created: Awaited<ReturnType<typeof createTentativePlan>>;
  try {
    created = await createTentativePlan(repo, specId, {
      tasks,
      execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: tasks.map((entry) => entry.task_id) }]
    });
  } finally {
    for (const hidden of hiddenContracts.reverse()) {
      await rename(hidden.hidden, hidden.source);
    }
  }
  assert.equal(created.ok, true, created.ok ? undefined : created.reason);
  const grounded = await groundTentativePlan(repo, specId);
  /* Some lower-gate tests intentionally use scope that planning refuses. Do
     not manufacture authority for it; the public path must stop at the plan. */
  if (!grounded.ok) {
    if (/allowed_files (?:create )?path/u.test(grounded.reason)) return;
    assert.fail(grounded.reason);
  }
  const linted = await lintTentativePlan(repo, specId);
  if (!linted.ok) {
    if (/LEASE_LIFETIME_SCOPE_OVERLAP/u.test(linted.reason)) return;
    assert.fail(linted.reason);
  }
  const finalReview = await reviewPlanForRatification(repo, specId);
  assert.equal(finalReview.ok, true, finalReview.ok ? undefined : finalReview.reason);
  if (!finalReview.ok) return;
  const approved = await ratifyPlan(repo, specId, finalReview.value.plan_hash);
  assert.equal(approved.ok, true, approved.ok ? undefined : approved.reason);
  await assertTaskIsCurrentlyRatified(repo, specId, taskId);
}

async function assertTaskIsCurrentlyRatified(repo: string, specId: string, taskId: string): Promise<void> {
  const current = await loadCurrentRatifiedPlan(repo, specId, "test fixture verification");
  assert.equal(current.ok, true, current.ok ? undefined : current.reason);
  if (!current.ok) return;
  assert.equal(
    current.value.tasks.some((task) => task.task_id === taskId),
    true,
    `test fixture did not ratify ${taskId}`
  );
}
