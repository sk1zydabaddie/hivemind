import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent } from "../src/events.js";
import { createTaskContract } from "../src/contract.js";
import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../src/ideation.js";
import { initProject } from "../src/init.js";
import { requestLeaseForContract } from "../src/lease.js";
import { createSpec, ratifySpec } from "../src/spec.js";
import {
  authorizeManualTask,
  createTentativePlan,
  groundTentativePlan,
  lintTentativePlan,
  ratifyPlan,
  requireTaskDependenciesIntegrated,
  reviewManualTaskForAuthorization,
  reviewPlanForRatification
} from "../src/plan.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("execution contracts require an exact explicitly ratified plan", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const proposal = {
      tasks: [task("T-001")],
      execution_groups: [group("G-1", "sequence", ["T-001"])]
    };
    assert.equal((await createTentativePlan(repo, "S-001", proposal)).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    const contract = {
      task_id: "T-001",
      title: "Task T-001",
      agent_role: "builder",
      routing_task_type: "other",
      base_commit: baseCommit,
      acceptance_criterion: "One binary acceptance check passes.",
      allowed_files: ["README.md"],
      allowed_file_intents: { "README.md": "modify" },
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["npm run typecheck"],
      patch_requirements: ["submit diff only"]
    };
    assert.equal((await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "ratify T-001 and approve this plan" }
    })).ok, true);
    const before = await createTaskContract(repo, contract);
    assert.equal(before.ok, false);
    if (!before.ok) assert.match(before.reason, /explicitly ratified plan/u);
    await writeContract(repo, "T-001", baseCommit);
    const executionBypass = await requestLeaseForContract(repo, "T-001");
    assert.equal(executionBypass.ok, false);
    if (!executionBypass.ok) assert.match(executionBypass.reason, /explicitly ratified plan/u);
    await rm(path.join(repo, ".hivemind", "tasks", "T-001.contract.json"));

    const review = await reviewPlanForRatification(repo, "S-001");
    assert.equal(review.ok, true);
    if (!review.ok) return;
    assert.match(review.value.plan_hash, /^[a-f0-9]{64}$/u);
    const wrong = await ratifyPlan(repo, "S-001", "0".repeat(64));
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.match(wrong.reason, /plan changed after review/u);
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: review.value.plan_hash }
    });
    assert.equal(ratified.ok, true);
    const after = await createTaskContract(repo, contract);
    assert.equal(after.ok, true);
    await appendEvent(repo, { type: "task.started", task_id: "T-001", data: { run_id: "run-1" } });
    const edit = await executeWorkspaceAction(repo, {
      type: "plan.amend",
      payload: { spec_id: "S-001", amendment: { kind: "edit_task", task: task("T-001", { title: "Changed while running" }) } }
    });
    assert.equal(edit.ok, false);
    if (!edit.ok) assert.match(edit.reason, /has started.*immutable/u);

    const addition = await executeWorkspaceAction(repo, {
      type: "plan.amend",
      payload: {
        spec_id: "S-001",
        amendment: {
          kind: "add_task",
          task: task("T-002", { depends_on: ["T-001"] }),
          execution_group: { group_id: "G-2", mode: "sequence" }
        }
      }
    });
    assert.equal(addition.ok, true);
  });
});

test("a contract omitted from an unratified tentative plan cannot escape through manual authorization", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    assert.equal((await createTentativePlan(repo, "S-001", {
      tasks: [task("T-PLANNED")],
      execution_groups: [group("G-1", "sequence", ["T-PLANNED"])]
    })).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    await writeContract(repo, "T-OMITTED", baseCommit);

    const manualReview = await reviewManualTaskForAuthorization(repo, "S-001", "T-OMITTED");
    assert.equal(manualReview.ok, false);
    if (!manualReview.ok) assert.match(manualReview.reason, /has a tentative plan/u);
    const dependency = await requireTaskDependenciesIntegrated(repo, "S-001", "T-OMITTED");
    assert.equal(dependency.ok, false);
    if (!dependency.ok) assert.match(dependency.reason, /explicitly ratified plan/u);
    const lease = await requestLeaseForContract(repo, "T-OMITTED");
    assert.equal(lease.ok, false);
    if (!lease.ok) assert.match(lease.reason, /explicitly ratified plan/u);
  });
});

test("a planless manual contract requires an exact durable authorization and changes require re-authorization", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-MANUAL", baseCommit);
    const before = await requireTaskDependenciesIntegrated(repo, "S-001", "T-MANUAL");
    assert.equal(before.ok, false);
    const review = await reviewManualTaskForAuthorization(repo, "S-001", "T-MANUAL");
    assert.equal(review.ok, true, review.ok ? undefined : review.reason);
    if (!review.ok) return;
    const authorized = await authorizeManualTask(repo, "S-001", "T-MANUAL", review.value.contract_hash);
    assert.equal(authorized.ok, true, authorized.ok ? undefined : authorized.reason);
    assert.equal((await requireTaskDependenciesIntegrated(repo, "S-001", "T-MANUAL")).ok, true);

    const contractPath = path.join(repo, ".hivemind", "tasks", "T-MANUAL.contract.json");
    const contract = JSON.parse(await readFile(contractPath, "utf8")) as Record<string, unknown>;
    await writeFile(contractPath, `${JSON.stringify({ ...contract, title: "Changed after authorization" }, null, 2)}\n`);
    const changed = await requireTaskDependenciesIntegrated(repo, "S-001", "T-MANUAL");
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.match(changed.reason, /requires explicit authorization/u);
  });
});

test("regenerating a ratified plan requires exact re-ratification before new plan content can execute", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    assert.equal((await createTentativePlan(repo, "S-001", {
      tasks: [task("T-001")],
      execution_groups: [group("G-1", "sequence", ["T-001"])]
    })).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    const firstReview = await reviewPlanForRatification(repo, "S-001");
    assert.equal(firstReview.ok, true);
    if (!firstReview.ok) return;
    assert.equal((await ratifyPlan(repo, "S-001", firstReview.value.plan_hash)).ok, true);

    assert.equal((await createTentativePlan(repo, "S-001", {
      tasks: [task("T-001"), task("T-002")],
      execution_groups: [group("G-1", "sequence", ["T-001", "T-002"])]
    })).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    const secondContract = contractForTask("T-002", baseCommit);
    const beforeReratification = await createTaskContract(repo, secondContract);
    assert.equal(beforeReratification.ok, false);
    if (!beforeReratification.ok) assert.match(beforeReratification.reason, /not present in the active ratified plan/u);

    const secondReview = await reviewPlanForRatification(repo, "S-001");
    assert.equal(secondReview.ok, true);
    if (!secondReview.ok) return;
    assert.notEqual(secondReview.value.plan_hash, firstReview.value.plan_hash);
    assert.equal((await ratifyPlan(repo, "S-001", secondReview.value.plan_hash)).ok, true);
    assert.equal((await createTaskContract(repo, secondContract)).ok, true);
  });
});

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
      ["invalid routing task type", { ...validPlan(), tasks: [{ ...task("T-001"), routing_task_type: "small_cli_command" }] }, /routing_task_type must be one of/],
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

test("plan generator writes an adapter proposal that still goes through ground and lint", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeFakePlanningAdapter(repo, validPlan());

    const generated = await execFileAsync(
      process.execPath,
      [cliPath, "plan", "S-001", "--generate", "--tool", "fake-planner", "--out", "generated-plan.json", "--steer", "Keep the split small"],
      { cwd: repo, windowsHide: true }
    );

    const parsedGenerated = JSON.parse(generated.stdout) as {
      spec_id: string;
      source: string;
      tool: string;
      proposal_path: string;
      plan_path: string;
      base_commit: string;
      task_count: number;
      execution_group_count: number;
    };
    assert.deepEqual(parsedGenerated, {
      spec_id: "S-001",
      plan_path: ".hivemind/plans/S-001.tentative.json",
      status: "tentative",
      base_commit: baseCommit,
      task_count: 3,
      execution_group_count: 2,
      tool: "fake-planner",
      proposal_path: "generated-plan.json",
      source: "adapter-generated",
      apply_command: "hivemind plan S-001 --propose generated-plan.json"
    });

    const proposal = JSON.parse(await readFile(path.join(repo, "generated-plan.json"), "utf8")) as {
      tasks: Array<{ task_id: string; task_type?: string; routing_task_type?: string }>;
    } & Record<string, unknown>;
    assert.deepEqual(Object.keys(proposal).sort(), ["execution_groups", "tasks"]);
    assert.deepEqual(
      proposal.tasks.map((taskEntry) => [taskEntry.task_id, taskEntry.task_type, taskEntry.routing_task_type]),
      [
        ["T-AUDIT", "deterministic", "other"],
        ["T-WRITE", "deterministic", "other"],
        ["T-INTEGRATE", "deterministic", "other"]
      ]
    );

    const storedBeforeLint = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      source: string;
      lint_status?: string;
      grounding_status?: string;
      tasks: Array<{ task_id: string; task_type: string; routing_task_type: string; scope_status: string }>;
    };
    assert.equal(storedBeforeLint.source, "adapter-generated");
    assert.equal(storedBeforeLint.lint_status, undefined);
    assert.equal(storedBeforeLint.grounding_status, undefined);
    assert.deepEqual(
      storedBeforeLint.tasks.map((taskEntry) => [taskEntry.task_id, taskEntry.task_type, taskEntry.routing_task_type, taskEntry.scope_status]),
      [
        ["T-AUDIT", "deterministic", "other", "draft_ungrounded"],
        ["T-WRITE", "deterministic", "other", "draft_ungrounded"],
        ["T-INTEGRATE", "deterministic", "other", "draft_ungrounded"]
      ]
    );

    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    const linted = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(linted.stdout).lint_status, "passed");

    const ledger = JSON.parse(await readFile(path.join(repo, ".hivemind", "resource", "ledger.json"), "utf8")) as {
      "fake-planner": { self_measured: { requests: number } };
    };
    assert.equal(ledger["fake-planner"].self_measured.requests, 1);
  });
});

test("plan generator cannot self-ratify mark lint passed or skip deterministic storage checks", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeFakePlanningAdapter(repo, {
      status: "ratified",
      lint_status: "passed",
      ...validPlan()
    });

    await assertPlanRejects(
      repo,
      ["plan", "S-001", "--generate", "--tool", "fake-planner", "--out", "generated-plan.json"],
      /unsupported top-level field: status/
    );
    await assertMissing(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"));
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

test("plan ground updates the tentative plan with git-tree evidence without executable task state", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, validPlan());
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    const grounded = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], {
      cwd: repo,
      windowsHide: true
    });

    assert.deepEqual(JSON.parse(grounded.stdout), {
      spec_id: "S-001",
      plan_path: ".hivemind/plans/S-001.tentative.json",
      status: "tentative",
      grounding_status: "grounded",
      base_commit: baseCommit,
      task_count: 3
    });
    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      grounding_status: string;
      grounded_base_commit: string;
      grounded_at: string;
      tasks: Array<{
        task_id: string;
        scope_status: string;
        grounding_evidence: { source: string; base_commit: string; cited_paths: string[]; resolved_files: string[] };
        grounded_scope: { allowed_files: string[]; read_only_files: string[]; forbidden_files: string[]; must_not_change: string[] };
      }>;
    };
    assert.equal(stored.grounding_status, "grounded");
    assert.equal(stored.grounded_base_commit, baseCommit);
    assert.equal(typeof stored.grounded_at, "string");
    const writeTask = stored.tasks.find((taskEntry) => taskEntry.task_id === "T-WRITE");
    assert.notEqual(writeTask, undefined);
    assert.equal(writeTask?.scope_status, "grounded");
    assert.deepEqual(writeTask?.grounded_scope.allowed_files, ["README.md"]);
    assert.equal(writeTask?.grounding_evidence.source, "git-tree");
    assert.equal(writeTask?.grounding_evidence.base_commit, baseCommit);
    assert.deepEqual(writeTask?.grounding_evidence.cited_paths, ["README.md"]);
    assert.deepEqual(writeTask?.grounding_evidence.resolved_files, ["README.md"]);
    await assertMissing(path.join(repo, ".hivemind", "tasks", "T-WRITE.contract.json"));
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-WRITE"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-WRITE"));
    await assertMissing(path.join(repo, ".hivemind", "integration", "queue.json"));
  });
});

test("plan ground resolves matching globs to concrete tracked files", async () => {
  await withTempRepo(async ({ repo }) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "alpha.ts"), "export const alpha = true;\n");
    await writeFile(path.join(repo, "src", "beta.ts"), "export const beta = true;\n");
    await git(repo, ["add", "src/alpha.ts", "src/beta.ts"]);
    await git(repo, ["commit", "-m", "add source files"]);
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-GLOB", { draft_scope: draftScope(["src/*.ts"]) })],
      execution_groups: [group("G-1", "parallel", ["T-GLOB"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      tasks: Array<{ grounded_scope: { allowed_files: string[] }; grounding_evidence: { cited_paths: string[]; resolved_files: string[] } }>;
    };
    assert.deepEqual(stored.tasks[0].grounded_scope.allowed_files, ["src/alpha.ts", "src/beta.ts"]);
    assert.deepEqual(stored.tasks[0].grounding_evidence.cited_paths, ["src/*.ts"]);
    assert.deepEqual(stored.tasks[0].grounding_evidence.resolved_files, ["src/alpha.ts", "src/beta.ts"]);
  });
});

test("plan ground refuses missing paths and leaves the plan ungrounded", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-MISSING", { draft_scope: draftScope(["MISSING.md"]) })],
      execution_groups: [group("G-1", "parallel", ["T-MISSING"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /task T-MISSING allowed_files path "MISSING.md" is not a tracked file at base/);

    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      grounding_status?: string;
      tasks: Array<{ scope_status: string }>;
    };
    assert.equal(stored.grounding_status, undefined);
    assert.equal(stored.tasks[0].scope_status, "draft_ungrounded");
  });
});

test("plan ground treats unlabeled allowed paths as modify and rejects missing files", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-UNLABELED", { draft_scope: draftScope(["src/new.js"]) })],
      execution_groups: [group("G-1", "parallel", ["T-UNLABELED"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /task T-UNLABELED allowed_files path "src\/new\.js" is not a tracked file at base/);
  });
});

test("plan ground refuses Hivemind canon paths and globs before they can enter worker scope", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [
        task("T-CANON", {
          draft_scope: draftScope(
            [".hivemind/canon/M-fixture.memory.json"],
            { ".hivemind/canon/M-fixture.memory.json": "create" }
          )
        })
      ],
      execution_groups: [group("G-1", "parallel", ["T-CANON"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(
      repo,
      ["plan", "S-001", "--ground"],
      /task T-CANON allowed_files contains protected path ".hivemind\/canon\/M-fixture\.memory\.json"/
    );

    const globPlanPath = await writePlan(repo, {
      tasks: [
        task("T-CANON-GLOB", {
          draft_scope: draftScope(
            [".hivemind/canon/**/*.json"],
            { ".hivemind/canon/**/*.json": "create" }
          )
        })
      ],
      execution_groups: [group("G-1", "parallel", ["T-CANON-GLOB"])]
    }, "canon-glob-plan.json");
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", globPlanPath], { cwd: repo, windowsHide: true });
    await assertPlanRejects(
      repo,
      ["plan", "S-001", "--ground"],
      /task T-CANON-GLOB allowed_files contains protected path ".hivemind\/canon\/\*\*\/\*\.json"/
    );
  });
});

test("plan ground rejects create paths that already exist at base as clobbers", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-CLOBBER", { draft_scope: draftScope(["README.md"], { "README.md": "create" }) })],
      execution_groups: [group("G-1", "parallel", ["T-CLOBBER"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /task T-CLOBBER allowed_files create path "README\.md" already exists at base/);
  });
});

test("plan ground accepts confined create paths and create globs that do not exist at base", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [
        task("T-CREATE", {
          draft_scope: draftScope(["src/new.js", "test/**/*.js"], {
            "src/new.js": "create",
            "test/**/*.js": "create"
          })
        })
      ],
      execution_groups: [group("G-1", "parallel", ["T-CREATE"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    const grounded = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(grounded.stdout).grounding_status, "grounded");

    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      base_commit: string;
      tasks: Array<{
        grounded_scope: { allowed_files: string[]; allowed_file_intents?: Record<string, string> };
        grounding_evidence: { base_commit: string; cited_paths: string[]; resolved_files: string[] };
      }>;
    };
    assert.equal(stored.base_commit, baseCommit);
    assert.deepEqual(stored.tasks[0].grounded_scope.allowed_files, ["src/new.js", "test/**/*.js"]);
    assert.deepEqual(stored.tasks[0].grounded_scope.allowed_file_intents, {
      "src/new.js": "create",
      "test/**/*.js": "create"
    });
    assert.deepEqual(stored.tasks[0].grounding_evidence.cited_paths, ["src/new.js", "test/**/*.js"]);
    assert.deepEqual(stored.tasks[0].grounding_evidence.resolved_files, ["src/new.js", "test/**/*.js"]);
  });
});

test("plan ground treats invalid allowed_file_intents values as modify", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-BADINTENT", { draft_scope: draftScope(["src/new.js"], { "src/new.js": "creat" }) })],
      execution_groups: [group("G-1", "parallel", ["T-BADINTENT"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /task T-BADINTENT allowed_files path "src\/new\.js" is not a tracked file at base/);
  });
});

test("plan ground refuses zero-match globs and stale base plans", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const globPlan = await writePlan(repo, {
      tasks: [task("T-GLOB", { draft_scope: draftScope(["src/*.ts"]) })],
      execution_groups: [group("G-1", "parallel", ["T-GLOB"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", globPlan], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /task T-GLOB allowed_files glob "src\/\*\.ts" matched no tracked files at base/);

    const stalePlan = await writePlan(repo, validPlan(), "stale-plan.json");
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", stalePlan], { cwd: repo, windowsHide: true });
    await writeFile(path.join(repo, "SECOND.md"), "second\n");
    await git(repo, ["add", "SECOND.md"]);
    await git(repo, ["commit", "-m", "move head"]);

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /tentative plan base .* is stale relative to current HEAD .* re-propose/);
    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as {
      grounding_status?: string;
      tasks: Array<{ scope_status: string }>;
    };
    assert.equal(stored.grounding_status, undefined);
    assert.equal(stored.tasks[0].scope_status, "draft_ungrounded");
  });
});

test("plan ground fails closed for malformed tentative artifacts", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /tentative plan not found/);

    const planFile = path.join(repo, ".hivemind", "plans", "S-001.tentative.json");
    await mkdir(path.dirname(planFile), { recursive: true });
    const badCases: Array<[string, unknown, RegExp]> = [
      ["wrong spec", { ...validStoredPlan("S-OTHER"), spec_id: "S-OTHER" }, /tentative plan spec_id must be S-001/],
      ["bad version", { ...validStoredPlan("S-001"), version: 2 }, /tentative plan version must be 1/],
      ["bad status", { ...validStoredPlan("S-001"), status: "committed" }, /tentative plan status must be tentative/],
      ["missing grounded_at", { ...validStoredPlan("S-001"), grounding_status: "grounded", grounded_base_commit: "abc123" }, /grounded_at must be present/],
      ["grounded task without plan marker", { ...validStoredPlan("S-001"), tasks: [{ ...task("T-001"), scope_status: "grounded", grounding_evidence: validGroundingEvidence(), grounded_scope: draftScope(["README.md"]) }] }, /grounded tasks require top-level grounding_status/],
      ["bad grounding", { ...validStoredPlan("S-001"), grounding_status: "grounded", grounded_at: "2026-06-16T00:00:00.000Z", grounded_base_commit: "abc123", tasks: [{ ...task("T-001"), scope_status: "grounded", grounding_evidence: { source: "manual" }, grounded_scope: draftScope(["README.md"]) }] }, /grounding_evidence.source must be git-tree/]
    ];

    for (const [, body, pattern] of badCases) {
      await writeFile(planFile, `${JSON.stringify(body, null, 2)}\n`);
      await assertPlanRejects(repo, ["plan", "S-001", "--ground"], pattern);
    }

    await writeFile(planFile, "{not json");
    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /invalid JSON/);
  });
});

test("plan ground rejects unsupported bracket glob syntax fail-closed", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-BRACKET", { draft_scope: draftScope(["src/[broken"]) })],
      execution_groups: [group("G-1", "parallel", ["T-BRACKET"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--ground"], /unsupported bracket glob syntax/);
  });
});

test("plan ground still defers overlap and dependency-cycle checks to M5.6", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [
        { ...task("T-001"), draft_scope: draftScope(["README.md"]), depends_on: ["T-002"] },
        { ...task("T-002"), draft_scope: draftScope(["README.md"]), depends_on: ["T-001"] }
      ],
      execution_groups: [group("G-1", "parallel", ["T-001", "T-002"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    const grounded = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    assert.equal(JSON.parse(grounded.stdout).grounding_status, "grounded");
  });
});

test("plan lint passes a clean grounded plan without executable task state", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, validPlan());
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    const linted = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });

    assert.deepEqual(JSON.parse(linted.stdout), {
      spec_id: "S-001",
      plan_path: ".hivemind/plans/S-001.tentative.json",
      status: "tentative",
      lint_status: "passed",
      base_commit: baseCommit,
      task_count: 3,
      rule_count: 7
    });
    await assertMissing(path.join(repo, ".hivemind", "tasks", "T-WRITE.contract.json"));
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-WRITE"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-WRITE"));
    await assertMissing(path.join(repo, ".hivemind", "integration", "queue.json"));
  });
});

test("plan lint rejects overlapping parallel write scopes", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-ONE"), task("T-TWO")],
      execution_groups: [group("G-1", "parallel", ["T-ONE", "T-TWO"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /PARALLEL_SCOPE_OVERLAP: group G-1 tasks T-ONE and T-TWO both allow README\.md/);
  });
});

test("plan lint rejects dependency cycles with the cycle path", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [
        task("T-ONE", { depends_on: ["T-TWO"] }),
        task("T-TWO", { depends_on: ["T-ONE"] })
      ],
      execution_groups: [group("G-1", "sequence", ["T-ONE", "T-TWO"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /DEPENDENCY_CYCLE: T-ONE -> T-TWO -> T-ONE/);
  });
});

test("plan lint rejects ungrounded and stale grounded plans", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, validPlan());
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /GROUNDING_REQUIRED: tentative plan must be grounded before lint/);

    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await writeFile(path.join(repo, "SECOND.md"), "second\n");
    await git(repo, ["add", "SECOND.md"]);
    await git(repo, ["commit", "-m", "move head after grounding"]);

    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /GROUNDING_FRESHNESS: tentative plan base .* is stale relative to current HEAD/);
  });
});

test("plan lint requires explicit approval for Critical paths", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await updateConfig(repo, { critical_globs: ["README.md"] });
    const unapprovedPlan = await writePlan(repo, {
      tasks: [task("T-CRITICAL")],
      execution_groups: [group("G-1", "parallel", ["T-CRITICAL"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", unapprovedPlan], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /CRITICAL_APPROVAL_REQUIRED: task T-CRITICAL touches Critical path README\.md without critical_path_approved/);

    const approvedPlan = await writePlan(
      repo,
      {
        tasks: [task("T-CRITICAL-OK", { critical_path_approved: true })],
        execution_groups: [group("G-1", "parallel", ["T-CRITICAL-OK"])]
      },
      "approved-critical-plan.json"
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", approvedPlan], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    const linted = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(linted.stdout).lint_status, "passed");
  });
});

test("plan lint rejects tasks without a non-empty required test command", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-NO-TEST", { required_tests: [""] })],
      execution_groups: [group("G-1", "parallel", ["T-NO-TEST"])]
    });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });

    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /RIGHT_SIZING_ACCEPTANCE: task T-NO-TEST required_tests must include at least one non-empty command/);
  });
});

test("plan lint rejects generative skeleton-trap acceptance while preserving valid exceptions", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const stubbablePlan = await writePlan(
      repo,
      {
        tasks: [
          task("T-GEN-STUB", {
            task_type: "generative",
            acceptance_criterion: "Generated JSON exists and typecheck passes.",
            required_tests: ["npm run typecheck"]
          })
        ],
        execution_groups: [group("G-1", "parallel", ["T-GEN-STUB"])]
      },
      "generative-stub.json"
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", stubbablePlan], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await assertPlanRejects(repo, ["plan", "S-001", "--lint"], /SKELETON_TRAP_ACCEPTANCE: task T-GEN-STUB is generative/);

    const behavioralPlan = await writePlan(
      repo,
      {
        tasks: [
          task("T-GEN-BEHAVIOR", {
            task_type: "generative",
            acceptance_criterion: "BEHAVIORAL, human-judged: a human reads the proposal and confirms the generated alternatives are substantive.",
            required_tests: ["human review of generated transcript"]
          })
        ],
        execution_groups: [group("G-1", "parallel", ["T-GEN-BEHAVIOR"])]
      },
      "generative-behavioral.json"
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", behavioralPlan], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    const behavioralLint = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(behavioralLint.stdout).lint_status, "passed");

    const deterministicCheckPlan = await writePlan(
      repo,
      {
        tasks: [
          task("T-GEN-VALID", {
            task_type: "generative",
            deterministic_validity_check: "node --test generated-characterization.test.js",
            acceptance_criterion: "Generated characterization test passes on base and fails on the injected regression.",
            required_tests: ["node --test generated-characterization.test.js"]
          })
        ],
        execution_groups: [group("G-1", "parallel", ["T-GEN-VALID"])]
      },
      "generative-deterministic-validity.json"
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", deterministicCheckPlan], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    const deterministicCheckLint = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(deterministicCheckLint.stdout).lint_status, "passed");

    const deterministicPlan = await writePlan(
      repo,
      {
        tasks: [task("T-DETERMINISTIC", { task_type: "deterministic" })],
        execution_groups: [group("G-1", "parallel", ["T-DETERMINISTIC"])]
      },
      "deterministic-binary.json"
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", deterministicPlan], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    const deterministicLint = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(deterministicLint.stdout).lint_status, "passed");
  });
});

test("plan lint requires an independent validity check only when acceptance names an observable interface", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const missingCheck = await writePlan(repo, {
      tasks: [task("T-CLI-MISSING", {
        routing_task_type: "cli",
        acceptance_criterion: "The CLI accepts --input <path>, supports optional --json, and emits sorted output.",
        required_tests: ["node --test test/cli.test.js"]
      })],
      execution_groups: [group("G-1", "sequence", ["T-CLI-MISSING"])]
    }, "observable-interface-missing-check.json");
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", missingCheck], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await assertPlanRejects(
      repo,
      ["plan", "S-001", "--lint"],
      /SKELETON_TRAP_ACCEPTANCE: task T-CLI-MISSING names an observable named CLI flag but has no deterministic_validity_check/
    );

    const checked = await writePlan(repo, {
      tasks: [task("T-CLI-CHECKED", {
        routing_task_type: "cli",
        acceptance_criterion: "The CLI accepts --input <path>, supports optional --json, and emits sorted output.",
        deterministic_validity_check: "node verify-cli-interface.mjs",
        required_tests: ["node --test test/cli.test.js"]
      })],
      execution_groups: [group("G-1", "sequence", ["T-CLI-CHECKED"])]
    }, "observable-interface-checked.json");
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", checked], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    const checkedLint = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(checkedLint.stdout).lint_status, "passed");

    const proseOnly = await writePlan(repo, {
      tasks: [task("T-PROSE", {
        acceptance_criterion: "The implementation clearly preserves the intended workflow and remains maintainable.",
        required_tests: ["npm test"]
      })],
      execution_groups: [group("G-1", "sequence", ["T-PROSE"])]
    }, "prose-only-acceptance.json");
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", proseOnly], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    const proseLint = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
    assert.equal(JSON.parse(proseLint.stdout).lint_status, "passed");
  });
});

test("plan proposal rejects non-boolean Critical approval flags", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, {
      tasks: [task("T-BAD-APPROVAL", { critical_path_approved: "yes" })],
      execution_groups: [group("G-1", "parallel", ["T-BAD-APPROVAL"])]
    });

    await assertPlanRejects(repo, ["plan", "S-001", "--propose", planPath], /critical_path_approved must be a boolean/);
  });
});

test("plan thrash records targeted re-scope and rejects a known-failed scope repeat", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, validPlan());
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await appendPatchRejected(repo, "T-WRITE", "outside allowed_files: src/feature.ts");
    await appendPatchRejected(repo, "T-WRITE", "diff-scope rejected a required src/feature.ts edit outside scope");

    const result = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--thrash", "T-WRITE", "--budget", "2"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      cause: string;
      remedy: string;
      attempt_count: number;
      attempts_remaining: number;
      replan_path: string;
      evidence: { failure_count: number };
    };

    assert.equal(parsed.status, "replan_required");
    assert.equal(parsed.cause, "scope-too-narrow");
    assert.equal(parsed.remedy, "widen");
    assert.equal(parsed.attempt_count, 1);
    assert.equal(parsed.attempts_remaining, 1);
    assert.equal(parsed.evidence.failure_count, 2);

    const record = JSON.parse(await readFile(path.join(repo, parsed.replan_path), "utf8")) as {
      status: string;
      known_failed_scope_hashes: string[];
      attempts: Array<{ cause: string; remedy: string; scope_hash: string }>;
    };
    assert.equal(record.status, "active");
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0].cause, "scope-too-narrow");
    assert.equal(record.attempts[0].remedy, "widen");
    assert.equal(record.known_failed_scope_hashes.includes(record.attempts[0].scope_hash), true);

    const repeatedPlanPath = await writePlan(repo, validPlan(), "repeat-known-failed-scope.json");
    await assertPlanRejects(repo, ["plan", "S-001", "--propose", repeatedPlanPath], /known failed scope repeat: task T-WRITE/);
  });
});

test("plan thrash terminates in blocked escalation within budget", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const planPath = await writePlan(repo, validPlan());
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await appendPatchRejected(repo, "T-WRITE", "ambiguous spec: acceptance contradicts requested behavior");
    await appendPatchRejected(repo, "T-WRITE", "unclear spec: cannot determine intended output");

    const result = await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--thrash", "T-WRITE", "--budget", "1"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      cause: string;
      remedy: string;
      attempt_count: number;
      attempts_remaining: number;
      replan_path: string;
    };

    assert.equal(parsed.status, "blocked");
    assert.equal(parsed.cause, "spec-ambiguity");
    assert.equal(parsed.remedy, "escalate");
    assert.equal(parsed.attempt_count, 1);
    assert.equal(parsed.attempts_remaining, 0);

    const record = JSON.parse(await readFile(path.join(repo, parsed.replan_path), "utf8")) as {
      status: string;
      escalation?: { cause: string; reason: string };
    };
    assert.equal(record.status, "blocked");
    assert.equal(record.escalation?.cause, "spec-ambiguity");
    assert.match(record.escalation?.reason ?? "", /re-plan budget exhausted/);

    const status = JSON.parse((await execFileAsync(process.execPath, [cliPath, "status"], { cwd: repo, windowsHide: true })).stdout) as {
      replans: Array<{ task_id: string; status: string; last_cause: string; last_remedy: string; attempts_remaining: number }>;
    };
    assert.deepEqual(status.replans, [
      {
        spec_id: "S-001",
        task_id: "T-WRITE",
        status: "blocked",
        budget: 1,
        attempt_count: 1,
        attempts_remaining: 0,
        last_cause: "spec-ambiguity",
        last_remedy: "escalate",
        escalation: record.escalation
      }
    ]);
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

function validStoredPlan(specId: string): Record<string, unknown> {
  return {
    version: 1,
    spec_id: specId,
    status: "tentative",
    base_commit: "abc123",
    source: "cli-json",
    created_at: "2026-06-16T00:00:00.000Z",
    tasks: [{ ...task("T-001"), scope_status: "draft_ungrounded" }],
    execution_groups: [group("G-1", "parallel", ["T-001"])]
  };
}

function validGroundingEvidence(): Record<string, unknown> {
  return {
    source: "git-tree",
    base_commit: "abc123",
    checked_at: "2026-06-16T00:00:00.000Z",
    cited_paths: ["README.md"],
    resolved_files: ["README.md"]
  };
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
    task_type: "deterministic",
    routing_task_type: "other",
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

function contractForTask(taskId: string, baseCommit: string): Record<string, unknown> {
  return {
    task_id: taskId,
    title: `Task ${taskId}`,
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: baseCommit,
    acceptance_criterion: "One binary acceptance check passes.",
    allowed_files: ["README.md"],
    allowed_file_intents: { "README.md": "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["npm run typecheck"],
    patch_requirements: ["submit diff only"]
  };
}

function draftScope(allowedFiles: unknown[], allowedFileIntents?: Record<string, unknown>): Record<string, unknown> {
  return {
    allowed_files: allowedFiles,
    ...(allowedFileIntents === undefined ? {} : { allowed_file_intents: allowedFileIntents }),
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

async function writeFakePlanningAdapter(repo: string, body: unknown): Promise<void> {
  const agentPath = path.join(repo, "fake-planner.mjs");
  await writeFile(
    agentPath,
    [
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      `console.log(${JSON.stringify(JSON.stringify(body))});`
    ].join("\n")
  );
  const adapterDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adapterDir, { recursive: true });
  await writeFile(
    path.join(adapterDir, "fake-planner.profile.json"),
    `${JSON.stringify(
      {
        tool: "fake-planner",
        invoke: ["node", "fake-planner.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 8000
      },
      null,
      2
    )}\n`
  );
}

async function appendPatchRejected(repo: string, taskId: string, reason: string): Promise<void> {
  const result = await appendEvent(repo, {
    type: "patch.rejected",
    task_id: taskId,
    data: { verdict: "reject", reason }
  });
  assert.equal(result.ok, true);
}

async function updateConfig(repo: string, patch: Record<string, unknown>): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({ ...config, ...patch }, null, 2)}\n`);
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
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Existing task fixture blocks duplicate planning.",
        allowed_files: ["README.md"],
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: ["node -e \"process.exit(0)\""],
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
