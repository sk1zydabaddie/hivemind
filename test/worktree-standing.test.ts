import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent } from "../src/events.js";
import { initProject } from "../src/init.js";
import {
  createTentativePlan,
  groundTentativePlan,
  lintTentativePlan,
  ratifyPlan,
  reviewPlanForRatification
} from "../src/plan.js";
import { reconcileLeftoverWorktrees } from "../src/worktree-standing.js";
import { withTemplateRepo } from "./support/fixture-repo.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

/**
 * A-37: a read-only plan task that finished clean kept its worktree forever,
 * and a worktree nothing owns closed the project's idleness proof for good.
 * Reconciliation removes exactly that class -- and these tests hold it to the
 * dangerous direction too: nothing else may be touched, because a write
 * task's worktree carries the work adoption still needs.
 *
 * (The idleness proof's own both-direction guarantees -- live workers keep
 * the guard closed, leftovers do not -- are asserted where that proof lives,
 * in the shell's idleness_tests, against real processes.)
 */

test("reconciliation removes exactly the finished read-only worktree and nothing else", async () => {
  await withStandingRepo(async (repo) => {
    await prepareRatifiedPlan(repo, {
      tasks: [
        task("T-AUDIT", { mode: "read_only", agent_role: "scout" }),
        task("T-DIRTY", { mode: "read_only", agent_role: "scout", depends_on: ["T-AUDIT"] }),
        task("T-WRITE", { depends_on: ["T-DIRTY"] }),
        task("T-WCLEAN", {
          depends_on: ["T-WRITE"],
          draft_scope: {
            allowed_files: ["docs/notes.md"],
            allowed_file_intents: { "docs/notes.md": "create" },
            read_only_files: [],
            forbidden_files: [],
            must_not_change: []
          }
        })
      ],
      execution_groups: [group("G-1", "sequence", ["T-AUDIT", "T-DIRTY", "T-WRITE", "T-WCLEAN"])]
    });
    await realWorktree(repo, "T-AUDIT");
    await realWorktree(repo, "T-DIRTY");
    await realWorktree(repo, "T-WRITE");
    await realWorktree(repo, "T-WCLEAN");
    await start(repo, "T-AUDIT");
    await finish(repo, "T-AUDIT", 0);
    await start(repo, "T-DIRTY");
    /* A read-only task that reported file changes is a contract violation
       under judgment, not a leftover; its evidence must survive. */
    await finish(repo, "T-DIRTY", 3);
    await start(repo, "T-WRITE");
    await finish(repo, "T-WRITE", 2);
    /* A write task that completed with zero changes is the case only the
       MODE check protects -- its worktree still awaits adoption's decision,
       and the changed-files guard alone would happily remove it. */
    await start(repo, "T-WCLEAN");
    await finish(repo, "T-WCLEAN", 0);

    const reconciled = await reconcileLeftoverWorktrees(repo);
    assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.reason);
    if (!reconciled.ok) return;
    assert.deepEqual(reconciled.value.removed, ["T-AUDIT"]);
    assert.equal(existsSync(worktreePath(repo, "T-AUDIT")), false);
    /* The dangerous direction: a write task's worktree carries the work
       adoption still needs, and a dirty read-only run is evidence. */
    assert.equal(existsSync(worktreePath(repo, "T-DIRTY")), true);
    assert.equal(existsSync(worktreePath(repo, "T-WRITE")), true);
    assert.equal(
      existsSync(worktreePath(repo, "T-WCLEAN")),
      true,
      "a zero-change WRITE task's worktree is adoption's to remove, never reconciliation's"
    );
  });
});

test("with no loadable ratified plan, reconciliation removes nothing", async () => {
  await withStandingRepo(async (repo) => {
    await mkdir(worktreePath(repo, "T-ORPHAN"), { recursive: true });
    await start(repo, "T-ORPHAN");
    await finish(repo, "T-ORPHAN");

    const reconciled = await reconcileLeftoverWorktrees(repo);
    assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.reason);
    if (!reconciled.ok) return;
    assert.deepEqual(reconciled.value.removed, [], "no plan means no proof, and no proof removes nothing");
    assert.equal(existsSync(worktreePath(repo, "T-ORPHAN")), true);
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────── */

async function withStandingRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "worktree-standing",
    async (repo) => {
      const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
      await git(["init"]);
      await git(["config", "user.name", "Hivemind Test"]);
      await git(["config", "user.email", "hivemind@example.test"]);
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await git(["add", "."]);
      await git(["commit", "-m", "initial"]);
      await initProject(repo);
      await createRatifiedSpec(repo);
    },
    run,
    "hivemind-worktree-standing-"
  );
}

function worktreePath(repo: string, taskId: string): string {
  return path.join(repo, ".hivemind", "worktrees", taskId);
}

/** Reconciliation runs real `git worktree remove`, so it gets real worktrees. */
async function realWorktree(repo: string, taskId: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "worktrees"), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", path.join(".hivemind", "worktrees", taskId), "-b", `hivemind/${taskId}`, "HEAD"],
    { cwd: repo, windowsHide: true }
  );
}

async function start(repo: string, taskId: string): Promise<void> {
  const event = await appendEvent(repo, { type: "task.started", task_id: taskId, data: { task_id: taskId } });
  assert.equal(event.ok, true, event.ok ? undefined : event.reason);
}

async function finish(repo: string, taskId: string, changedFiles = 0): Promise<void> {
  const event = await appendEvent(repo, {
    type: "task.completed",
    task_id: taskId,
    data: { task_id: taskId, status: "completed", changed_files: changedFiles }
  });
  assert.equal(event.ok, true, event.ok ? undefined : event.reason);
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

function task(taskId: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    task_id: taskId,
    title: `Task ${taskId}`,
    task_type: "deterministic",
    routing_task_type: "other",
    mode: "write",
    agent_role: "builder",
    draft_scope: {
      allowed_files: ["README.md"],
      read_only_files: [],
      forbidden_files: [],
      must_not_change: []
    },
    depends_on: [],
    parallel_safe: true,
    acceptance_criterion: "One binary acceptance check passes.",
    required_tests: ["npm run typecheck"],
    patch_requirements: ["submit diff only"],
    ...overrides
  };
}

function group(groupId: string, mode: string, taskIds: string[]): Record<string, unknown> {
  return { group_id: groupId, mode, task_ids: taskIds };
}
