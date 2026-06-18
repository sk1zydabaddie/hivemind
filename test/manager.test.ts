import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import {
  executeManagerAction,
  runAutonomousManagerLoop,
  startManagerSession,
  type ManagerAction,
  type ManagerProposedAction
} from "../src/manager.js";
import { createSpec } from "../src/spec.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
}

test("manager session shell records a user message against the active ratified spec", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(repo, {
      reason: "Inspect current durable state before choosing a task.",
      human_approval_required_for: [],
      actions: [{ type: "get_status" }]
    });

    const result = await startManagerSession(repo, "Build the next safe slice");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.spec_id, "S-001");
    assert.equal(result.value.proposed_action.type, "proposed_actions");
    assert.equal(result.value.proposed_action.source, "adapter-generated");
    assert.equal(result.value.proposed_action.tool, "manager");
    assert.deepEqual(result.value.proposed_action.actions, [{ type: "get_status" }]);

    const session = JSON.parse(await readFile(path.join(repo, result.value.session_path), "utf8")) as {
      version: number;
      spec_id: string;
      working_set: { spec: { title: string; status: string }; status: { task_count: number; active_lease_count: number } };
      turns: Array<{ role: string; content: string }>;
      proposed_action: { type: string; source: string; actions: Array<{ type: string }> };
    };
    assert.equal(session.version, 1);
    assert.equal(session.spec_id, "S-001");
    assert.equal(session.working_set.spec.title, "Test spec");
    assert.equal(session.working_set.spec.status, "ratified");
    assert.equal(session.working_set.status.task_count, 0);
    assert.equal(session.working_set.status.active_lease_count, 0);
    assert.deepEqual(session.turns.map((turn) => turn.role), ["user", "manager"]);
    assert.equal(session.turns[0].content, "Build the next safe slice");
    assert.equal(session.turns[1].content, "Inspect current durable state before choosing a task.");
    assert.equal(session.proposed_action.type, "proposed_actions");
    assert.equal(session.proposed_action.source, "adapter-generated");
    assert.deepEqual(session.proposed_action.actions, [{ type: "get_status" }]);
  });
});

test("manager CLI writes only the session artifact and does not create task execution state", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(repo, {
      reason: "Inspect current durable state.",
      human_approval_required_for: [],
      actions: [{ type: "get_status" }]
    });

    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Start from the ratified spec"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { session_path: string; proposed_action: { type: string; source: string; actions: Array<{ type: string }> } };

    assert.equal(parsed.proposed_action.type, "proposed_actions");
    assert.equal(parsed.proposed_action.source, "adapter-generated");
    assert.deepEqual(parsed.proposed_action.actions, [{ type: "get_status" }]);
    await assertExists(path.join(repo, parsed.session_path));
    assert.deepEqual(await contractFiles(repo), []);
    assert.equal(await exists(path.join(repo, ".hivemind", "leases", "active.json")), false);
    assert.deepEqual(await childNames(path.join(repo, ".hivemind", "patches")), []);
    assert.equal(await exists(path.join(repo, ".hivemind", "integration", "status.json")), false);
  });
});

test("manager proposal generation rejects dangerous profiles before writing a session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(
      repo,
      {
        reason: "This should never be invoked.",
        human_approval_required_for: [],
        actions: [{ type: "get_status" }]
      },
      "manager",
      ["--dangerously-skip-permissions"]
    );

    const result = await startManagerSession(repo, "Use unsafe manager profile");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /dangerous invocation flags/);
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager proposal generation rejects self-approval fields and removed placeholder actions", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(repo, {
      reason: "Unsupported self approval should fail closed.",
      human_approval_required_for: [],
      self_approved: true,
      actions: [{ type: "get_status" }]
    });

    const proofLike = await startManagerSession(repo, "Do not self approve");

    assert.equal(proofLike.ok, false);
    if (proofLike.ok) {
      return;
    }
    assert.match(proofLike.reason, /unsupported proof\/control fields: self_approved/);
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });

  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(repo, {
      reason: "Old placeholder should fail closed.",
      human_approval_required_for: [],
      actions: [{ type: "await_planning_loop" }]
    });

    const oldPlaceholder = await startManagerSession(repo, "Use old placeholder");

    assert.equal(oldPlaceholder.ok, false);
    if (oldPlaceholder.ok) {
      return;
    }
    assert.match(oldPlaceholder.reason, /unknown manager action type: await_planning_loop/);
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager chat fails closed for draft or missing specs and records no session", async () => {
  await withTempRepo(async ({ repo }) => {
    const draft = await createSpec(repo, "S-DRAFT", "Draft manager gate");
    assert.equal(draft.ok, true);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Please start"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /active spec S-DRAFT is draft/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });

  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Please start"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /no active spec/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager CLI rejects empty messages before writing a session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "   "], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /manager message must not be empty/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager executor records a read-only status action in the session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const sessionResult = await startManagerSession(repo, "Check status", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const actionPath = path.join(repo, "status-action.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "get_status" }, null, 2)}\n`);
    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { action_type: string; result: { ok: boolean; value: { tasks: unknown[] } } };

    assert.equal(parsed.action_type, "get_status");
    assert.equal(parsed.result.ok, true);
    assert.deepEqual(parsed.result.value.tasks, []);
    const session = await readSession(repo, sessionResult.value.session_path);
    assert.equal(session.executed_actions.length, 1);
    assert.equal(session.executed_actions[0].type, "get_status");
    assert.equal(session.executed_actions[0].result.ok, true);
  });
});

test("manager fake loop drives a user message through gated shadow integration with no paid provider", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const agentPath = await writeAgent(repo, "manager-loop-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by manager fake loop\\n');"
    ]);
    await writeProfile(repo, "fake", agentPath);
    const contract = managerContract("T-LOOP", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const actionsPath = path.join(repo, "fake-manager-actions.json");
    await writeFile(
      actionsPath,
      `${JSON.stringify(
        [
          { type: "create_task_contract", contract },
          { type: "request_lease", task_id: "T-LOOP" },
          { type: "check_write_intent", task_id: "T-LOOP", intent: intentFor("T-LOOP", ["README.md"]) },
          { type: "create_worktree", task_id: "T-LOOP" },
          { type: "run_worker", task_id: "T-LOOP", tool: "fake" },
          { type: "submit_patch", task_id: "T-LOOP" },
          { type: "analyze_patch", task_id: "T-LOOP" },
          { type: "enqueue_patch", task_id: "T-LOOP" },
          { type: "integrate_shadow" }
        ],
        null,
        2
      )}\n`
    );

    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Run a fake manager loop", "--fake-manager", actionsPath], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      session_path: string;
      steps: Array<{ action_type: string; result: { ok: boolean } }>;
      final_status: { integration: { queue: string[]; status: { applied: string[]; tests: string } | null } };
    };

    assert.equal(parsed.status, "passed");
    assert.deepEqual(parsed.steps.map((step) => step.action_type), [
      "create_task_contract",
      "request_lease",
      "check_write_intent",
      "create_worktree",
      "run_worker",
      "submit_patch",
      "analyze_patch",
      "enqueue_patch",
      "integrate_shadow"
    ]);
    assert.equal(parsed.steps.every((step) => step.result.ok), true);
    assert.deepEqual(parsed.final_status.integration.queue, ["T-LOOP"]);
    assert.deepEqual(parsed.final_status.integration.status?.applied, ["T-LOOP"]);
    assert.equal(parsed.final_status.integration.status?.tests, "pass");
    assert.match(await readFile(path.join(repo, ".hivemind", "patches", "T-LOOP", "diff.patch"), "utf8"), /\+changed by manager fake loop/);

    const session = await readSession(repo, parsed.session_path);
    assert.equal(session.executed_actions.length, 9);
    const events = await readRequiredEvents(repo);
    assertEventOrder(
      events.map((event) => event.type),
      ["task.created", "lease.approved", "patch.submitted", "patch.accepted", "integration.queued", "integration.passed"]
    );
    assert.equal(events.filter((event) => event.type === "task.created" && event.task_id === "T-LOOP").length, 1);
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "README.md"), "utf8")), "# Fixture\n");
  });
});

test("manager autonomous loop chains Tier-1 actions after deterministic passes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-AUTO", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-AUTO" }]),
      after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-AUTO", intent: intentFor("T-AUTO", ["README.md"]) }]),
      after_check_write_intent_ok: proposalFor([])
    });

    const result = await runAutonomousManagerLoop(repo, "Drive Tier-1 steps", {
      tool: "manager",
      approvedActions: new Set(),
      maxSteps: 10
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "completed");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), ["create_task_contract", "request_lease", "check_write_intent"]);
    assert.deepEqual(result.value.steps.map((step) => step.tier), ["autonomous", "autonomous", "autonomous"]);
    assert.equal(result.value.steps.every((step) => step.result?.ok === true), true);
    assert.deepEqual(await managerReactiveCalls(repo), [
      "initial",
      "after_create_task_contract_ok",
      "after_request_lease_ok",
      "after_check_write_intent_ok"
    ]);
    const session = await readSession(repo, result.value.session_path);
    assert.deepEqual(session.executed_actions.map((action) => action.type), ["create_task_contract", "request_lease", "check_write_intent"]);
    assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-AUTO.contract.json")), true);
  });
});

test("manager autonomous loop pauses Tier-2 actions for human approval", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "run_worker", task_id: "T-PAUSE", tool: "fake" }], ["run_worker"])
    });

    const result = await runAutonomousManagerLoop(repo, "Try worker invocation", {
      tool: "manager",
      approvedActions: new Set(),
      maxSteps: 5
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "paused");
    assert.equal(result.value.steps.length, 1);
    assert.equal(result.value.steps[0].action_type, "run_worker");
    assert.equal(result.value.steps[0].tier, "human_approval");
    assert.match(result.value.steps[0].pause?.reason ?? "", /high-risk|consequential/);
    const session = await readSession(repo, result.value.session_path);
    assert.equal(session.executed_actions.length, 0);
    assert.equal(session.pending_action?.action.type, "run_worker");
  });
});

test("manager autonomous loop hard-stops on gate rejection without retrying or changing provider tier", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const agentPath = await writeAgent(repo, "weak-tier-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'weak provider should not run\\n');"
    ]);
    await writeProfile(repo, "weak", agentPath, "local", 1);
    const contract = managerContract("T-REJECT", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-REJECT" }]),
      after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-REJECT", intent: intentFor("T-REJECT", ["README.md"]) }]),
      after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: "T-REJECT" }]),
      after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: "T-REJECT", tool: "weak" }], ["run_worker"]),
      after_run_worker_rejected: proposalFor([{ type: "get_status" }])
    });

    const result = await runAutonomousManagerLoop(repo, "Drive until gate rejection", {
      tool: "manager",
      approvedActions: new Set(["run_worker"]),
      maxSteps: 10
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "stopped");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), [
      "create_task_contract",
      "request_lease",
      "check_write_intent",
      "create_worktree",
      "run_worker"
    ]);
    const finalStep = result.value.steps.at(-1);
    assert.equal(finalStep?.tier, "gate_rejection");
    assert.equal(finalStep?.result?.ok, false);
    assert.match(finalStep.result.reason, /below required floor for high task tier/);
    assert.match(finalStep.stop?.diagnosis ?? "", /Tier 3 hard stop/);
    assert.match(finalStep.stop?.options.join("\n") ?? "", /Do not change provider tiers/);
    assert.deepEqual(await managerReactiveCalls(repo), [
      "initial",
      "after_create_task_contract_ok",
      "after_request_lease_ok",
      "after_check_write_intent_ok",
      "after_create_worktree_ok"
    ]);
    const weakProfile = JSON.parse(await readFile(path.join(repo, ".hivemind", "adapters", "weak.profile.json"), "utf8")) as { routing_tier: string };
    assert.equal(weakProfile.routing_tier, "local");
    assert.doesNotMatch(await readFile(path.join(repo, "README.md"), "utf8"), /weak provider should not run/);
  });
});

test("manager autonomous loop stops on non-zero worker exit and does not enqueue", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const agentPath = await writeAgent(repo, "crashing-worker-agent.mjs", [
      "console.error('worker crashed before producing changes');",
      "process.exit(9);"
    ]);
    await writeProfile(repo, "strong-worker", agentPath, "strong", 1);
    const contract = managerContract("T-CRASH", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-CRASH" }]),
      after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-CRASH", intent: intentFor("T-CRASH", ["README.md"]) }]),
      after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: "T-CRASH" }]),
      after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: "T-CRASH", tool: "strong-worker" }], ["run_worker"]),
      after_run_worker_rejected: proposalFor([{ type: "enqueue_patch", task_id: "T-CRASH" }])
    });

    const result = await runAutonomousManagerLoop(repo, "Drive crashing worker", {
      tool: "manager",
      approvedActions: new Set(["run_worker"]),
      maxSteps: 10
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "stopped");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), [
      "create_task_contract",
      "request_lease",
      "check_write_intent",
      "create_worktree",
      "run_worker"
    ]);
    const finalStep = result.value.steps.at(-1);
    assert.equal(finalStep?.tier, "gate_rejection");
    assert.equal(finalStep?.result?.ok, false);
    assert.match(finalStep.result.reason, /worker strong-worker exited 9/);
    assert.equal(await exists(path.join(repo, ".hivemind", "integration", "queue.json")), false);
    assert.deepEqual(await managerReactiveCalls(repo), [
      "initial",
      "after_create_task_contract_ok",
      "after_request_lease_ok",
      "after_check_write_intent_ok",
      "after_create_worktree_ok"
    ]);
  });
});

test("manager autonomous loop sees unsubmitted patch state after worker success and proposes submit_patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const agentPath = await writeAgent(repo, "successful-worker-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'worker produced a real diff\\n');"
    ]);
    await writeProfile(repo, "strong-worker", agentPath, "strong", 1);
    const contract = managerContract("T-PIPE", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writePatchPipelineAwareManagerProfile(repo, "T-PIPE", "strong-worker");

    const result = await runAutonomousManagerLoop(repo, "Drive worker to submit", {
      tool: "manager",
      approvedActions: new Set(["run_worker"]),
      maxSteps: 10
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "completed");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), [
      "create_task_contract",
      "request_lease",
      "check_write_intent",
      "create_worktree",
      "run_worker",
      "submit_patch"
    ]);
    assert.equal(result.value.steps.every((step) => step.result?.ok === true), true);
    assert.deepEqual(await managerReactiveCalls(repo), [
      "initial",
      "after_create_task_contract_ok",
      "after_request_lease_ok",
      "after_check_write_intent_ok",
      "after_create_worktree_ok",
      "after_run_worker_ok_unsubmitted",
      "after_submit_patch_ok"
    ]);
    const finalTask = result.value.final_status.tasks.find((entry) => entry.task_id === "T-PIPE");
    assert.equal(finalTask?.patch.bundle, "present");
    assert.equal(finalTask?.patch.submitted, true);
    assert.equal(finalTask?.patch.analyzed, false);
    assert.equal(finalTask?.patch.accepted, false);
    assert.equal(finalTask?.patch.verdict, null);
    assert.equal(await exists(path.join(repo, ".hivemind", "integration", "queue.json")), false);
  });
});

test("manager create_task_contract is refused when the current plan fails lint", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const bypass = managerContract("T-BYPASS", baseCommit, ["README.md"]);
    const other = managerContract("T-OTHER", baseCommit, ["README.md"]);
    const badPlanPath = path.join(repo, "overlapping-plan.json");
    await writeFile(
      badPlanPath,
      `${JSON.stringify(
        {
          tasks: [planTaskFromContract(bypass), planTaskFromContract(other)],
          execution_groups: [{ group_id: "G-1", mode: "parallel", task_ids: ["T-BYPASS", "T-OTHER"] }]
        },
        null,
        2
      )}\n`
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", badPlanPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /PARALLEL_SCOPE_OVERLAP/);
        return true;
      }
    );
    const actionsPath = path.join(repo, "lint-bypass-actions.json");
    await writeFile(actionsPath, `${JSON.stringify([{ type: "create_task_contract", contract: bypass }], null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Try lint bypass", "--fake-manager", actionsPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { status: string; steps: Array<{ result: { ok: boolean; reason?: string } }> };
        assert.equal(parsed.status, "failed");
        assert.equal(parsed.steps[0].result.ok, false);
        assert.match(parsed.steps[0].result.reason ?? "", /current lint-passed tentative plan/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-BYPASS.contract.json")), false);
  });
});

test("manager create_task_contract refuses a dependent task until dependencies are event-integrated", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const dependency = managerContract("T-BASE", baseCommit, ["README.md"]);
    const dependent = managerContract("T-DEP", baseCommit, ["README.md"]);
    await prepareLintedPlanWithTasks(repo, [
      planTaskFromContract(dependency),
      planTaskFromContract(dependent, ["T-BASE"])
    ]);
    const action = [{ type: "create_task_contract", contract: dependent }];
    const blockedPath = path.join(repo, "dependency-blocked-actions.json");
    await writeFile(blockedPath, `${JSON.stringify(action, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Try dependency bypass", "--fake-manager", blockedPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { status: string; steps: Array<{ result: { ok: boolean; reason?: string } }> };
        assert.equal(parsed.status, "failed");
        assert.equal(parsed.steps[0].result.ok, false);
        assert.match(parsed.steps[0].result.reason ?? "", /task T-DEP depends_on not integrated: T-BASE/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-DEP.contract.json")), false);

    await appendIntegratedDependencyEvents(repo, "T-BASE");
    const allowedPath = path.join(repo, "dependency-allowed-actions.json");
    await writeFile(allowedPath, `${JSON.stringify(action, null, 2)}\n`);
    const allowed = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Create after dependency", "--fake-manager", allowedPath], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(allowed.stdout) as { status: string; steps: Array<{ result: { ok: boolean } }> };
    assert.equal(parsed.status, "passed");
    assert.equal(parsed.steps[0].result.ok, true);
    await assertExists(path.join(repo, ".hivemind", "tasks", "T-DEP.contract.json"));
  });
});

test("manager run_worker refuses to invoke without a passed write-intent", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const agentPath = await writeAgent(repo, "no-intent-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'agent should not run without intent\\n');"
    ]);
    await writeProfile(repo, "fake", agentPath);
    const contract = managerContract("T-NOINTENT", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const actionsPath = path.join(repo, "no-intent-actions.json");
    await writeFile(
      actionsPath,
      `${JSON.stringify(
        [
          { type: "create_task_contract", contract },
          { type: "request_lease", task_id: "T-NOINTENT" },
          { type: "run_worker", task_id: "T-NOINTENT", tool: "fake" }
        ],
        null,
        2
      )}\n`
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Run without intent", "--fake-manager", actionsPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { status: string; steps: Array<{ action_type: string; result: { ok: boolean; reason?: string } }> };
        assert.equal(parsed.status, "failed");
        assert.deepEqual(parsed.steps.map((step) => step.action_type), ["create_task_contract", "request_lease", "run_worker"]);
        assert.equal(parsed.steps[2].result.ok, false);
        assert.match(parsed.steps[2].result.reason ?? "", /passed write intent not found/);
        return true;
      }
    );
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-NOINTENT"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-NOINTENT", "diff.patch"));
  });
});

test("manager executor drives deterministic task actions through shadow integration with no paid provider", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const agentPath = await writeAgent(repo, "manager-fake-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by manager executor\\n');"
    ]);
    await writeProfile(repo, "fake", agentPath);
    const sessionResult = await startManagerSession(repo, "Run the deterministic executor", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const sessionId = sessionResult.value.session_id;

    const contract = {
      task_id: "T-001",
      title: "Manager executor fixture",
      agent_role: "builder",
      base_commit: baseCommit,
      acceptance_criterion: "Manager executor fixture passes shadow integration.",
      allowed_files: ["README.md"],
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node -e \"process.exit(0)\""],
      patch_requirements: ["submit diff only"]
    };
    await prepareLintedPlan(repo, contract);
    const actions = [
      { type: "create_task_contract", contract },
      { type: "request_lease", task_id: "T-001" },
      { type: "check_write_intent", task_id: "T-001", intent: intentFor("T-001", ["README.md"]) },
      { type: "create_worktree", task_id: "T-001" },
      { type: "run_worker", task_id: "T-001", tool: "fake" },
      { type: "submit_patch", task_id: "T-001" },
      { type: "analyze_patch", task_id: "T-001" },
      { type: "enqueue_patch", task_id: "T-001" },
      { type: "integrate_shadow" }
    ] as const;

    for (const action of actions) {
      const result = await executeManagerAction(repo, sessionId, action);
      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      assert.equal(result.value.result.ok, true, `${action.type} failed`);
    }

    const diff = await readFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "utf8");
    assert.match(diff, /\+changed by manager executor/);
    const queue = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "queue.json"), "utf8")) as Array<{ task_id: string }>;
    assert.deepEqual(queue, [{ task_id: "T-001" }]);
    const status = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "status.json"), "utf8")) as { applied: string[]; tests: string };
    assert.deepEqual(status.applied, ["T-001"]);
    assert.equal(status.tests, "pass");

    const session = await readSession(repo, sessionResult.value.session_path);
    assert.deepEqual(session.executed_actions.map((action) => action.type), actions.map((action) => action.type));
    assert.equal(session.executed_actions.every((action) => action.result.ok), true);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "integration.queued" && event.task_id === "T-001"), true);
    assert.equal(events.value.at(-1)?.type, "integration.passed");
  });
});

test("manager fake loop rejects malformed action scripts before creating a session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const actionsPath = path.join(repo, "bad-fake-manager-actions.json");
    await writeFile(actionsPath, `${JSON.stringify([{ type: "unknown_action" }], null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Should not start", "--fake-manager", actionsPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /fake-manager action\[0\]: unknown manager action type/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager fake loop stops after a deterministic action failure", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-FAIL", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const actionsPath = path.join(repo, "failing-fake-manager-actions.json");
    await writeFile(
      actionsPath,
      `${JSON.stringify(
        [
          { type: "create_task_contract", contract },
          { type: "run_worker", task_id: "T-FAIL", tool: "missing" },
          { type: "submit_patch", task_id: "T-FAIL" }
        ],
        null,
        2
      )}\n`
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Stop on failure", "--fake-manager", actionsPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as {
          status: string;
          session_path: string;
          steps: Array<{ action_type: string; result: { ok: boolean; reason?: string } }>;
        };
        assert.equal(parsed.status, "failed");
        assert.deepEqual(parsed.steps.map((step) => step.action_type), ["create_task_contract", "run_worker"]);
        assert.equal(parsed.steps[1].result.ok, false);
        assert.match(parsed.steps[1].result.reason ?? "", /active lease does not cover task allowed_files/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "patches", "T-FAIL", "diff.patch")), false);
  });
});

test("manager fake loop refuses draft specs before creating a session", async () => {
  await withTempRepo(async ({ repo }) => {
    const draft = await createSpec(repo, "S-DRAFT", "Draft manager loop");
    assert.equal(draft.ok, true);
    const actionsPath = path.join(repo, "fake-manager-actions.json");
    await writeFile(actionsPath, "[]\n");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Blocked by draft", "--fake-manager", actionsPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /active spec S-DRAFT is draft/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager executor records deterministic failures but fails the CLI closed", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const sessionResult = await startManagerSession(repo, "Try to run without a lease", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const actionPath = path.join(repo, "run-without-lease.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "run_worker", task_id: "T-001", tool: "missing" }, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { result: { ok: boolean; reason: string } };
        assert.equal(parsed.result.ok, false);
        assert.match(parsed.result.reason, /active lease does not cover task allowed_files/);
        return true;
      }
    );

    const session = await readSession(repo, sessionResult.value.session_path);
    assert.equal(session.executed_actions.length, 1);
    const recorded = session.executed_actions[0];
    assert.equal(recorded.result.ok, false);
    assert.match(recorded.result.reason ?? "", /active lease does not cover task allowed_files/);
  });
});

test("manager executor rejects malformed actions before mutating the session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const sessionResult = await startManagerSession(repo, "Reject bad action", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const actionPath = path.join(repo, "bad-action.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "unknown_action" }, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /unknown manager action type/);
        return true;
      }
    );

    const session = await readSession(repo, sessionResult.value.session_path);
    assert.deepEqual(session.executed_actions, []);
    assert.deepEqual(await contractFiles(repo), []);
  });
});

test("manager executor refuses actions when the active spec is not ratified", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const sessionResult = await startManagerSession(repo, "Spec must stay ratified", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const draft = await createSpec(repo, "S-DRAFT", "Draft spec");
    assert.equal(draft.ok, true);
    const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "get_status" });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /active spec S-DRAFT is draft/);
    const session = await readSession(repo, sessionResult.value.session_path);
    assert.deepEqual(session.executed_actions, []);
  });
});

test("manager enqueue_patch rejects missing and duplicate patch bundles deterministically", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const sessionResult = await startManagerSession(repo, "Queue patch once", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const missing = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(missing.ok, true);
    if (!missing.ok) {
      return;
    }
    assert.equal(missing.value.result.ok, false);
    if (!missing.value.result.ok) {
      assert.match(missing.value.result.reason, /patch bundle not found/);
    }

    await mkdir(path.join(repo, ".hivemind", "patches", "T-001"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "");
    const empty = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(empty.ok, true);
    if (!empty.ok) {
      return;
    }
    assert.equal(empty.value.result.ok, false);
    if (!empty.value.result.ok) {
      assert.match(empty.value.result.reason, /patch bundle is empty/);
    }

    await writeAcceptedPatchBundle(repo, "T-001", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\nqueue after accepted analysis\n");
    });
    const queued = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(queued.ok, true);
    if (!queued.ok) {
      return;
    }
    assert.equal(queued.value.result.ok, true);

    const duplicate = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) {
      return;
    }
    assert.equal(duplicate.value.result.ok, false);
    if (!duplicate.value.result.ok) {
      assert.match(duplicate.value.result.reason, /already contains T-001/);
    }
    const queue = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "queue.json"), "utf8")) as Array<{ task_id: string }>;
    assert.deepEqual(queue, [{ task_id: "T-001" }]);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.filter((event) => event.type === "integration.queued").length, 1);
  });
});

test("manager enqueue_patch routes through a live daemon instead of direct queue writes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeAcceptedPatchBundle(repo, "T-001", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\nqueued through daemon\n");
    });
    const sessionResult = await startManagerSession(repo, "Queue through daemon", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const actionPath = path.join(repo, "enqueue-action.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "enqueue_patch", task_id: "T-001" }, null, 2)}\n`);

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(routed.stdout) as { result: { ok: boolean; value: { queue: string[] } } };
      assert.equal(parsed.result.ok, true);
      assert.deepEqual(parsed.result.value.queue, ["T-001"]);
    } finally {
      await stopDaemon(daemon);
    }

    const queue = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "queue.json"), "utf8")) as Array<{ task_id: string }>;
    assert.deepEqual(queue, [{ task_id: "T-001" }]);
  });
});

test("manager fake loop routes mutating actions through a discovered live daemon", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-DAEMON", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const actionsPath = path.join(repo, "daemon-fake-manager-actions.json");
    await writeFile(
      actionsPath,
      `${JSON.stringify(
        [
          { type: "create_task_contract", contract },
          { type: "request_lease", task_id: "T-DAEMON" }
        ],
        null,
        2
      )}\n`
    );

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Route through daemon", "--fake-manager", actionsPath], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(routed.stdout) as { status: string; steps: Array<{ result: { ok: boolean } }> };
      assert.equal(parsed.status, "passed");
      assert.equal(parsed.steps.every((step) => step.result.ok), true);
    } finally {
      await stopDaemon(daemon);
    }

    const events = await readRequiredEvents(repo);
    assertEventOrder(events.map((event) => event.type), ["task.created", "lease.approved"]);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-manager-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

function managerContract(taskId: string, baseCommit: string, allowedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    title: "Manager loop fixture",
    agent_role: "builder",
    base_commit: baseCommit,
    acceptance_criterion: "Manager loop fixture completes one deterministic flow.",
    allowed_files: allowedFiles,
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: ["submit diff only"]
  };
}

function intentFor(taskId: string, intendedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    intended_files: intendedFiles,
    intended_symbols: [],
    possible_risks: [],
    will_not_change: []
  };
}

function testProposal(actions: ManagerAction[] = []): ManagerProposedAction {
  return {
    type: "proposed_actions",
    source: "scripted",
    reason: "Test-seeded proposal for deterministic manager executor coverage.",
    actions,
    human_approval_required_for: []
  };
}

function proposalFor(actions: ManagerAction[], humanApprovalRequiredFor: ManagerAction["type"][] = []): Record<string, unknown> {
  return {
    reason: actions.length === 0 ? "No next manager action is currently needed." : `Propose ${actions[0].type} from observed state.`,
    human_approval_required_for: humanApprovalRequiredFor,
    actions
  };
}

async function prepareLintedPlan(repo: string, contract: Record<string, unknown>, name = `${String(contract.task_id)}-plan.json`): Promise<void> {
  await prepareLintedPlanWithTasks(repo, [planTaskFromContract(contract)], name);
}

async function prepareLintedPlanWithTasks(repo: string, tasks: Record<string, unknown>[], name = "plan.json"): Promise<void> {
  const planPath = path.join(repo, name);
  await writeFile(
    planPath,
    `${JSON.stringify(
        {
          tasks,
        execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: tasks.map((task) => task.task_id) }]
      },
      null,
      2
    )}\n`
  );
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
}

function planTaskFromContract(contract: Record<string, unknown>, dependsOn: string[] = []): Record<string, unknown> {
  return {
    task_id: contract.task_id,
    title: contract.title,
    mode: "write",
    agent_role: contract.agent_role,
    draft_scope: {
      allowed_files: contract.allowed_files,
      read_only_files: contract.read_only_files,
      forbidden_files: contract.forbidden_files,
      must_not_change: contract.must_not_change
    },
    depends_on: dependsOn,
    parallel_safe: true,
    acceptance_criterion: contract.acceptance_criterion,
    required_tests: contract.required_tests,
    patch_requirements: contract.patch_requirements
  };
}

async function appendIntegratedDependencyEvents(repo: string, taskId: string): Promise<void> {
  await appendEvent(repo, {
    type: "patch.submitted",
    task_id: taskId,
    data: { bundle_path: `.hivemind/patches/${taskId}`, changed_files: 1 }
  });
  await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "accepted dependency fixture" }
  });
  await appendEvent(repo, {
    type: "integration.passed",
    task_id: null,
    data: { applied: [taskId], tests: "pass" }
  });
}

async function contractFiles(repo: string): Promise<string[]> {
  return (await childNames(path.join(repo, ".hivemind", "tasks"))).filter((name) => name.endsWith(".contract.json"));
}

async function childNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(isNodeError(error, "ENOENT"), true);
    return true;
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readSession(
  repo: string,
  sessionPath: string
): Promise<{
  pending_action?: { action: { type: string }; reason: string; recommendation: string };
  executed_actions: Array<{ type: string; result: { ok: boolean; reason?: string } }>;
}> {
  return JSON.parse(await readFile(path.join(repo, sessionPath), "utf8")) as {
    pending_action?: { action: { type: string }; reason: string; recommendation: string };
    executed_actions: Array<{ type: string; result: { ok: boolean; reason?: string } }>;
  };
}

async function readRequiredEvents(repo: string) {
  const events = await readEvents(repo);
  assert.equal(events.ok, true);
  if (!events.ok) {
    return [];
  }
  return events.value;
}

function assertEventOrder(actual: string[], expected: string[]): void {
  let cursor = 0;
  for (const type of actual) {
    if (type === expected[cursor]) {
      cursor += 1;
    }
    if (cursor === expected.length) {
      return;
    }
  }
  assert.fail(`event order missing subsequence: ${expected.join(", ")} in ${actual.join(", ")}`);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function setConfigTestCommand(repo: string, testCommand: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = testCommand;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
}

async function writeProfile(repo: string, tool: string, agentPath: string, routingTier = "strong", costRank = 1): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: routingTier,
        cost_rank: costRank
      },
      null,
      2
    )}\n`
  );
}

async function writeReactiveManagerProposalProfile(repo: string, proposals: Record<string, Record<string, unknown>>, tool = "manager"): Promise<void> {
  const agentPath = await writeAgent(repo, `${tool}-reactive-proposal-agent.mjs`, [
    "const { appendFile } = await import('node:fs/promises');",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    `const proposals = ${JSON.stringify(proposals)};`,
    "const match = input.match(/Last manager observation: action ([a-z_]+) returned (ok|rejected)/);",
    "const key = match ? `after_${match[1]}_${match[2]}` : 'initial';",
    "await appendFile('.hivemind/manager-reactive-calls.log', `${key}\\n`);",
    "console.log(JSON.stringify(proposals[key] ?? { reason: 'No follow-up action.', human_approval_required_for: [], actions: [] }));"
  ]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

async function writePatchPipelineAwareManagerProfile(repo: string, taskId: string, workerTool: string, tool = "manager"): Promise<void> {
  const contract = managerContract(taskId, await gitStdout(repo, ["rev-parse", "HEAD"]), ["README.md"]);
  const proposals = {
    initial: proposalFor([{ type: "create_task_contract", contract }]),
    after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: taskId }]),
    after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: taskId, intent: intentFor(taskId, ["README.md"]) }]),
    after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: taskId }]),
    after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: taskId, tool: workerTool }], ["run_worker"]),
    after_submit_patch_ok: proposalFor([])
  };
  const submitProposal = proposalFor([{ type: "submit_patch", task_id: taskId }]);
  const unsafeEnqueueProposal = proposalFor([{ type: "enqueue_patch", task_id: taskId }]);
  const agentPath = await writeAgent(repo, `${tool}-pipeline-aware-proposal-agent.mjs`, [
    "const { appendFile } = await import('node:fs/promises');",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    `const taskId = ${JSON.stringify(taskId)};`,
    `const proposals = ${JSON.stringify(proposals)};`,
    `const submitProposal = ${JSON.stringify(submitProposal)};`,
    `const unsafeEnqueueProposal = ${JSON.stringify(unsafeEnqueueProposal)};`,
    "const match = input.match(/Last manager observation: action ([a-z_]+) returned (ok|rejected)/);",
    "const key = match ? `after_${match[1]}_${match[2]}` : 'initial';",
    "if (key === 'after_run_worker_ok') {",
    "  const statusStart = input.indexOf('Durable status JSON:');",
    "  const planStart = input.indexOf('Tentative plan JSON or missing state:');",
    "  const statusText = statusStart === -1 || planStart === -1 ? input : input.slice(statusStart, planStart);",
    "  const taskMarker = `\"task_id\": \"${taskId}\"`;",
    "  const sawUnsubmittedPatch = statusText.includes(taskMarker) && statusText.includes('\"bundle\": \"present\"') && statusText.includes('\"submitted\": false') && statusText.includes('\"analyzed\": false') && statusText.includes('\"accepted\": false') && statusText.includes('\"verdict\": null');",
    "  await appendFile('.hivemind/manager-reactive-calls.log', sawUnsubmittedPatch ? 'after_run_worker_ok_unsubmitted\\n' : 'after_run_worker_ok_misleading\\n');",
    "  console.log(JSON.stringify(sawUnsubmittedPatch ? submitProposal : unsafeEnqueueProposal));",
    "  process.exit(0);",
    "}",
    "await appendFile('.hivemind/manager-reactive-calls.log', `${key}\\n`);",
    "console.log(JSON.stringify(proposals[key] ?? { reason: 'No follow-up action.', human_approval_required_for: [], actions: [] }));"
  ]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

async function managerReactiveCalls(repo: string): Promise<string[]> {
  const filePath = path.join(repo, ".hivemind", "manager-reactive-calls.log");
  if (!(await exists(filePath))) {
    return [];
  }
  return (await readFile(filePath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
}

async function writeManagerProposalProfile(
  repo: string,
  proposal: Record<string, unknown>,
  tool = "manager",
  extraInvokeArgs: string[] = []
): Promise<void> {
  const agentPath = await writeAgent(repo, `${tool}-proposal-agent.mjs`, [`console.log(${JSON.stringify(JSON.stringify(proposal))});`]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath, ...extraInvokeArgs],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Manager executor fixture",
        agent_role: "builder",
        base_commit: baseCommit,
        acceptance_criterion: "Manager executor fixture reaches one deterministic result.",
        allowed_files: allowedFiles,
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

async function writeAcceptedPatchBundle(repo: string, taskId: string, baseCommit: string, edit: () => Promise<void>): Promise<void> {
  await git(repo, ["reset", "--hard", baseCommit]);
  await edit();
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
  await appendEvent(repo, {
    type: "patch.submitted",
    task_id: taskId,
    data: { patch_path: `.hivemind/patches/${taskId}/diff.patch`, changed_files: 1 }
  });
  await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "all changes are within scope" }
  });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

async function cleanupTempRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (worktreePath !== repo) {
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; url: string };
  assert.equal(parsed.event, "daemon.ready");
  return { child, url: parsed.url };
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    daemon.child.once("exit", () => resolve());
    daemon.child.kill();
  });
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not become ready; stderr: ${stderr}`));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(stdout.slice(0, newline).trim());
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before ready with code ${code}; stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
