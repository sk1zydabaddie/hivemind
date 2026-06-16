import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent } from "../src/events.js";
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
      rule_count: 6
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
