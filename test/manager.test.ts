import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents, type HivemindEvent } from "../src/events.js";
import { currentBuildIdentity } from "../src/build-identity.js";
import { loadConfig } from "../src/config.js";
import { createTaskContract } from "../src/contract.js";
import { createDaemonServer } from "../src/daemon.js";
import { initProject } from "../src/init.js";
import { integratedTaskIdsFromEvents } from "../src/integration-state.js";
import { requestLease, requestLeaseForContract } from "../src/lease.js";
import { readQuotaLedger, readQuotaLedgerState, recordQuotaUsage, reserveMeteredCall } from "../src/resource-ledger.js";
import { latestTaskRunState } from "../src/run-state.js";
import {
  approvePendingManagerAction,
  continueAutonomousManagerLoop,
  executeManagerAction,
  runAutonomousManagerLoop,
  startManagerSession,
  startWorkspaceManagerSession,
  type ManagerAction,
  type ManagerAutonomousLoopResult,
  type ManagerProposedAction
} from "../src/manager.js";
import { createSpec, type SpecResult } from "../src/spec.js";
import { getStatus } from "../src/status.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { admitExecutionWave } from "../src/wave-admission.js";
import { authorizePlanlessManualTaskIfEligible } from "./support/manual-task.js";
import { createRatifiedSpec } from "./support/spec.js";
import { withTemplateRepo } from "./support/fixture-repo.js";


import {
  execFileAsync,
  cliPath,
  withTempRepo,
  runAutonomousLoopWithTypedApprovals,
  runConcurrentManagerFixture,
  maxConcurrentIntervals,
  managerContract,
  intentFor,
  testProposal,
  proposalFor,
  prepareLintedPlan,
  prepareLintedPlanWithTasks,
  planTaskFromContract,
  appendIntegratedDependencyEvents,
  contractFiles,
  childNames,
  assertExists,
  assertMissing,
  exists,
  git,
  readSession,
  readRequiredEvents,
  assertEventOrder,
  normalizeNewlines,
  setConfigTestCommand,
  setUnknownCoverageConfig,
  setConfigManagerAutonomy,
  setTierPatterns,
  setResourceSessionCeiling,
  allowFixtureManagerCalls,
  writeAgent,
  writeProfile,
  writeReactiveManagerProposalProfile,
  writeRedirectAwareManagerProfile,
  writePatchPipelineAwareManagerProfile,
  managerReactiveCalls,
  writeManagerProposalProfile,
  writePromptCapturingManagerProfile,
  writeContract,
  writeAcceptedPatchBundle,
  gitStdout,
  startDaemon,
  stopDaemon,
  listenServer,
  waitForDurableEvent,
  closeTestServer,
  postWorkspaceActionForTest,
  startRunLifecycleDaemon,
  withProcessEnv
} from "./support/manager-fixture.js";

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
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.manager.session_usage[result.value.session_id]?.requests, 1);
  });
});

test("full manager prompt permits only bounded safe batches independently of caller wording", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writePromptCapturingManagerProfile(repo, 16_000);

    const result = await startManagerSession(repo, "Execute the entire plan through every normal check.");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const prompt = await readFile(path.join(repo, ".hivemind", "captured-manager-prompt.txt"), "utf8");
    assert.match(prompt, /Choose the next action or one bounded safe action batch from current durable state/u);
    assert.match(prompt, /actions array MUST contain zero to five action objects/u);
    assert.match(prompt, /contiguous segment of create_task_contract -> request_lease -> check_write_intent -> create_worktree -> run_worker/u);
    assert.match(prompt, /Never put an action after run_worker or analyze_patch/u);
    assert.doesNotMatch(prompt, /next gated action sequence/u);
  });
});

test("manager context pressure checkpoints and sends a lean rehydrated prompt", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writePromptCapturingManagerProfile(repo, 16);

    const result = await startManagerSession(repo, "Build with a deliberately tiny manager context window");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const prompt = await readFile(path.join(repo, ".hivemind", "captured-manager-prompt.txt"), "utf8");
    assert.match(prompt, /Context rehydration mode: lean/);
    assert.match(prompt, /freshly read from \.hivemind\//);
    assert.match(prompt, /Choose the next action or one bounded safe action batch from current durable state/u);
    assert.match(prompt, /actions array MUST contain zero to five action objects/u);
    assert.match(prompt, /run_worker and analyze_patch are terminal/u);
    assert.doesNotMatch(prompt, /next gated action sequence/u);
    const snapshotPath = path.join(repo, ".hivemind", "resource", "checkpoints", "orchestrator.snapshot.json");
    const snapshotText = await readFile(snapshotPath, "utf8");
    const snapshot = JSON.parse(snapshotText) as {
      kind: string;
      reason: string;
      working_set_manifest: { status_ref: { source: string; authority: string } };
      narrative_notes: { purpose: string };
    };
    assert.equal(snapshot.kind, "orchestrator");
    assert.equal(snapshot.reason, "context_pressure");
    assert.equal(snapshot.working_set_manifest.status_ref.source, "getStatus(repoRoot)");
    assert.equal(snapshot.working_set_manifest.status_ref.authority, ".hivemind durable store");
    assert.equal(snapshot.narrative_notes.purpose, "working notes only; not authoritative state");
    assert.doesNotMatch(snapshotText, /"tasks"\s*:/);
    assert.doesNotMatch(snapshotText, /"leases"\s*:/);

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "orchestrator.checkpointed" && event.task_id === null), true);
    assert.equal(events.value.some((event) => event.type === "orchestrator.resumed" && event.task_id === null), true);
  });
});

test("manager lean rehydrate reads current disk state instead of stale snapshot narrative", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-CTX", baseCommit, ["README.md"]);
    const lease = await requestLease(repo, "T-CTX", ["README.md"]);
    assert.equal(lease.ok, true);
    await appendEvent(repo, {
      type: "task.started",
      task_id: "T-CTX",
      data: { tool: "fake-worker", worktree: path.join(repo, ".hivemind", "worktrees", "T-CTX") }
    });
    await mkdir(path.join(repo, ".hivemind", "resource", "checkpoints"), { recursive: true });
    await writeFile(
      path.join(repo, ".hivemind", "resource", "checkpoints", "orchestrator.snapshot.json"),
      `${JSON.stringify(
        {
          version: 1,
          kind: "orchestrator",
          narrative_notes: { distilled_summary: "STALE_SUMMARY active_lease_count=0 task T-CTX state failed" }
        },
        null,
        2
      )}\n`
    );
    await writePromptCapturingManagerProfile(repo, 16);

    const result = await startManagerSession(repo, "Continue from current disk state, not memory");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const prompt = await readFile(path.join(repo, ".hivemind", "captured-manager-prompt.txt"), "utf8");
    assert.doesNotMatch(prompt, /STALE_SUMMARY/);
    assert.match(prompt, /"T-CTX": \{\s+"state": "running"\s+\}/);
    assert.match(prompt, /"README\.md": "T-CTX"/);
    const session = JSON.parse(await readFile(path.join(repo, result.value.session_path), "utf8")) as {
      working_set: { status: { active_lease_count: number; task_count: number } };
    };
    assert.equal(session.working_set.status.active_lease_count, 1);
    assert.equal(session.working_set.status.task_count, 1);
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

  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(repo, {
      reason: "An unsafe multi-action proposal must fail before consumption.",
      human_approval_required_for: [],
      actions: [{ type: "get_status" }, { type: "get_status" }]
    });

    const multiple = await startManagerSession(repo, "Do not discard paid proposal actions");

    assert.equal(multiple.ok, false);
    if (multiple.ok) return;
    assert.match(multiple.reason, /single-only or taskless action/u);
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager refuses over-long and unsafe batch shapes before partial consumption", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-SHAPE", baseCommit, ["README.md"]);
    const cases: Array<{ name: string; actions: ManagerAction[]; reason: RegExp }> = [
      {
        name: "over-long",
        actions: [
          { type: "create_task_contract", contract },
          { type: "request_lease", task_id: "T-SHAPE" },
          { type: "check_write_intent", task_id: "T-SHAPE", intent: intentFor("T-SHAPE", ["README.md"]) },
          { type: "create_worktree", task_id: "T-SHAPE" },
          { type: "run_worker", task_id: "T-SHAPE", tool: "worker" },
          { type: "submit_patch", task_id: "T-SHAPE" }
        ],
        reason: /exceeds the 5-action safe batch bound/u
      },
      {
        name: "cross-task",
        actions: [
          { type: "request_lease", task_id: "T-A" },
          { type: "check_write_intent", task_id: "T-B", intent: intentFor("T-B", ["README.md"]) }
        ],
        reason: /exactly one task/u
      },
      {
        name: "skipped-step",
        actions: [
          { type: "request_lease", task_id: "T-SHAPE" },
          { type: "create_worktree", task_id: "T-SHAPE" }
        ],
        reason: /skips or reorders/u
      },
      {
        name: "result-dependent",
        actions: [
          { type: "analyze_patch", task_id: "T-SHAPE" },
          { type: "enqueue_patch", task_id: "T-SHAPE" }
        ],
        reason: /not a safe fixed-pipeline segment/u
      }
    ];

    for (const fixture of cases) {
      await writeManagerProposalProfile(
        repo,
        proposalFor(fixture.actions, fixture.actions.some((action) => action.type === "run_worker") ? ["run_worker"] : [])
      );
      const result = await startManagerSession(repo, `Refuse ${fixture.name}.`);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, fixture.reason);
    }

    const directScriptedBypass = await startManagerSession(repo, "Attempt a scripted autonomous batch.", {
      proposedAction: testProposal([
        { type: "request_lease", task_id: "T-SHAPE" },
        { type: "check_write_intent", task_id: "T-SHAPE", intent: intentFor("T-SHAPE", ["README.md"]) }
      ])
    });
    assert.equal(directScriptedBypass.ok, false);
    if (!directScriptedBypass.ok) assert.match(directScriptedBypass.reason, /scripted multi-action proposals are not valid/u);

    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
    assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-SHAPE.contract.json")), false);
    const events = await readRequiredEvents(repo);
    assert.equal(events.some((event) => event.type.startsWith("task.") || event.type.startsWith("lease.") || event.type.startsWith("write_intent.")), false);
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
    await allowFixtureManagerCalls(repo);
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
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.session_usage[session.session_id]?.requests, 1);
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

test("manager consumes a valid fixed-pipeline batch from one paid proposal cursor", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-BATCH", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([
        { type: "create_task_contract", contract },
        { type: "request_lease", task_id: "T-BATCH" },
        { type: "check_write_intent", task_id: "T-BATCH", intent: intentFor("T-BATCH", ["README.md"]) },
        { type: "create_worktree", task_id: "T-BATCH" }
      ]),
      after_create_worktree_ok: proposalFor([])
    });

    const started = await startManagerSession(repo, "Consume one safe batch.", { tool: "manager" });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const stored = await readSession(repo, started.value.session_path);
    assert.equal(stored.proposal_state.status, "pending");
    assert.equal(stored.proposal_state.next_action_index, 0);

    const result = await continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 8 });

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "completed");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), [
      "create_task_contract", "request_lease", "check_write_intent", "create_worktree"
    ]);
    assert.equal(result.value.steps.every((step) => step.result?.ok === true), true);
    assert.deepEqual(await managerReactiveCalls(repo), ["initial", "after_create_worktree_ok"]);
    const session = await readSession(repo, result.value.session_path);
    assert.equal(session.proposal_state.status, "consumed");
    assert.deepEqual(session.executed_actions.map((action) => action.type), [
      "create_task_contract", "request_lease", "check_write_intent", "create_worktree"
    ]);
  });
});

test("Review-everything pauses at the exact terminal run_worker identity inside a batch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const marker = path.join(repo, "batch-worker-ran.txt");
    const agentPath = await writeAgent(repo, "approved-batch-worker.mjs", [
      "const { appendFile, writeFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'approved batched worker\\n');",
      `await writeFile(${JSON.stringify(marker)}, 'ran');`
    ]);
    await writeProfile(repo, "approved-batch-worker", agentPath);
    const contract = managerContract("T-BATCH-APPROVAL", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([
        { type: "create_task_contract", contract },
        { type: "request_lease", task_id: "T-BATCH-APPROVAL" },
        { type: "check_write_intent", task_id: "T-BATCH-APPROVAL", intent: intentFor("T-BATCH-APPROVAL", ["README.md"]) },
        { type: "create_worktree", task_id: "T-BATCH-APPROVAL" },
        { type: "run_worker", task_id: "T-BATCH-APPROVAL", tool: "approved-batch-worker" }
      ], ["run_worker"]),
      after_run_worker_ok: proposalFor([])
    });

    const paused = await runAutonomousManagerLoop(repo, "Pause at the batch authorization boundary.", { tool: "manager", maxSteps: 8 });
    assert.equal(paused.ok, true, paused.ok ? undefined : paused.reason);
    if (!paused.ok) return;
    assert.equal(paused.value.status, "paused");
    assert.deepEqual(paused.value.steps.map((step) => step.action_type), [
      "create_task_contract", "request_lease", "check_write_intent", "create_worktree", "run_worker"
    ]);
    const pending = paused.value.steps.at(-1)?.pause;
    assert.ok(pending);
    assert.equal(pending.action_type, "run_worker");
    assert.equal(await exists(marker), false);
    const beforeApproval = await readSession(repo, paused.value.session_path);
    assert.equal(beforeApproval.proposal_state.status, "pending");
    assert.equal(beforeApproval.proposal_state.next_action_index, 4);

    const approved = await approvePendingManagerAction(repo, {
      session_id: paused.value.session_id,
      pending_action_id: pending.pending_action_id,
      action_type: pending.action_type,
      subject: pending.subject,
      expected_state_hash: pending.expected_state_hash
    });
    assert.equal(approved.ok, true, approved.ok ? undefined : approved.reason);
    if (!approved.ok) return;
    assert.equal(approved.value.result.ok, true);
    assert.equal(await exists(marker), true);
    const afterApproval = await readSession(repo, paused.value.session_path);
    assert.equal(afterApproval.proposal_state.status, "consumed");
    assert.equal(afterApproval.proposal_state.next_action_index, 5);
    assert.deepEqual(await managerReactiveCalls(repo), ["initial"]);
  });
});

test("manager stops at a mid-batch gate refusal and durably discards the remainder", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-BATCH-REFUSED", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const holder = await requestLease(repo, "T-LIVE-HOLDER", ["README.md"]);
    assert.equal(holder.ok, true, holder.ok ? undefined : holder.reason);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([
        { type: "create_task_contract", contract },
        { type: "request_lease", task_id: "T-BATCH-REFUSED" },
        { type: "check_write_intent", task_id: "T-BATCH-REFUSED", intent: intentFor("T-BATCH-REFUSED", ["README.md"]) },
        { type: "create_worktree", task_id: "T-BATCH-REFUSED" }
      ])
    });

    const result = await runAutonomousManagerLoop(repo, "Stop at the first refused member.", { tool: "manager", maxSteps: 8 });

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "stopped");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), ["create_task_contract", "request_lease"]);
    assert.equal(result.value.steps.at(-1)?.result?.ok, false);
    const session = await readSession(repo, result.value.session_path);
    assert.equal(session.proposal_state.status, "discarded");
    assert.equal(session.proposal_state.next_action_index, 2);
    assert.match(session.proposal_state.discard_reason ?? "", /request_lease.*failed/u);
    assert.deepEqual(session.executed_actions.map((action) => action.type), ["create_task_contract", "request_lease"]);
    assert.equal(await exists(path.join(repo, ".hivemind", "worktrees", "T-BATCH-REFUSED")), false);
    const events = await readRequiredEvents(repo);
    assert.equal(events.some((event) => event.type.startsWith("write_intent.") && event.task_id === "T-BATCH-REFUSED"), false);
    assert.deepEqual(await managerReactiveCalls(repo), ["initial"]);
  });
});

test("a terminal batched worker crash or timeout stops with cleanup and no predicted continuation", async () => {
  for (const failure of ["crash", "timeout"] as const) {
    await withTempRepo(async ({ repo, baseCommit }) => {
      await setConfigManagerAutonomy(repo, { level: "auto" });
      await createRatifiedSpec(repo, "S-001");
      const taskId = failure === "crash" ? "T-BATCH-CRASH" : "T-BATCH-TIMEOUT";
      const agentPath = await writeAgent(
        repo,
        `${failure}-batch-worker.mjs`,
        failure === "crash"
          ? ["console.error('hard crash fixture');", "process.exit(9);"]
          : ["setInterval(() => {}, 1000);"]
      );
      await writeProfile(repo, `${failure}-worker`, agentPath, "strong", 1, failure === "timeout" ? 50 : undefined);
      const contract = managerContract(taskId, baseCommit, ["README.md"]);
      await prepareLintedPlan(repo, contract);
      await writeReactiveManagerProposalProfile(repo, {
        initial: proposalFor([
          { type: "create_task_contract", contract },
          { type: "request_lease", task_id: taskId },
          { type: "check_write_intent", task_id: taskId, intent: intentFor(taskId, ["README.md"]) },
          { type: "create_worktree", task_id: taskId },
          { type: "run_worker", task_id: taskId, tool: `${failure}-worker` }
        ], ["run_worker"]),
        after_run_worker_rejected: proposalFor([{ type: "submit_patch", task_id: taskId }])
      });

      const result = await runAutonomousManagerLoop(repo, `Exercise batched worker ${failure}.`, { tool: "manager", maxSteps: 8 });

      assert.equal(result.ok, true, result.ok ? undefined : result.reason);
      if (!result.ok) return;
      assert.equal(result.value.status, "stopped");
      assert.deepEqual(result.value.steps.map((step) => step.action_type), [
        "create_task_contract", "request_lease", "check_write_intent", "create_worktree", "run_worker"
      ]);
      const finalResult = result.value.steps.at(-1)?.result;
      const reason = finalResult?.ok === false ? finalResult.reason : "";
      assert.match(reason, failure === "crash" ? /exited 9/u : /timed out/u);
      assert.equal(await exists(path.join(repo, ".hivemind", "worktrees", taskId)), false);
      assert.equal(await exists(path.join(repo, ".hivemind", "patches", taskId, "diff.patch")), true);
      assert.equal(Object.values(result.value.final_status.leases).includes(taskId), false);
      const events = await readRequiredEvents(repo);
      assert.equal(events.some((event) => event.type === "task.failed" && event.task_id === taskId), true);
      assert.equal(events.some((event) => event.type === "lease.released" && event.task_id === taskId), true);
      assert.deepEqual(await managerReactiveCalls(repo), ["initial"]);
    });
  }
});

test("LLM-proposed and Core-derived execution have equivalent work trails while Core removes happy-path manager calls", async () => {
  const observations: Array<{ mode: "single" | "batch" | "deterministic"; trail: string[]; managerCalls: number }> = [];
  for (const mode of ["single", "batch", "deterministic"] as const) {
    await withTempRepo(async ({ repo, baseCommit }) => {
      await setConfigManagerAutonomy(repo, { level: "auto" });
      await createRatifiedSpec(repo, "S-001");
      await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
      const agentPath = await writeAgent(repo, `${mode}-trail-worker.mjs`, [
        "const { appendFile } = await import('node:fs/promises');",
        "await appendFile('README.md', 'equivalent work trail\\n');"
      ]);
      await writeProfile(repo, "trail-worker", agentPath);
      const contract = managerContract("T-TRAIL", baseCommit, ["README.md"]);
      await prepareLintedPlan(repo, contract);
      const single = {
        initial: proposalFor([{ type: "create_task_contract", contract }]),
        after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-TRAIL" }]),
        after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-TRAIL", intent: intentFor("T-TRAIL", ["README.md"]) }]),
        after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: "T-TRAIL" }]),
        after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: "T-TRAIL", tool: "trail-worker" }], ["run_worker"]),
        after_run_worker_ok: proposalFor([{ type: "submit_patch", task_id: "T-TRAIL" }]),
        after_submit_patch_ok: proposalFor([{ type: "analyze_patch", task_id: "T-TRAIL" }]),
        after_analyze_patch_ok: proposalFor([{ type: "enqueue_patch", task_id: "T-TRAIL" }]),
        after_enqueue_patch_ok: proposalFor([{ type: "integrate_shadow" }], ["integrate_shadow"]),
        after_integrate_shadow_ok: proposalFor([])
      };
      const batch = {
        initial: proposalFor([
          { type: "create_task_contract", contract },
          { type: "request_lease", task_id: "T-TRAIL" },
          { type: "check_write_intent", task_id: "T-TRAIL", intent: intentFor("T-TRAIL", ["README.md"]) },
          { type: "create_worktree", task_id: "T-TRAIL" },
          { type: "run_worker", task_id: "T-TRAIL", tool: "trail-worker" }
        ], ["run_worker"]),
        after_run_worker_ok: proposalFor([
          { type: "submit_patch", task_id: "T-TRAIL" },
          { type: "analyze_patch", task_id: "T-TRAIL" }
        ]),
        after_analyze_patch_ok: proposalFor([{ type: "enqueue_patch", task_id: "T-TRAIL" }]),
        after_enqueue_patch_ok: proposalFor([{ type: "integrate_shadow" }], ["integrate_shadow"]),
        after_integrate_shadow_ok: proposalFor([])
      };
      await writeReactiveManagerProposalProfile(repo, mode === "single" ? single : batch, "manager", 2);

      let result: SpecResult<ManagerAutonomousLoopResult>;
      if (mode === "deterministic") {
        const started = await executeWorkspaceAction(repo, {
          type: "manager.start",
          payload: { message: "Run the Core-derived trail.", tool: "manager" }
        });
        assert.equal(started.ok, true, started.ok ? undefined : started.reason);
        if (!started.ok) return;
        result = await continueAutonomousManagerLoop(
          repo,
          (started.value as { session_id: string }).session_id,
          { tool: "manager", maxSteps: 16 }
        );
      } else {
        result = await runAutonomousManagerLoop(repo, `Run ${mode} trail.`, { tool: "manager", maxSteps: 16 });
      }
      assert.equal(result.ok, true, result.ok ? undefined : result.reason);
      if (!result.ok) return;
      assert.equal(result.value.status, "completed");
      const events = await readRequiredEvents(repo);
      observations.push({
        mode,
        trail: events
          .filter((event) =>
            !event.type.startsWith("autonomy.") &&
            event.type !== "orchestrator.checkpointed" &&
            event.type !== "orchestrator.resumed"
          )
          .map((event) => `${event.type}:${event.task_id ?? "project"}`),
        managerCalls: (await managerReactiveCalls(repo)).length
      });
    });
  }

  assert.deepEqual(observations[1].trail, observations[0].trail);
  assert.deepEqual(observations[2].trail, observations[0].trail);
  assert.equal(observations[0].managerCalls, 10);
  assert.equal(observations[1].managerCalls, 5);
  assert.equal(observations[2].managerCalls, 0);
});

test("sequence execution groups remain strictly serial even when worker capacity is available", async () => {
  const result = await runConcurrentManagerFixture({ taskCount: 2, concurrency: 2, mode: "sequence", workerDelayMs: 1_000 });

  assert.equal(maxConcurrentIntervals(result.intervals), 1);
  assert.equal(result.events.some((event) => event.type.startsWith("scheduler.wave_")), false);
});

test("all autonomy levels preserve the same complete work trail while changing only routine interruption", async () => {
  let baselineTrail: string[] | null = null;
  for (const level of ["auto", "review_plan", "review_everything"] as const) {
    await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigManagerAutonomy(repo, { level });
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    await createRatifiedSpec(repo, "S-001");
    const workerPath = await writeAgent(repo, "auto-worker.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'auto mode verified this change\\n');"
    ]);
    await writeProfile(repo, "auto-worker", workerPath);
    const contract = managerContract("T-AUTO-FULL", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-AUTO-FULL" }]),
      after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-AUTO-FULL", intent: intentFor("T-AUTO-FULL", ["README.md"]) }]),
      after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: "T-AUTO-FULL" }]),
      after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: "T-AUTO-FULL", tool: "auto-worker" }], ["run_worker"]),
      after_run_worker_ok: proposalFor([{ type: "submit_patch", task_id: "T-AUTO-FULL" }]),
      after_submit_patch_ok: proposalFor([{ type: "analyze_patch", task_id: "T-AUTO-FULL" }]),
      after_analyze_patch_ok: proposalFor([{ type: "enqueue_patch", task_id: "T-AUTO-FULL" }]),
      after_enqueue_patch_ok: proposalFor([{ type: "integrate_shadow" }], ["integrate_shadow"]),
      after_integrate_shadow_ok: proposalFor([])
    });

    const result = level === "review_everything"
      ? await runAutonomousLoopWithTypedApprovals(repo, "Run with every routine interruption.", "manager", 20, new Set(["run_worker", "integrate_shadow"]))
      : await runAutonomousManagerLoop(repo, "Run without routine interruptions.", { tool: "manager", maxSteps: 20 });

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "completed");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), [
      "create_task_contract", "request_lease", "check_write_intent", "create_worktree", "run_worker",
      "submit_patch", "analyze_patch", "enqueue_patch", "integrate_shadow"
    ]);
    assert.equal(result.value.steps.some((step) => step.pause !== undefined), false);
    assert.deepEqual(result.value.final_status.integration.status?.applied, ["T-AUTO-FULL"]);
    const events = await readRequiredEvents(repo);
    const policyApprovals = events.filter((event) => event.type === "manager.action_approved");
    assert.deepEqual(policyApprovals.map((event) => event.data.action_type), ["run_worker", "integrate_shadow"]);
    const expectedSource = level === "review_everything" ? "human" : "autonomy_policy";
    assert.equal(policyApprovals.every((event) => event.data.authorization_source === expectedSource && event.data.autonomy_level === level), true);
    assertEventOrder(events.map((event) => event.type), [
      "task.created", "lease.approved", "write_intent.approved", "task.started", "patch.submitted",
      "patch.accepted", "integration.queued", "integration.passed"
    ]);
    assert.equal(events.some((event) => event.type.startsWith("adoption.")), false);
    const durableWorkTrail = events
      .filter((event) => !event.type.startsWith("autonomy."))
      .map((event) => `${event.type}:${event.task_id ?? "project"}`);
    if (baselineTrail === null) baselineTrail = durableWorkTrail;
    else assert.deepEqual(durableWorkTrail, baselineTrail);
    });
  }
});

test("Auto still pauses Critical escalation before spawning the worker", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await setTierPatterns(repo, { critical_globs: ["README.md"] });
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-CRITICAL-AUTO", baseCommit, ["README.md"]);
    await prepareLintedPlanWithTasks(repo, [{ ...planTaskFromContract(contract), critical_path_approved: true }]);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "run_worker", task_id: "T-CRITICAL-AUTO", tool: "must-not-spawn" }], ["run_worker"])
    });

    const result = await runAutonomousManagerLoop(repo, "Attempt Critical work.", { tool: "manager", maxSteps: 2 });

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "paused");
    assert.equal(result.value.steps.at(-1)?.pause?.action_type, "create_task_contract");
    assert.match(result.value.steps.at(-1)?.pause?.reason ?? "", /Critical-tier scope/u);
    assert.deepEqual((await readSession(repo, result.value.session_path)).executed_actions, []);
  });
});

test("Auto records and surfaces a session-ceiling stop before another manager call", async () => {
  await withTempRepo(async ({ repo }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await createRatifiedSpec(repo, "S-001");
    await writeManagerProposalProfile(repo, proposalFor([{ type: "get_status" }]));
    const started = await startManagerSession(repo, "Use the stored no-paid first action.", { proposedAction: testProposal([{ type: "get_status" }]) });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    await setResourceSessionCeiling(repo, 1);

    const continued = await continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 3 });

    assert.equal(continued.ok, false);
    if (!continued.ok) assert.match(continued.reason, /token budget exceeded/u);
    const events = await readRequiredEvents(repo);
    const exhausted = events.find((event) => event.type === "quota.exhausted");
    assert.equal(exhausted?.data.session_id, started.value.session_id);
    assert.equal(exhausted?.data.source, "token_ceiling");
    assert.equal(await managerReactiveCalls(repo).then((calls) => calls.length), 0);
    const view = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(view.ok, true, view.ok ? undefined : view.reason);
    if (view.ok) {
      const needsYou = (view.value as { needs_you: Array<{ detail: string }> }).needs_you;
      assert.equal(needsYou.some((item) => /token budget exceeded/iu.test(item.detail)), true);
    }
  });
});

test("rewording manager producer reasons leaves intent and token decisions unchanged", async () => {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "hivemind-manager-reword-"));
  try {
    await cp(path.resolve("dist/src"), copyRoot, { recursive: true });
    const rewordings = [
      ["intent.js", "passed write intent not found for ", "approved intent is absent for "],
      ["intent.js", "write intent rejected: ", "lease coverage refused this intent: "],
      ["resource-ledger.js", "token budget exceeded: session ", "session capacity unavailable: "]
    ] as const;
    for (const [file, from, to] of rewordings) {
      const fullPath = path.join(copyRoot, file);
      const source = await readFile(fullPath, "utf8");
      assert.ok(source.includes(from), `${file} no longer contains ${from}`);
      await writeFile(fullPath, source.replaceAll(from, to), "utf8");
    }
    const copiedManager = await import(pathToFileURL(path.join(copyRoot, "manager.js")).href);

    await withTempRepo(async ({ repo, baseCommit }) => {
      await createRatifiedSpec(repo, "S-001");
      const contract = managerContract("T-MISSING-INTENT", baseCommit, ["README.md"]);
      await prepareLintedPlan(repo, contract);
      const created = await createTaskContract(repo, contract);
      assert.equal(created.ok, true, created.ok ? undefined : created.reason);
      const leased = await requestLeaseForContract(repo, "T-MISSING-INTENT");
      assert.equal(leased.ok, true, leased.ok ? undefined : leased.reason);

      const started = await copiedManager.startManagerSession(
        repo,
        "Resume the deterministic task.",
        { deterministicHappyPath: true, tool: "unused-fixture" }
      );
      assert.equal(started.ok, true, started.ok ? undefined : started.reason);
      if (!started.ok) return;
      assert.equal(started.value.proposed_action.actions[0]?.type, "check_write_intent");
    });

    await withTempRepo(async ({ repo, baseCommit }) => {
      await setConfigManagerAutonomy(repo, { level: "auto", redirect_limit: 2 });
      await createRatifiedSpec(repo, "S-001");
      const contract = managerContract("T-REWORD-REDIRECT", baseCommit, ["README.md"]);
      await prepareLintedPlan(repo, contract);
      await writeRedirectAwareManagerProfile(repo, "T-REWORD-REDIRECT", contract, "unused-worker");

      const result = await copiedManager.runAutonomousManagerLoop(repo, "Reach the intent gate.", { tool: "manager", maxSteps: 3 });
      assert.equal(result.ok, true, result.ok ? undefined : result.reason);
      if (!result.ok) return;
      assert.equal(result.value.steps[2]?.tier, "redirect");
      assert.match(result.value.steps[2]?.result?.reason ?? "", /lease coverage refused this intent/u);
    });

    await withTempRepo(async ({ repo }) => {
      await setConfigManagerAutonomy(repo, { level: "auto" });
      await createRatifiedSpec(repo, "S-001");
      await writeManagerProposalProfile(repo, proposalFor([{ type: "get_status" }]));
      const started = await startManagerSession(repo, "Use the stored no-paid first action.", {
        proposedAction: testProposal([{ type: "get_status" }])
      });
      assert.equal(started.ok, true, started.ok ? undefined : started.reason);
      if (!started.ok) return;
      await setResourceSessionCeiling(repo, 1);

      const continued = await copiedManager.continueAutonomousManagerLoop(repo, started.value.session_id, {
        tool: "manager",
        maxSteps: 3
      });
      assert.equal(continued.ok, false);
      if (continued.ok) return;
      assert.match(continued.reason, /session capacity unavailable/u);
      const events = await readRequiredEvents(repo);
      assert.equal(events.some((event) => event.type === "quota.exhausted" && event.data.session_id === started.value.session_id), true);
    });
  } finally {
    await rm(copyRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("daemon workspace dispatcher completes the Core-derived loop without manager calls or nested HTTP", async (context) => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const workerPath = await writeAgent(repo, "workspace-loop-worker.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed through the workspace dispatcher\\n');"
    ]);
    await writeProfile(repo, "workspace-worker", workerPath);
    const contract = managerContract("T-WORKSPACE", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-WORKSPACE" }]),
      after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-WORKSPACE", intent: intentFor("T-WORKSPACE", ["README.md"]) }]),
      after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: "T-WORKSPACE" }]),
      after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: "T-WORKSPACE", tool: "workspace-worker" }], ["run_worker"]),
      after_run_worker_ok: proposalFor([{ type: "submit_patch", task_id: "T-WORKSPACE" }]),
      after_submit_patch_ok: proposalFor([{ type: "analyze_patch", task_id: "T-WORKSPACE" }]),
      after_analyze_patch_ok: proposalFor([{ type: "enqueue_patch", task_id: "T-WORKSPACE" }]),
      after_enqueue_patch_ok: proposalFor([{ type: "integrate_shadow" }], ["integrate_shadow"]),
      after_integrate_shadow_ok: proposalFor([])
    }, "manager", 2);

    const daemon = createDaemonServer(repo, await currentBuildIdentity());
    const observedRoutes: string[] = [];
    daemon.on("request", (request) => observedRoutes.push(request.url ?? ""));
    await listenServer(daemon);
    const address = daemon.address() as AddressInfo;
    const daemonUrl = `http://127.0.0.1:${address.port}`;
    const previousDaemonUrl = process.env.HIVEMIND_DAEMON_URL;
    process.env.HIVEMIND_DAEMON_URL = daemonUrl;
    context.after(async () => {
      if (previousDaemonUrl === undefined) delete process.env.HIVEMIND_DAEMON_URL;
      else process.env.HIVEMIND_DAEMON_URL = previousDaemonUrl;
      await closeTestServer(daemon);
    });
    const dispatch = (action: Record<string, unknown>) => postWorkspaceActionForTest(daemonUrl, action);

    const started = await dispatch({
      type: "manager.start",
      payload: { message: "Drive the workspace loop.", tool: "manager" }
    });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const sessionId = (started.value as { session_id: string }).session_id;
    assert.deepEqual(await managerReactiveCalls(repo), []);

    let continued = await dispatch({
      type: "manager.continue",
      payload: { session_id: sessionId, tool: "manager", max_steps: 20 }
    });
    assert.equal(continued.ok, true, continued.ok ? undefined : continued.reason);
    if (!continued.ok) return;
    let loop = continued.value as ManagerAutonomousLoopResult;
    assert.equal(loop.status, "paused");
    assert.equal(loop.steps.at(-1)?.action_type, "run_worker");
    assert.deepEqual(await managerReactiveCalls(repo), []);

    for (const expectedAction of ["run_worker", "integrate_shadow"] as const) {
      const pending = loop.steps.at(-1)?.pause;
      assert.ok(pending, JSON.stringify(loop));
      assert.equal(pending.action_type, expectedAction);
      const approved = await dispatch({
        type: "manager.approve_pending",
        payload: {
          session_id: sessionId,
          pending_action_id: pending.pending_action_id,
          action_type: pending.action_type,
          subject: pending.subject,
          expected_state_hash: pending.expected_state_hash
        }
      });
      assert.equal(approved.ok, true, approved.ok ? undefined : approved.reason);
      continued = await dispatch({
        type: "manager.continue",
        payload: { session_id: sessionId, tool: "manager", max_steps: 20 }
      });
      assert.equal(continued.ok, true, continued.ok ? undefined : continued.reason);
      if (!continued.ok) return;
      loop = continued.value as ManagerAutonomousLoopResult;
    }

    assert.equal(loop.status, "completed");
    assert.deepEqual(await managerReactiveCalls(repo), []);
    assert.deepEqual(loop.final_status.integration.status?.applied, ["T-WORKSPACE"]);
    const session = await readSession(repo, `.hivemind/orchestrator/sessions/${sessionId}.json`);
    assert.equal(session.proposal_state.status, "consumed");
    assert.equal(session.executed_actions.length, 9);
    assert.equal(observedRoutes.length, 6);
    assert.deepEqual(new Set(observedRoutes), new Set(["/workspace/action"]));
  });
});

test("Core-derived execution authors a dependent task on its verified predecessor without manager calls", async () => {
  await withTempRepo(async ({ repo }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await writeFile(path.join(repo, "SECOND.md"), "second task seed\n");
    await git(repo, ["add", "SECOND.md"]);
    await git(repo, ["commit", "-m", "add dependent fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await createRatifiedSpec(repo, "S-001");
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const workerPath = await writeAgent(repo, "dependency-aware-worker.mjs", [
      "const { appendFile, readFile } = await import('node:fs/promises');",
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "if (input.includes('T-DEPENDENCY-ONE')) {",
      "  await appendFile('README.md', 'verified predecessor content\\n');",
      "} else {",
      "  const predecessor = await readFile('README.md', 'utf8');",
      "  if (!predecessor.includes('verified predecessor content')) process.exit(17);",
      "  await appendFile('SECOND.md', 'authored with verified predecessor visible\\n');",
      "}"
    ]);
    await writeProfile(repo, "dependency-aware-worker", workerPath);
    await writeReactiveManagerProposalProfile(repo, { initial: proposalFor([]) }, "manager", 2);
    const first = managerContract("T-DEPENDENCY-ONE", baseCommit, ["README.md"]);
    const second = {
      ...managerContract("T-DEPENDENCY-TWO", baseCommit, ["SECOND.md"]),
      read_only_files: ["README.md"]
    };
    await prepareLintedPlanWithTasks(repo, [
      planTaskFromContract(first),
      planTaskFromContract(second, ["T-DEPENDENCY-ONE"])
    ]);

    const started = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Drive the dependency-aware happy path.", tool: "manager" }
    });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const completed = await continueAutonomousManagerLoop(
      repo,
      (started.value as { session_id: string }).session_id,
      { tool: "manager", maxSteps: 32 }
    );
    assert.equal(completed.ok, true, completed.ok ? undefined : completed.reason);
    if (!completed.ok) return;
    assert.equal(completed.value.status, "completed");
    assert.deepEqual(await managerReactiveCalls(repo), []);
    const events = await readRequiredEvents(repo);
    assert.deepEqual([...integratedTaskIdsFromEvents(events)].sort(), ["T-DEPENDENCY-ONE", "T-DEPENDENCY-TWO"]);
    const secondPatch = await readFile(path.join(repo, ".hivemind", "patches", "T-DEPENDENCY-TWO", "diff.patch"), "utf8");
    assert.match(secondPatch, /authored with verified predecessor visible/u);
  });
});

test("pending guidance forces one judgment proposal before the next deterministic transition", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await createRatifiedSpec(repo, "S-001");
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const workerPath = await writeAgent(repo, "guided-worker.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'guided deterministic work\\n');"
    ]);
    await writeProfile(repo, "guided-worker", workerPath);
    const contract = managerContract("T-GUIDED", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "get_status" }]),
      after_get_status_ok: proposalFor([])
    }, "manager", 2);

    const started = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Drive the guided workspace loop.", tool: "manager" }
    });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    assert.deepEqual(await managerReactiveCalls(repo), []);
    const sessionId = (started.value as { session_id: string }).session_id;

    const guidance = await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "Prefer the smallest readable implementation." }
    });
    assert.equal(guidance.ok, true, guidance.ok ? undefined : guidance.reason);
    const judgment = await continueAutonomousManagerLoop(repo, sessionId, { tool: "manager", maxSteps: 1 });
    assert.equal(judgment.ok, true, judgment.ok ? undefined : judgment.reason);
    if (!judgment.ok) return;
    assert.deepEqual(judgment.value.steps.map((step) => step.action_type), ["get_status"]);
    const statusAfterJudgment = await getStatus(repo);
    assert.equal(statusAfterJudgment.ok, true, statusAfterJudgment.ok ? undefined : statusAfterJudgment.reason);
    if (!statusAfterJudgment.ok) return;
    assert.equal(statusAfterJudgment.value.tasks.length, 0);
    assert.deepEqual(await managerReactiveCalls(repo), ["initial"]);

    const completed = await continueAutonomousManagerLoop(repo, sessionId, { tool: "manager", maxSteps: 16 });
    assert.equal(completed.ok, true, completed.ok ? undefined : completed.reason);
    if (!completed.ok) return;
    assert.equal(completed.value.status, "completed");
    assert.deepEqual(await managerReactiveCalls(repo), ["initial"]);
    const events = await readRequiredEvents(repo);
    assert.equal(events.filter((event) => event.type === "human.guidance_consumed").length, 1);
  });
});

test("a deterministic mid-path refusal discards later actions and routes recovery to manager judgment", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await createRatifiedSpec(repo, "S-001");
    const contract = managerContract("T-DETERMINISTIC-REFUSED", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const holder = await requestLease(repo, "T-LIVE-HOLDER", ["README.md"]);
    assert.equal(holder.ok, true, holder.ok ? undefined : holder.reason);
    await writeReactiveManagerProposalProfile(repo, {
      after_request_lease_rejected: proposalFor([])
    }, "manager", 2);

    const started = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Drive until a deterministic floor refuses.", tool: "manager" }
    });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const sessionId = (started.value as { session_id: string }).session_id;
    const stopped = await continueAutonomousManagerLoop(repo, sessionId, { tool: "manager", maxSteps: 8 });
    assert.equal(stopped.ok, true, stopped.ok ? undefined : stopped.reason);
    if (!stopped.ok) return;
    assert.equal(stopped.value.status, "stopped");
    assert.deepEqual(stopped.value.steps.map((step) => step.action_type), ["create_task_contract", "request_lease"]);
    assert.deepEqual(await managerReactiveCalls(repo), []);
    const afterRefusal = await readSession(repo, stopped.value.session_path);
    assert.equal(afterRefusal.proposal_state.status, "discarded");
    assert.ok(afterRefusal.blocked_action);
    assert.equal(afterRefusal.blocked_action.action_type, "request_lease");
    assert.equal(await exists(path.join(repo, ".hivemind", "worktrees", "T-DETERMINISTIC-REFUSED")), false);

    const retry = await executeWorkspaceAction(repo, {
      type: "manager.retry_blocked",
      payload: { session_id: sessionId }
    });
    assert.equal(retry.ok, true, retry.ok ? undefined : retry.reason);
    const judged = await continueAutonomousManagerLoop(repo, sessionId, { tool: "manager", maxSteps: 2 });
    assert.equal(judged.ok, true, judged.ok ? undefined : judged.reason);
    assert.deepEqual(await managerReactiveCalls(repo), ["after_request_lease_rejected"]);
    const events = await readRequiredEvents(repo);
    assert.equal(events.some((event) => event.type === "manager.judgment_requested"), true);
    assert.equal(events.some((event) => event.type.startsWith("write_intent.") && event.task_id === "T-DETERMINISTIC-REFUSED"), false);
  });
});

test("daemon workspace task.stop interrupts an Auto worker without waiting behind the manager queue", async (context) => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await createRatifiedSpec(repo, "S-001");
    const workerPath = await writeAgent(repo, "auto-hanging-worker.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'partial work before stop\\n');",
      "setInterval(() => {}, 1000);"
    ]);
    await writeProfile(repo, "auto-hanging-worker", workerPath);
    const contract = managerContract("T-AUTO-STOP", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "create_task_contract", contract }]),
      after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: "T-AUTO-STOP" }]),
      after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: "T-AUTO-STOP", intent: intentFor("T-AUTO-STOP", ["README.md"]) }]),
      after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: "T-AUTO-STOP" }]),
      after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: "T-AUTO-STOP", tool: "auto-hanging-worker" }], ["run_worker"]),
      after_run_worker_rejected: proposalFor([])
    }, "manager", 2);

    const daemon = createDaemonServer(repo, await currentBuildIdentity());
    await listenServer(daemon);
    const address = daemon.address() as AddressInfo;
    const daemonUrl = `http://127.0.0.1:${address.port}`;
    context.after(() => closeTestServer(daemon));
    const dispatch = (action: Record<string, unknown>) => postWorkspaceActionForTest(daemonUrl, action);
    const started = await dispatch({ type: "manager.start", payload: { message: "Run until stopped.", tool: "manager" } });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const sessionId = (started.value as { session_id: string }).session_id;
    const continuation = dispatch({ type: "manager.continue", payload: { session_id: sessionId, tool: "manager", max_steps: 10 } });
    await waitForDurableEvent(repo, "task.worker_process_started", "T-AUTO-STOP");

    const stopped = await dispatch({ type: "task.stop", payload: { task_id: "T-AUTO-STOP", reason: "Stop from the workspace while Auto is running." } });
    assert.equal(stopped.ok, true, stopped.ok ? undefined : stopped.reason);
    const loop = await continuation;
    assert.equal(loop.ok, true, loop.ok ? undefined : loop.reason);
    if (loop.ok) assert.equal((loop.value as ManagerAutonomousLoopResult).status, "stopped");
    const events = await readRequiredEvents(repo);
    assert.equal(events.some((event) => event.type === "task.cancelled" && event.task_id === "T-AUTO-STOP"), true);
    assert.equal(events.some((event) => event.type === "lease.released" && event.task_id === "T-AUTO-STOP"), true);
    assert.equal(await exists(path.join(repo, ".hivemind", "worktrees", "T-AUTO-STOP")), false);
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

test("human-tier manager actions require the exact daemon-issued pending identity on every caller path", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeReactiveManagerProposalProfile(repo, {
      initial: proposalFor([{ type: "run_worker", task_id: "T-PENDING", tool: "fake" }], ["run_worker"])
    });
    const loop = await runAutonomousManagerLoop(repo, "Present one exact approval", { tool: "manager", maxSteps: 3 });
    assert.equal(loop.ok, true);
    if (!loop.ok) return;
    const pending = loop.value.steps.at(-1)?.pause;
    assert.ok(pending);

    const direct = await executeManagerAction(repo, loop.value.session_id, pending!.action);
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.match(direct.reason, /daemon-issued pending action and exact typed approval/u);

    const actionPath = path.join(repo, "human-tier-action.json");
    await writeFile(actionPath, `${JSON.stringify(pending!.action, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--session", loop.value.session_id, "--action", actionPath], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /daemon-issued pending action and exact typed approval/u);
        return true;
      }
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--session", loop.value.session_id, "--auto-loop", "--tool", "manager", "--approve-actions", "run_worker"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /unknown autonomous manager option: --approve-actions/u);
        return true;
      }
    );

    const forged = await approvePendingManagerAction(repo, {
      session_id: loop.value.session_id,
      pending_action_id: pending!.pending_action_id,
      action_type: pending!.action_type,
      subject: pending!.subject,
      expected_state_hash: "0".repeat(64)
    });
    assert.equal(forged.ok, false);

    const approved = await approvePendingManagerAction(repo, {
      session_id: loop.value.session_id,
      pending_action_id: pending!.pending_action_id,
      action_type: pending!.action_type,
      subject: pending!.subject,
      expected_state_hash: pending!.expected_state_hash
    });
    assert.equal(approved.ok, true);
    if (approved.ok) assert.equal(approved.value.result.ok, false);
    const continued = await continueAutonomousManagerLoop(repo, loop.value.session_id, { tool: "manager", maxSteps: 3 });
    assert.equal(continued.ok, true);
    if (continued.ok) assert.equal(continued.value.status, "stopped");
    const events = await readRequiredEvents(repo);
    const approval = events.find((event) => event.type === "manager.action_approved");
    assert.equal(approval?.data.pending_action_id, pending!.pending_action_id);
    assert.equal(approval?.data.result_ok, false);
  });
});

test("manager autonomous loop hard-stops on gate rejection without retrying or changing provider tier", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigManagerAutonomy(repo, { level: "auto" });
    await createRatifiedSpec(repo, "S-001");
    const agentPath = await writeAgent(repo, "weak-tier-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'weak provider should not run\\n');"
    ]);
    await writeProfile(repo, "weak", agentPath, "local", 1);
    // The provider floor being asserted below is the High floor, so the scope
    // has to be declared High. Init's default globs put README.md in Low,
    // where a local-tier provider is eligible and no rejection ever happens.
    await setTierPatterns(repo, { high_globs: ["README.md"] });
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

    const result = await runAutonomousLoopWithTypedApprovals(repo, "Drive until gate rejection", "manager", 10, new Set(["run_worker"]));

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

test("manager autonomous loop redirects out-of-scope write intent before worker restart", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await setConfigManagerAutonomy(repo, { redirect_limit: 2 });
    const agentPath = await writeAgent(repo, "redirect-worker-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'worker stayed in scope after redirect\\n');"
    ]);
    await writeProfile(repo, "strong-worker", agentPath, "strong", 1);
    const contract = managerContract("T-REDIRECT", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeRedirectAwareManagerProfile(repo, "T-REDIRECT", contract, "strong-worker");

    const result = await runAutonomousLoopWithTypedApprovals(repo, "Drive redirect-first correction", "manager", 12, new Set(["run_worker"]));

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "completed");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), [
      "create_task_contract",
      "request_lease",
      "check_write_intent",
      "check_write_intent",
      "create_worktree",
      "run_worker",
      "submit_patch",
      "analyze_patch"
    ]);
    assert.equal(result.value.steps[2].tier, "redirect");
    assert.equal(result.value.steps[2].result?.ok, false);
    assert.match(result.value.steps[2].redirect?.correction ?? "", /src\/schema\.ts/);
    assert.match(result.value.steps[2].redirect?.correction ?? "", /README\.md/);
    assert.equal(result.value.steps.slice(3).every((step) => step.result?.ok === true), true);

    const events = await readRequiredEvents(repo);
    assertEventOrder(
      events.map((event) => event.type),
      [
        "write_intent.rejected",
        "task.revision_requested",
        "task.redirected",
        "write_intent.approved",
        "task.completed",
        "patch.submitted",
        "patch.accepted"
      ]
    );
    const redirect = events.find((event) => event.type === "task.redirected" && event.task_id === "T-REDIRECT");
    assert.match(String(redirect?.data.correction), /src\/schema\.ts/);
    assert.match(String(redirect?.data.correction), /README\.md/);
    assert.equal(events.some((event) => event.type === "task.cancelled"), false);
    assert.deepEqual(await managerReactiveCalls(repo), [
      "initial",
      "after_create_task_contract_ok",
      "after_request_lease_ok",
      "correction_prompt_specific",
      "after_check_write_intent_rejected_redirected",
      "after_check_write_intent_ok",
      "after_create_worktree_ok",
      "after_run_worker_ok",
      "after_submit_patch_ok",
      "after_analyze_patch_ok"
    ]);
    assert.match(
      normalizeNewlines(await readFile(path.join(repo, ".hivemind", "worktrees", "T-REDIRECT", "README.md"), "utf8")),
      /worker stayed in scope after redirect/
    );
    assert.match(
      normalizeNewlines(await readFile(path.join(repo, ".hivemind", "patches", "T-REDIRECT", "diff.patch"), "utf8")),
      /worker stayed in scope after redirect/
    );
  });
});

test("manager redirect bound escalates repeated intent drift to re-plan without cancellation", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await setConfigManagerAutonomy(repo, { redirect_limit: 1 });
    const contract = managerContract("T-THRASH", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    await writeRedirectAwareManagerProfile(repo, "T-THRASH", contract, "strong-worker", { repeatBadIntentAfterRedirect: true });

    const result = await runAutonomousManagerLoop(repo, "Drive bounded redirect thrash", {
      tool: "manager",
      maxSteps: 10
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.status, "stopped");
    assert.deepEqual(result.value.steps.map((step) => step.action_type), ["create_task_contract", "request_lease", "check_write_intent", "check_write_intent"]);
    assert.equal(result.value.steps[2].tier, "redirect");
    const finalStep = result.value.steps.at(-1);
    assert.equal(finalStep?.tier, "gate_rejection");
    assert.match(finalStep?.stop?.reason ?? "", /redirect limit exhausted/);
    assert.match(finalStep?.stop?.recommendation ?? "", /re-plan/);

    const events = await readRequiredEvents(repo);
    assert.equal(events.filter((event) => event.type === "write_intent.rejected" && event.task_id === "T-THRASH").length, 2);
    assert.equal(events.filter((event) => event.type === "task.redirected" && event.task_id === "T-THRASH").length, 1);
    assert.equal(events.some((event) => event.type === "replan.triggered" && event.task_id === "T-THRASH"), true);
    assert.equal(events.some((event) => event.type === "task.blocked" && event.task_id === "T-THRASH"), true);
    assert.equal(events.some((event) => event.type === "task.cancelled"), false);
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

    const result = await runAutonomousLoopWithTypedApprovals(repo, "Drive crashing worker", "manager", 10, new Set(["run_worker"]));

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

    const result = await runAutonomousLoopWithTypedApprovals(repo, "Drive worker to submit", "manager", 10, new Set(["run_worker"]));

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
        assert.match(parsed.steps[0].result.reason ?? "", /explicitly ratified plan/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-BYPASS.contract.json")), false);
  });
});

test("manager create_task_contract refuses a dependent task until dependencies are event-integrated", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeFile(path.join(repo, "DEPENDENT.md"), "dependent fixture\n");
    await git(repo, ["add", "DEPENDENT.md"]);
    await git(repo, ["commit", "-m", "add dependent fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await createRatifiedSpec(repo, "S-001");
    const dependency = managerContract("T-BASE", baseCommit, ["README.md"]);
    const dependent = managerContract("T-DEP", baseCommit, ["DEPENDENT.md"]);
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
    await allowFixtureManagerCalls(repo);
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
    await allowFixtureManagerCalls(repo);
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
      routing_task_type: "other",
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
    assert.equal(events.value.some((event) => event.type === "task.completed" && event.task_id === "T-001"), true);
    assert.equal(events.value.some((event) => event.type === "integration.queued" && event.task_id === "T-001"), true);
    assert.equal(events.value.at(-1)?.type, "integration.passed");
  });
});

test("manager cannot bypass the configured High oracle floor at integration", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await allowFixtureManagerCalls(repo);
    await setUnknownCoverageConfig(repo);
    await setTierPatterns(repo, { high_globs: ["README.md"] });
    await writeContract(repo, "T-MANAGER-FLOOR", baseCommit, ["README.md"]);
    await writeAcceptedPatchBundle(repo, "T-MANAGER-FLOOR", baseCommit, async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\nmanager floor attempt\n");
    });
    await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
    await writeFile(
      path.join(repo, ".hivemind", "integration", "queue.json"),
      `${JSON.stringify([{ task_id: "T-MANAGER-FLOOR" }], null, 2)}\n`
    );
    const sessionResult = await startManagerSession(repo, "Attempt blocked integration", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "integrate_shadow" });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.result.ok, false);
    if (result.value.result.ok) {
      return;
    }
    assert.match(result.value.result.reason, /configured coverage is unknown for high tier/);
    assert.match(result.value.result.reason, /hivemind verify characterize \.\.\./);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "integration.blocked");
    assert.equal(events.value.some((event) => event.type === "integration.passed"), false);
  });
});

test("manager observes delayed daemon worker completion from the event trail after a quick run start", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await allowFixtureManagerCalls(repo);
    const sessionResult = await startManagerSession(repo, "Observe delayed daemon completion", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const simulatedBlockingFetchFailureMs = 100;
    const daemon = await startRunLifecycleDaemon(repo, {
      taskId: "T-DELAY",
      completionDelayMs: simulatedBlockingFetchFailureMs + 650
    });
    try {
      await withProcessEnv({ HIVEMIND_DAEMON_URL: daemon.url, HIVEMIND_RUN_WAIT_TIMEOUT_MS: "5000" }, async () => {
        const startedAt = Date.now();
        const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "run_worker", task_id: "T-DELAY", tool: "fake-delayed" });
        const elapsedMs = Date.now() - startedAt;

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.result.ok, true);
        if (!result.value.result.ok) {
          return;
        }
        const runResult = result.value.result.value as { task_id: string; changed_files: number };
        assert.equal(runResult.task_id, "T-DELAY");
        assert.equal(runResult.changed_files, 1);
        assert.equal(daemon.runRequests, 1);
        assert.equal(daemon.markFailedRequests, 0);
        assert.ok(elapsedMs >= simulatedBlockingFetchFailureMs, `manager returned before simulated blocking timeout: ${elapsedMs}ms`);
      });
    } finally {
      await daemon.close();
    }

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const started = events.value.find((event) => event.type === "task.started" && event.task_id === "T-DELAY");
    const completed = events.value.find((event) => event.type === "task.completed" && event.task_id === "T-DELAY");
    assert.notEqual(started, undefined);
    assert.notEqual(completed, undefined);
    assert.ok(events.value.indexOf(started!) < events.value.indexOf(completed!));
    assert.equal(latestTaskRunState(events.value, "T-DELAY").state, "completed");
  });
});

test("manager timeout records durable task.failed for daemon-started runs that never complete", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await allowFixtureManagerCalls(repo);
    const sessionResult = await startManagerSession(repo, "Timeout a daemon-started run", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const daemon = await startRunLifecycleDaemon(repo, { taskId: "T-HANG" });
    try {
      await withProcessEnv({ HIVEMIND_DAEMON_URL: daemon.url, HIVEMIND_RUN_WAIT_TIMEOUT_MS: "50" }, async () => {
        const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "run_worker", task_id: "T-HANG", tool: "fake-hanging" });

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.result.ok, false);
        if (result.value.result.ok) {
          return;
        }
        assert.match(result.value.result.reason, /task T-HANG worker run failed: timed out waiting for task\.completed\/task\.failed/);
        assert.equal(daemon.runRequests, 1);
        assert.equal(daemon.markFailedRequests, 1);
      });
    } finally {
      await daemon.close();
    }

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const state = latestTaskRunState(events.value, "T-HANG");
    assert.equal(state.state, "failed");
    if (state.state === "failed") {
      assert.match(String(state.failed.data.reason), /timed out waiting for task\.completed\/task\.failed/);
      assert.equal(state.failed.data.source, "manager_wait_timeout");
    }
  });
});

test("manager observes quota pause without marking a daemon-started run failed", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    await allowFixtureManagerCalls(repo);
    const sessionResult = await startManagerSession(repo, "Observe quota pause", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const daemon = await startRunLifecycleDaemon(repo, { taskId: "T-PAUSE", quotaPauseAfterStart: true });
    try {
      await withProcessEnv({ HIVEMIND_DAEMON_URL: daemon.url, HIVEMIND_RUN_WAIT_TIMEOUT_MS: "5000" }, async () => {
        const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "run_worker", task_id: "T-PAUSE", tool: "fake-paused" });

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.result.ok, false);
        if (result.value.result.ok) {
          return;
        }
        assert.match(result.value.result.reason, /task T-PAUSE quota paused awaiting reset/);
        assert.equal(daemon.runRequests, 1);
        assert.equal(daemon.markFailedRequests, 0);
      });
    } finally {
      await daemon.close();
    }

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "task.paused" && event.task_id === "T-PAUSE"), true);
    assert.equal(events.value.some((event) => event.type === "task.failed" && event.task_id === "T-PAUSE"), false);
  });
});

test("manager submit_patch refuses a bundle without task.completed evidence", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-NOCOMPLETE", baseCommit, ["README.md"]);
    const patchDir = path.join(repo, ".hivemind", "patches", "T-NOCOMPLETE");
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "diff.patch"), "");
    const sessionResult = await startManagerSession(repo, "Reject uncompleted submit", { proposedAction: testProposal() });
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "submit_patch", task_id: "T-NOCOMPLETE" });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.result.ok, false);
    assert.match(result.value.result.reason, /submit_patch requires a task\.completed event/);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "patch.submitted" && event.task_id === "T-NOCOMPLETE"), false);
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
    await allowFixtureManagerCalls(repo);
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
    await allowFixtureManagerCalls(repo);
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
