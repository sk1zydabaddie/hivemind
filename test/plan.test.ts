import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../src/ideation.js";
import { initProject } from "../src/init.js";
import { createSpec, ratifySpec } from "../src/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("plan propose writes a tentative plan without creating executable task state", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, validPlan());

    const result = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], {
      cwd: repo,
      windowsHide: true
    });

    assert.deepEqual(JSON.parse(result.stdout), {
      spec_id: "S-001",
      plan_path: ".hivemind/plans/S-001.tentative.json",
      status: "tentative",
      base_commit: baseCommit,
      task_count: 3,
      execution_group_count: 2
    });
    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      version: number;
      spec_id: string;
      status: string;
      base_commit: string;
      source: string;
      tasks: Array<{ task_id: string; scope_status: string }>;
      execution_groups: Array<{ group_id: string; mode: string; task_ids: string[] }>;
    };
    assert.equal(stored.version, 1);
    assert.equal(stored.spec_id, "S-001");
    assert.equal(stored.status, "tentative");
    assert.equal(stored.base_commit, baseCommit);
    assert.equal(stored.source, "cli-json");
    assert.deepEqual(
      stored.tasks.map((task) => [task.task_id, task.scope_status]),
      [
        ["T-AUDIT", "draft_ungrounded"],
        ["T-WRITE", "draft_ungrounded"],
        ["T-INTEGRATE", "draft_ungrounded"]
      ]
    );
    assert.deepEqual(stored.execution_groups, [
      { group_id: "G-1", mode: "parallel", task_ids: ["T-AUDIT"] },
      { group_id: "G-2", mode: "sequence", task_ids: ["T-WRITE", "T-INTEGRATE"] }
    ]);
    await assertMissing(path.join(repo, ".hivemind", "tasks", "T-WRITE.contract.json"));
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-WRITE"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-WRITE"));
    await assertMissing(path.join(repo, ".hivemind", "integration", "queue.json"));
  });
});

test("plan propose refuses draft inactive missing or invalid specs before writing", async () => {
  await withTempRepo(async ({ repo }) => {
    const planPath = await writePlan(repo, validPlan());
    await createSpec(repo, "S-DRAFT", "Draft plan");

    await assertPlanRejects(repo, ["plan", "S-DRAFT", "--propose", planPath], /active spec S-DRAFT is draft/);
    await assertMissing(path.join(repo, ".hivemind", "plans", "S-DRAFT.tentative.json"));

    await createRatifiedSpec(repo, "S-ACTIVE");
    await assertPlanRejects(repo, ["plan", "S-DRAFT", "--propose", planPath], /spec S-DRAFT is not active; active spec is S-ACTIVE/);
    await assertPlanRejects(repo, ["plan", "S-MISSING", "--propose", planPath], /spec S-MISSING is not active; active spec is S-ACTIVE/);

    await writeFile(path.join(repo, ".hivemind", "spec", "S-ACTIVE.md"), "# Spec: Broken\nstatus: ratified\n");
    await assertPlanRejects(repo, ["plan", "S-ACTIVE", "--propose", planPath], /active spec S-ACTIVE is invalid/);
    await assertMissing(path.join(repo, ".hivemind", "plans", "S-ACTIVE.tentative.json"));
  });
});

test("plan propose rejects malformed proposals before writing", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const cases: Array<[string, unknown, RegExp]> = [
      ["duplicate task ids", { ...validPlan(), tasks: [task("T-001"), task("T-001")] }, /duplicates T-001/],
      ["invalid task id", { ...validPlan(), tasks: [task("../bad")] }, /invalid task id/],
      ["empty title", { ...validPlan(), tasks: [{ ...task("T-001"), title: "" }] }, /title must be a non-empty string/],
      ["invalid mode", { ...validPlan(), tasks: [{ ...task("T-001"), mode: "edit" }] }, /mode must be read_only, write, or integration/],
      ["invalid role", { ...validPlan(), tasks: [{ ...task("T-001"), agent_role: "driver" }] }, /agent_role must be coordinator, scout, builder, or reviewer/],
      ["non-string path", { ...validPlan(), tasks: [{ ...task("T-001"), draft_scope: { ...draftScope(["README.md"]), allowed_files: [7] } }] }, /allowed_files\[0\] must be a string/],
      ["unknown dependency", { ...validPlan(), tasks: [{ ...task("T-001"), depends_on: ["T-MISSING"] }] }, /depends_on references unknown task T-MISSING/],
      ["unknown group task", { tasks: [task("T-001")], execution_groups: [group("G-1", "parallel", ["T-MISSING"])] }, /references unknown task T-MISSING/],
      ["repeated group task", { tasks: [task("T-001")], execution_groups: [group("G-1", "parallel", ["T-001", "T-001"])] }, /repeats task T-001/],
      ["empty acceptance", { ...validPlan(), tasks: [{ ...task("T-001"), acceptance_criterion: "" }] }, /acceptance_criterion must be a non-empty string/],
      ["base commit supplied", { ...validPlan(), base_commit: "do-not-trust-me" }, /unsupported top-level field: base_commit/]
    ];

    for (const [name, body, pattern] of cases) {
      const planPath = await writePlan(repo, body, `${name.replaceAll(" ", "-")}.json`);
      await assertPlanRejects(repo, ["plan", "S-001", "--propose", planPath], pattern);
      await assertMissing(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"));
    }
  });
});

test("plan propose rejects task ids that collide with existing contracts", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit);
    const planPath = await writePlan(repo, { tasks: [task("T-001")], execution_groups: [group("G-1", "parallel", ["T-001"])] });

    await assertPlanRejects(repo, ["plan", "S-001", "--propose", planPath], /collides with existing contract/);
    await assertMissing(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"));
  });
});

test("plan propose accepts overlaps and cycles because M5.6 plan-lint owns them", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [
        { ...task("T-001"), draft_scope: draftScope(["README.md"]), depends_on: ["T-002"] },
        { ...task("T-002"), draft_scope: draftScope(["README.md"]), depends_on: ["T-001"] }
      ],
      execution_groups: [group("G-1", "parallel", ["T-001", "T-002"])]
    });

    const result = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], {
      cwd: repo,
      windowsHide: true
    });

    assert.equal(JSON.parse(result.stdout).task_count, 2);
    assert.equal(await exists(path.join(repo, ".hivemind", "plans", "S-001.tentative.json")), true);
  });
});

test("plan check preserves the M5.1 ratified planning gate behavior", async () => {
  await withTempRepo(async ({ repo }) => {
    await createSpec(repo, "S-DRAFT", "Draft check");

    await assertPlanRejects(repo, ["plan", "S-DRAFT", "--check"], /active spec S-DRAFT is draft/);

    await createRatifiedSpec(repo, "S-001");
    const result = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--check"], {
      cwd: repo,
      windowsHide: true
    });

    assert.deepEqual(JSON.parse(result.stdout), { spec_id: "S-001", status: "ratified", planning: "allowed" });
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-plan-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function createRatifiedSpec(repo: string, specId: string): Promise<void> {
  const created = await createSpec(repo, specId, "Planning target");
  assert.equal(created.ok, true);
  const started = await startIdeationSession(repo, specId, "Planning target", "Planning target");
  assert.equal(started.ok, true);
  const round = await recordIdeationRound(repo, specId, {
    alternatives: [
      { title: "Small", tradeoffs: ["Fastest path"] },
      { title: "Broad", tradeoffs: ["More complete"] }
    ],
    self_critique: {
      weakest_point: "The spec is sparse.",
      cut_or_change: "Keep the tentative plan small."
    },
    spec_updates: {
      "Non-goals": "No grounding or plan-lint in M5.4.",
      "Open questions": ""
    },
    substantive_change: true,
    orchestrator_calls_convergence: true
  });
  assert.equal(round.ok, true);
  const userConverged = await markIdeationConvergence(repo, specId, "user");
  assert.equal(userConverged.ok, true);
  const ratified = await ratifySpec(repo, specId);
  assert.equal(ratified.ok, true);
}

function validPlan(): Record<string, unknown> {
  return {
    tasks: [
      task("T-AUDIT", { mode: "read_only", agent_role: "scout", parallel_safe: true }),
      task("T-WRITE", { depends_on: ["T-AUDIT"] }),
      task("T-INTEGRATE", { mode: "integration", depends_on: ["T-WRITE"], draft_scope: draftScope([]), parallel_safe: false })
    ],
    execution_groups: [group("G-1", "parallel", ["T-AUDIT"]), group("G-2", "sequence", ["T-WRITE", "T-INTEGRATE"])]
  };
}

function task(
  taskId: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    task_id: taskId,
    title: `Task ${taskId}`,
    mode: "write",
    agent_role: "builder",
    draft_scope: draftScope(["README.md"]),
    depends_on: [],
    parallel_safe: true,
    acceptance_criterion: "One binary acceptance check passes.",
    required_tests: ["npm run typecheck"],
    patch_requirements: ["submit diff only"],
    ...overrides
  };
}

function draftScope(allowedFiles: unknown[]): Record<string, unknown> {
  return {
    allowed_files: allowedFiles,
    read_only_files: [],
    forbidden_files: [],
    must_not_change: []
  };
}

function group(groupId: string, mode: string, taskIds: string[]): Record<string, unknown> {
  return { group_id: groupId, mode, task_ids: taskIds };
}

async function writePlan(repo: string, body: unknown, name = "plan.json"): Promise<string> {
  const filePath = path.join(repo, name);
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
  return filePath;
}

async function writeContract(repo: string, taskId: string, baseCommit: string): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Existing task",
        agent_role: "builder",
        base_commit: baseCommit,
        allowed_files: ["README.md"],
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: [],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function assertPlanRejects(repo: string, args: string[], pattern: RegExp): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, ...args], { cwd: repo, windowsHide: true }),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, 1);
      assert.match(String((error as { stderr?: string }).stderr), pattern);
      return true;
    }
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertMissing(filePath: string): Promise<void> {
  assert.equal(await exists(filePath), false);
}
