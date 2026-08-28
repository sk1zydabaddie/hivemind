import { DEFAULT_RUN_TOKEN_CEILING, DEFAULT_SESSION_TOKEN_CEILING } from "../src/config.js";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { readPendingHumanGuidance } from "../src/human-guidance.js";
import { startManagerSession } from "../src/manager.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import { executeWorkspaceAction, workspaceActionTypes } from "../src/workspace-actions.js";
import { loadAdmittedValueQualityRun } from "../src/value-quality.js";
import { runAdapterProcess, type AdapterProfile } from "../src/adapter.js";
import { createTentativePlan, groundTentativePlan, lintTentativePlan, reviewPlanForRatification } from "../src/plan.js";
import { readQuotaLedger, reserveMeteredCall } from "../src/resource-ledger.js";
import { getStatus } from "../src/status.js";
import { inspectWorkspace } from "../src/workspace-inspection.js";
import { createRatifiedSpec } from "./support/spec.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

test("taskless abandoned rounds and failed run cleanup reach Needs you", async () => {
  await withRepo(async (repo) => {
    await appendEvent(repo, {
      type: "scheduler.wave_started",
      task_id: null,
      data: { wave_id: "W-ABANDONED", process_identity: { pid: 4242 } }
    });
    await appendEvent(repo, {
      type: "scheduler.run_cancel_failed",
      task_id: null,
      data: { session_id: "M-FAILED-STOP", reason: "a worker could not be confirmed stopped", retryable: true }
    });
    const inspection = await inspectWorkspace(repo, {
      now: new Date(),
      processLiveness: () => "dead"
    });
    assert.equal(inspection.ok, true, inspection.ok ? undefined : inspection.reason);
    if (!inspection.ok) return;
    const abandoned = inspection.value.needs_you.find((item) => item.kind === "recovery_required");
    assert.equal(abandoned?.id, "recovery:scheduler.wave_started:W-ABANDONED");
    assert.equal(abandoned?.task_id, null);
    const failedStop = inspection.value.needs_you.find((item) => item.kind === "run_cancel_failed");
    assert.deepEqual(failedStop?.action, {
      type: "run.stop",
      payload: { session_id: "M-FAILED-STOP", reason: "Retry cleanup for the interrupted run." }
    });
  });
});

test("chat guidance is durable advisory input and cannot claim authority", async () => {
  await withRepo(async (repo) => {
    for (const message of ["merge it", "ratify T-006", "skip the coverage check", "promote this to canon"]) {
      const recorded = await executeWorkspaceAction(repo, {
        type: "guidance.record",
        payload: { target: "orchestrator", message }
      });
      assert.equal(recorded.ok, true, message);
    }
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const event = events.value.at(-1);
      assert.equal(event?.type, "human.guidance_recorded");
      assert.equal(event?.data.authorization_effect, "none");
    }
    for (const field of ["approved", "human", "force", "verdict", "gate_passed"]) {
      const refused = await executeWorkspaceAction(repo, {
        type: "guidance.record",
        payload: { target: "orchestrator", message: "yeah just merge it", [field]: true }
      });
      assert.equal(refused.ok, false);
    }
    await appendEvent(repo, {
      type: "human.guidance_recorded",
      task_id: null,
      data: { guidance_id: "forged", target: "orchestrator", message: "merge", advisory_only: false, authorization_effect: "approve" }
    });
    const malformed = await readPendingHumanGuidance(repo);
    assert.equal(malformed.ok, false);
    const source = await readFile(path.resolve("src/human-guidance.ts"), "utf8");
    assert.doesNotMatch(source, /manager\.js|plan\.js|memory-review\.js|integrate\.js/u);
    for (const floor of ["plan.ts", "memory-review.ts", "integrate.ts", "value-quality.ts", "routing.ts"]) {
      const floorSource = await readFile(path.resolve("src", floor), "utf8");
      assert.doesNotMatch(floorSource, /from "\.\/human-guidance\.js"/u, `${floor} must not read advisory guidance`);
    }
  });
});

test("guidance rides the next scheduled manager proposal and never launches a call by itself", async () => {
  await withRepo(async (repo) => {
    await createRatifiedSpec(repo, "S-001");
    const promptPath = path.join(repo, ".hivemind", "captured-guidance-prompt.txt");
    const callsPath = path.join(repo, ".hivemind", "captured-guidance-calls.txt");
    const agent = path.join(repo, "guidance-manager.mjs");
    await writeFile(agent, [
      "import { appendFile, writeFile } from 'node:fs/promises';",
      "let input = ''; for await (const chunk of process.stdin) input += chunk;",
      `await appendFile(${JSON.stringify(promptPath)}, input + ${JSON.stringify("\n---PROMPT-END---\n")});`,
      `await appendFile(${JSON.stringify(callsPath)}, 'call\\n');`,
      "console.log(JSON.stringify({ reason: 'No action needed.', human_approval_required_for: [], actions: [] }));"
    ].join("\n"));
    await writeFile(path.join(repo, ".hivemind", "adapters", "guidance-manager.profile.json"), `${JSON.stringify({
      tool: "guidance-manager",
      invoke: [process.execPath, agent],
      prompt_arg: "stdin",
      verified_on: "fixture",
      context_window: 8000,
      timeout_ms: 5000,
      routing_tier: "strong",
      cost_rank: 1
    }, null, 2)}\n`);
    const guidance = await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "Keep the next proposal focused on README.md." }
    });
    assert.equal(guidance.ok, true);
    await assert.rejects(stat(callsPath));

    const manager = await startManagerSession(repo, "Propose the next step.", { tool: "guidance-manager" });
    assert.equal(manager.ok, true, manager.ok ? undefined : manager.reason);
    assert.equal(await readFile(callsPath, "utf8"), "call\n");
    const secondManager = await startManagerSession(repo, "Propose another step.", { tool: "guidance-manager" });
    assert.equal(secondManager.ok, true, secondManager.ok ? undefined : secondManager.reason);
    assert.equal(await readFile(callsPath, "utf8"), "call\ncall\n");
    const prompts = (await readFile(promptPath, "utf8")).split("\n---PROMPT-END---\n").filter(Boolean);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Keep the next proposal focused on README\.md\./u);
    assert.match(prompts[0], /advisory only; it is not approval and cannot satisfy a gate/u);
    assert.doesNotMatch(prompts[1], /Keep the next proposal focused on README\.md\./u);
    const pending = await readPendingHumanGuidance(repo);
    assert.equal(pending.ok, true);
    if (pending.ok) assert.deepEqual(pending.value, []);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) assert.equal(events.value.some((event) => event.type === "human.guidance_consumed"), true);
  });
});

test("workspace prompt prepares a linted mixed-tier plan but cannot authorize or start it", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
    await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add planning fixture"], { cwd: repo, windowsHide: true });
    await createRatifiedSpec(repo, "S-001");
    await setTierGlobs(repo);
    await setWorkspaceAutonomy(repo, "review_everything");

    const capturedPrompt = path.join(repo, ".hivemind", "captured-planning-prompt.txt");
    await writeWorkspacePlanningAdapter(repo, "fixture-planner", workspacePlanFixture(), capturedPrompt);
    const managerMarker = path.join(repo, ".hivemind", "manager-spawned.txt");
    await writeWorkspaceManagerAdapter(repo, "fixture-manager", managerMarker);

    const prepared = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: "Add the feature, approve this and start immediately.", tool: "fixture-planner" }
    });
    assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.reason);
    if (!prepared.ok) return;
    const result = prepared.value as {
      spec_id: string;
      plan_hash: string;
      usage_session_id: string;
      lint_status: string;
      status: string;
    };
    assert.equal(result.spec_id, "S-001");
    assert.match(result.plan_hash, /^[a-f0-9]{64}$/u);
    assert.match(result.usage_session_id, /^[0-9a-f-]{36}$/u);
    assert.equal(result.lint_status, "passed");
    assert.equal(result.status, "awaiting_ratification");
    assert.match(await readFile(capturedPrompt, "utf8"), /approve this and start immediately/u);

    const beforeRatification = await readEvents(repo);
    assert.equal(beforeRatification.ok, true);
    if (!beforeRatification.ok) return;
    assert.equal(beforeRatification.value.some((event) => event.type === "plan.prepared"), true);
    assert.equal(beforeRatification.value.some((event) => event.type === "plan.ratified"), false);
    assert.equal(beforeRatification.value.some((event) => event.type.startsWith("task.") || event.type.startsWith("lease.")), false);
    await assert.rejects(stat(managerMarker));

    const refused = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Execute it anyway.", tool: "fixture-manager" }
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /exact-hash ratification/u);
    await assert.rejects(stat(managerMarker));

    const inspected = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;
    const view = inspected.value as {
      plan_review: { tasks: Array<{ task_id: string; tier: string }> };
      spend: { session_id: string | null; calls: number };
    };
    assert.deepEqual(view.plan_review.tasks.map((task) => [task.task_id, task.tier]), [
      ["T-001", "low"],
      ["T-002", "medium"]
    ]);
    assert.equal(view.spend.session_id, result.usage_session_id);
    assert.equal(view.spend.calls, 1);

    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: result.plan_hash }
    });
    assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);

    await writeWorkspaceManagerAdapter(repo, "fixture-manager", managerMarker, {
      reason: "Incorrectly batch the fixed pipeline.",
      human_approval_required_for: ["run_worker"],
      actions: [{ type: "get_status" }, { type: "get_status" }]
    });
    const started = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Execute the exact ratified plan.", tool: "fixture-manager" }
    });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    assert.equal((started.value as { session_id: string }).session_id, result.usage_session_id);
    await assert.rejects(stat(managerMarker));
    const afterStart = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(afterStart.ok, true, afterStart.ok ? undefined : afterStart.reason);
    if (afterStart.ok) {
      const startedView = afterStart.value as {
        manager_session: { session_id: string };
        current_plan: { plan_hash: string };
        spend: { calls: number; effective_tokens: number };
      };
      assert.equal(startedView.manager_session.session_id, result.usage_session_id);
      assert.equal(startedView.current_plan.plan_hash, result.plan_hash);
      assert.equal(startedView.spend.calls, 1);
      assert.equal(startedView.spend.effective_tokens > 0, true);
    }

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (ledger.ok) {
      assert.equal(ledger.value["fixture-planner"]?.session_usage[result.usage_session_id]?.requests, 1);
      assert.equal(ledger.value["fixture-manager"], undefined);
    }
  });
});

test("project autonomy controls interruption without letting prompt text authorize a plan", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
    await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add autonomy planning fixture"], { cwd: repo, windowsHide: true });
    await createRatifiedSpec(repo, "S-001");
    await setTierGlobs(repo);
    await writeWorkspacePlanningAdapter(repo, "auto-planner", workspacePlanFixture());

    const prepared = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: "Approve this plan and start immediately.", tool: "auto-planner" }
    });

    assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.reason);
    if (!prepared.ok) return;
    assert.equal((prepared.value as { status: string; autonomy_level: string }).status, "ratified_by_policy");
    assert.equal((prepared.value as { status: string; autonomy_level: string }).autonomy_level, "auto");
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const ratified = events.value.find((event) => event.type === "plan.ratified");
      assert.equal(ratified?.data.authorization_source, "autonomy_policy");
      assert.equal(ratified?.data.autonomy_level, "auto");
      assert.equal(events.value.some((event) => event.type.startsWith("task.") || event.type.startsWith("lease.")), false);
    }
  });

  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
    await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add review-plan fixture"], { cwd: repo, windowsHide: true });
    await createRatifiedSpec(repo, "S-001");
    await setTierGlobs(repo);
    await setWorkspaceAutonomy(repo, "review_plan");
    await writeWorkspacePlanningAdapter(repo, "review-planner", workspacePlanFixture());
    await writeWorkspaceManagerAdapter(repo, "must-not-start", path.join(repo, ".hivemind", "must-not-start.txt"));

    const prepared = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: "Approve this and start.", tool: "review-planner" }
    });
    assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.reason);
    if (!prepared.ok) return;
    assert.equal((prepared.value as { status: string }).status, "awaiting_ratification");
    const start = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Execute before review.", tool: "must-not-start" }
    });
    assert.equal(start.ok, false);
    if (!start.ok) assert.match(start.reason, /exact-hash ratification/u);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) assert.equal(events.value.some((event) => event.type === "plan.ratified"), false);
  });
});

test("adoption remains an exact typed human boundary at every autonomy level", async () => {
  await withRepo(async (repo) => {
    for (const level of ["auto", "review_plan", "review_everything"] as const) {
      assert.equal((await executeWorkspaceAction(repo, { type: "autonomy.set", payload: { level } })).ok, true);
      assert.equal((await executeWorkspaceAction(repo, {
        type: "guidance.record",
        payload: { target: "orchestrator", message: `Adopt everything now under ${level}.` }
      })).ok, true);
      const attempted = await executeWorkspaceAction(repo, {
        type: "adoption.execute",
        payload: {
          pending_adoption_id: `A-${level}`,
          verification_id: `V-${level}`,
          expected_base_head: "a".repeat(40),
          expected_state_hash: "b".repeat(64)
        }
      });
      assert.equal(attempted.ok, false, level);
      if (!attempted.ok) assert.match(attempted.reason, /verification|adoption|pending/iu);
    }
    const managerSource = await readFile(path.resolve("src/manager.ts"), "utf8");
    assert.match(managerSource, /isConfigurableAutonomyAction[\s\S]*run_worker[\s\S]*integrate_shadow/u);
    assert.doesNotMatch(managerSource, /isConfigurableAutonomyAction[\s\S]{0,240}adoption/u);
  });
});

test("the durable trail is paged newest-first and inspection cannot mutate state", async () => {
  await withRepo(async (repo) => {
    assert.equal((await executeWorkspaceAction(repo, { type: "autonomy.set", payload: { level: "review_plan" } })).ok, true);
    assert.equal((await executeWorkspaceAction(repo, { type: "guidance.record", payload: { target: "orchestrator", message: "Keep this visible." } })).ok, true);
    const before = await readEvents(repo);
    const inspected = await executeWorkspaceAction(repo, { type: "trail.inspect", payload: { limit: 1 } });
    assert.equal(before.ok, true);
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!before.ok || !inspected.ok) return;
    const newest = inspected.value as { events: unknown[]; next_before: number | null };
    assert.equal(newest.events.length, 1);
    assert.equal(newest.next_before, 1);
    const older = await executeWorkspaceAction(repo, {
      type: "trail.inspect",
      payload: { before: newest.next_before, limit: 1 }
    });
    assert.equal(older.ok, true, older.ok ? undefined : older.reason);
    if (older.ok) {
      const page = older.value as { events: unknown[]; next_before: number | null };
      assert.equal(page.events.length, 1);
      assert.equal(page.next_before, null);
      assert.deepEqual([...newest.events, ...page.events], [...before.value].reverse());
    }
    assert.equal((await executeWorkspaceAction(repo, { type: "trail.inspect", payload: { limit: 0 } })).ok, false);
    assert.equal((await executeWorkspaceAction(repo, { type: "trail.inspect", payload: { before: 99, limit: 1 } })).ok, false);
    const after = await readEvents(repo);
    assert.equal(after.ok, true);
    if (after.ok) assert.deepEqual(after.value, before.value);
  });
});

test("a 4,000-event archive stays bounded per page and run projection buckets events once", async () => {
  await withRepo(async (repo) => {
    const seed = await readEvents(repo);
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    const events = Array.from({ length: 4_001 }, (_, index) => ({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      type: "conversation.message_recorded",
      task_id: null,
      data: { thread_id: "scale", message_id: `scale-${index}`, text: `message ${index}` }
    }));
    await appendFile(
      path.join(repo, ".hivemind", "log", "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8"
    );
    let before: number | undefined;
    let count = 0;
    let pages = 0;
    do {
      const inspected = await executeWorkspaceAction(repo, {
        type: "trail.inspect",
        payload: { ...(before === undefined ? {} : { before }), limit: 137 }
      });
      assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
      if (!inspected.ok) return;
      const page = inspected.value as { events: unknown[]; next_before: number | null };
      assert.ok(page.events.length <= 137);
      count += page.events.length;
      pages += 1;
      before = page.next_before ?? undefined;
      if (page.next_before === null) break;
    } while (pages < 100);
    assert.equal(count, seed.value.length + events.length);
    assert.ok(pages >= 30);
  });

  const source = await readFile(path.resolve("src/workspace-inspection.ts"), "utf8");
  const body = source.slice(source.indexOf("async function inspectHistory("), source.indexOf("function presentMemoryProposal"));
  assert.doesNotMatch(body, /events\.filter\(/u);
  assert.match(body, /eventsByRun\[runIndex\]/u);
});

test("a run with no durable progress surfaces recovery while a healthy long worker does not false-alert", async () => {
  await withRepo(async (repo) => {
    await prepareRatifiedWorkspacePlan(repo);
    const ratifiedEvents = await readEvents(repo);
    assert.equal(ratifiedEvents.ok, true);
    if (!ratifiedEvents.ok) return;
    const ratifiedAt = ratifiedEvents.value.find((event) => event.type === "plan.ratified")?.ts;
    assert.ok(ratifiedAt);

    const stranded = await inspectWorkspace(repo, {
      now: new Date(Date.parse(ratifiedAt!) + 46_000),
      stallIntervalMs: 45_000
    });
    assert.equal(stranded.ok, true, stranded.ok ? undefined : stranded.reason);
    if (!stranded.ok) return;
    const startAlert = stranded.value.needs_you.find((item) => item.kind === "run_stalled");
    assert.equal(startAlert?.title, "Approved work has not started");
    assert.equal(startAlert?.action?.type, "manager.start");
    assert.match(startAlert?.detail ?? "", /Expected next: start the 2-task run/u);

    const session = await startManagerSession(repo, "Run the approved plan.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Inspect the current state.",
        actions: [{ type: "get_status" }],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);
    if (!session.ok) return;
    await writeFile(path.join(repo, ".hivemind", "adapters", "stall-worker.profile.json"), `${JSON.stringify({
      tool: "stall-worker",
      invoke: [process.execPath, "worker.mjs"],
      prompt_arg: "stdin",
      verified_on: "fixture",
      context_window: 8_000,
      timeout_ms: 120_000
    }, null, 2)}\n`);
    const started = await appendEvent(repo, {
      type: "task.started",
      task_id: "T-001",
      data: { run_id: "R-stall-fixture", tool: "stall-worker" }
    });
    assert.equal(started.ok, true);
    const workerStarted = await appendEvent(repo, {
      type: "task.worker_process_started",
      task_id: "T-001",
      data: {
        version: 1,
        run_id: "R-stall-fixture",
        tool: "stall-worker",
        pid: process.pid,
        process_instance_id: "fixture-worker-instance"
      }
    });
    assert.equal(workerStarted.ok, true);
    const latest = await readEvents(repo);
    assert.equal(latest.ok, true);
    if (!latest.ok) return;
    const workerAt = latest.value.at(-1)!.ts;

    const healthy = await inspectWorkspace(repo, {
      now: new Date(Date.parse(workerAt) + 90_000),
      stallIntervalMs: 45_000,
      processLiveness: () => "alive"
    });
    assert.equal(healthy.ok, true, healthy.ok ? undefined : healthy.reason);
    if (healthy.ok) assert.equal(healthy.value.needs_you.some((item) => item.kind === "run_stalled"), false);

    const ambiguous = await inspectWorkspace(repo, {
      now: new Date(Date.parse(workerAt) + 180_000),
      stallIntervalMs: 45_000,
      processLiveness: () => "unknown"
    });
    assert.equal(ambiguous.ok, true, ambiguous.ok ? undefined : ambiguous.reason);
    if (ambiguous.ok) assert.equal(ambiguous.value.needs_you.some((item) => item.kind === "run_stalled"), false);

    const hung = await inspectWorkspace(repo, {
      now: new Date(Date.parse(workerAt) + 180_000),
      stallIntervalMs: 45_000,
      processLiveness: () => "alive"
    });
    assert.equal(hung.ok, true, hung.ok ? undefined : hung.reason);
    if (!hung.ok) return;
    const hungAlert = hung.value.needs_you.find((item) => item.kind === "run_stalled");
    assert.equal(hungAlert?.task_id, "T-001");
    assert.equal(hungAlert?.action?.type, "task.stop");
    assert.match(hungAlert?.detail ?? "", /past its 120-second time limit/u);
  });
});

test("stall inspection is per lane so a healthy worker cannot suppress a stalled sibling", async () => {
  await withRepo(async (repo) => {
    await prepareRatifiedWorkspacePlan(repo);
    const session = await startManagerSession(repo, "Inspect concurrent worker health.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Inspect the current state.",
        actions: [{ type: "get_status" }],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);
    if (!session.ok) return;
    await writeFile(path.join(repo, ".hivemind", "adapters", "lane-worker.profile.json"), `${JSON.stringify({
      tool: "lane-worker",
      invoke: [process.execPath, "worker.mjs"],
      prompt_arg: "stdin",
      verified_on: "fixture",
      context_window: 8_000,
      timeout_ms: 1
    }, null, 2)}\n`);
    for (const [taskId, pid] of [["T-001", process.pid], ["T-002", process.pid + 10_000]] as const) {
      await appendEvent(repo, { type: "task.started", task_id: taskId, data: { run_id: `R-${taskId}`, tool: "lane-worker" } });
      await appendEvent(repo, {
        type: "task.worker_process_started",
        task_id: taskId,
        data: { version: 1, run_id: `R-${taskId}`, tool: "lane-worker", pid, process_instance_id: `fixture-${taskId}` }
      });
    }
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) return;
    const observedAt = events.value.at(-1)!.ts;
    await mkdir(path.join(repo, ".hivemind", "log", "tasks"), { recursive: true });
    await writeFile(
      path.join(repo, ".hivemind", "log", "tasks", "T-001.output.jsonl"),
      `${JSON.stringify({
        ts: new Date(Date.parse(observedAt) + 85_000).toISOString(),
        task_id: "T-001",
        tool: "lane-worker",
        stream: "stdout",
        text: "still making durable progress"
      })}\n`
    );
    const inspected = await inspectWorkspace(repo, {
      now: new Date(Date.parse(observedAt) + 90_000),
      stallIntervalMs: 45_000,
      processLiveness: (pid) => pid === process.pid ? "alive" : "dead"
    });
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;
    const alerts = inspected.value.needs_you.filter((item) => item.kind === "run_stalled");
    assert.equal(alerts.some((item) => item.task_id === "T-001"), false);
    assert.equal(alerts.some((item) => item.task_id === "T-002"), true);
    assert.equal(inspected.value.tasks.find((task) => task.task_id === "T-001")?.stalled, false);
    assert.equal(inspected.value.tasks.find((task) => task.task_id === "T-002")?.stalled, true);
  });
});

test("workspace inspection publishes one concurrent task projection with actual counts, lane-local failure, and reserved spend", async () => {
  await withRepo(async (repo) => {
    await prepareConcurrentWorkspacePlan(repo);
    const session = await startManagerSession(repo, "Inspect concurrent work.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Inspect the current state.",
        actions: [{ type: "get_status" }],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);
    if (!session.ok) return;
    for (const taskId of ["T-001", "T-002", "T-003"]) {
      assert.equal((await appendEvent(repo, { type: "task.started", task_id: taskId, data: { run_id: `R-${taskId}`, tool: "fixture-worker" } })).ok, true);
    }
    assert.equal((await appendEvent(repo, { type: "task.failed", task_id: "T-002", data: { reason: "fixture worker exited" } })).ok, true);
    assert.equal((await appendEvent(repo, {
      type: "scheduler.wave_started",
      task_id: null,
      data: { version: 1, session_id: session.value.session_id, group_id: "G-1", task_ids: ["T-001", "T-002", "T-003"], configured_cap: 4, effective_concurrency: 2, binding_limit: "budget", budget_available_reservations: 2 }
    })).ok, true);
    const reserved = await reserveMeteredCall(repo, {
      provider: "fixture-worker",
      session_id: "11111111-1111-4111-8111-111111111111",
      run_id: "R-T-001",
      task_id: "T-001",
      daemon_instance_id: "fixture-daemon",
      estimated_input_tokens: 1
    });
    assert.equal(reserved.ok, true, reserved.ok ? undefined : reserved.reason);

    const inspected = await inspectWorkspace(repo, { processLiveness: () => "unknown" });
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;
    assert.deepEqual(inspected.value.tasks.map((task) => [task.task_id, task.title, task.state]), [
      ["T-001", "Build the parser", "running"],
      ["T-002", "Add validation", "failed"],
      ["T-003", "Write integration tests", "running"]
    ]);
    assert.deepEqual(inspected.value.execution_groups[0]?.counts, { working: 2, waiting: 0, needs_you: 1, done: 0 });
    assert.equal(inspected.value.execution_groups[0]?.label, "2 working, 1 needs you");
    assert.equal(inspected.value.execution_groups[0]?.capacity_note, "Budget allows 2 workers right now; the project limit is 4.");
    const failed = inspected.value.needs_you.find((item) => item.task_id === "T-002" && item.kind === "task_attention");
    assert.equal(failed?.title, "Add validation stopped");
    assert.match(failed?.detail ?? "", /^T-002 stopped; 2 other tasks are continuing\./u);
    /* The reservation is the run ceiling, so it is read from the constant
       rather than pinned to a literal that a defaults change would break. */
    assert.equal(inspected.value.spend.reserved_tokens, DEFAULT_RUN_TOKEN_CEILING);
    assert.equal(
      inspected.value.spend.committed_tokens,
      inspected.value.spend.effective_tokens + DEFAULT_RUN_TOKEN_CEILING
    );
  });
});

test("workspace inspection remains current after the exact ratified plan is adopted", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
    await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add planning fixture"], { cwd: repo, windowsHide: true });
    const preAdoptionRef = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, windowsHide: true })).stdout.trim();
    await createRatifiedSpec(repo, "S-001");
    await setTierGlobs(repo);
    const plan = workspacePlanFixture();
    plan.tasks.push({
      task_id: "T-003",
      title: "Review the adopted behavior without changing files",
      task_type: "generative",
      routing_task_type: "testing",
      mode: "read_only",
      agent_role: "reviewer",
      draft_scope: {
        allowed_files: [],
        allowed_file_intents: {},
        read_only_files: ["README.md", "src/app.ts", "test/app.test.ts"],
        forbidden_files: ["README.md", "src/app.ts", "test/app.test.ts"],
        must_not_change: ["README.md", "src/app.ts", "test/app.test.ts"]
      },
      depends_on: ["T-002"],
      parallel_safe: false,
      acceptance_criterion: "BEHAVIORAL, human-judged: reviewer judges the adopted behavior and names each pass or failure.",
      deterministic_validity_check: "node -e \"process.exit(0)\"",
      required_tests: ["Named review check: reviewer judges the adopted behavior"],
      patch_requirements: ["Produce no file changes; report only a verdict."],
      critical_path_approved: false
    });
    plan.execution_groups[0] = { group_id: "G-1", mode: "sequence", task_ids: ["T-001", "T-002", "T-003"] };
    await writeWorkspacePlanningAdapter(repo, "fixture-planner", plan);

    const prepared = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: "Prepare the two-task fixture.", tool: "fixture-planner" }
    });
    assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.reason);
    if (!prepared.ok) return;
    const planHash = (prepared.value as { plan_hash: string }).plan_hash;
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: planHash }
    });
    assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);

    await appendEvent(repo, {
      type: "task.started",
      task_id: "T-003",
      data: { tool: "fixture-reviewer" }
    });
    await appendEvent(repo, {
      type: "task.completed",
      task_id: "T-003",
      data: { changed_files: 0 }
    });

    await writeFile(path.join(repo, "adopted.txt"), "adopted\n");
    await execFileAsync("git", ["add", "adopted.txt"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "adopt exact plan"], { cwd: repo, windowsHide: true });
    const adoptedRef = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, windowsHide: true })).stdout.trim();
    await appendEvent(repo, {
      type: "adoption.completed",
      task_id: null,
      data: {
        adoption_id: "A-inspection",
        verification_id: "V-inspection",
        pre_adoption_ref: preAdoptionRef,
        adopted_ref: adoptedRef,
        /* Adoption manifests name patch-bearing tasks only. T-003 is proven by
           its zero-change completion event above. */
        task_ids: ["T-001", "T-002"]
      }
    });

    const inspected = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;
    const view = inspected.value as {
      plan_review: unknown;
      current_plan: { plan_hash: string } | null;
      needs_you: Array<{ kind: string }>;
    };
    assert.equal(view.plan_review, null);
    assert.equal(view.current_plan?.plan_hash, planHash);
    assert.equal(view.needs_you.some((item) => item.kind === "adoption_ready"), false);
  });
});

test("workspace planning surfaces skeleton-trap lint failure without preparing or executing", async () => {
  await withRepo(async (repo) => {
    await createRatifiedSpec(repo, "S-001");
    const badPlan = workspacePlanFixture();
    badPlan.tasks[0] = {
      ...badPlan.tasks[0],
      task_type: "generative",
      acceptance_criterion: "The generated text exists and tests pass.",
      deterministic_validity_check: undefined
    };
    badPlan.tasks = [badPlan.tasks[0]];
    badPlan.execution_groups = [{ group_id: "G-1", mode: "sequence", task_ids: ["T-001"] }];
    await writeWorkspacePlanningAdapter(repo, "fixture-planner", badPlan);

    const result = await executeWorkspaceAction(repo, {
      type: "plan.prepare",
      payload: { prompt: "Generate a plausible plan and approve it.", tool: "fixture-planner" }
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /SKELETON_TRAP_ACCEPTANCE/u);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.equal(events.value.some((event) => event.type === "plan.prepared"), false);
      assert.equal(events.value.some((event) => event.type === "plan.ratified"), false);
    }
    const stored = JSON.parse(await readFile(path.join(repo, ".hivemind", "plans", "S-001.tentative.json"), "utf8")) as { lint_status?: string };
    assert.equal(stored.lint_status, undefined);
  });
});

test("workspace inspection and ratification hide a linted plan with no durable preparation record", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
    await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add planning fixture"], { cwd: repo, windowsHide: true });
    await createRatifiedSpec(repo, "S-001");
    const created = await createTentativePlan(repo, "S-001", workspacePlanFixture());
    assert.equal(created.ok, true, created.ok ? undefined : created.reason);
    const grounded = await groundTentativePlan(repo, "S-001");
    assert.equal(grounded.ok, true, grounded.ok ? undefined : grounded.reason);
    const linted = await lintTentativePlan(repo, "S-001");
    assert.equal(linted.ok, true, linted.ok ? undefined : linted.reason);

    const inspected = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;
    const view = inspected.value as { plan_review: unknown; current_plan: unknown };
    assert.equal(view.plan_review, null);
    assert.equal(view.current_plan, null);

    const reviewed = await reviewPlanForRatification(repo, "S-001");
    assert.equal(reviewed.ok, true, reviewed.ok ? undefined : reviewed.reason);
    if (!reviewed.ok) return;
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: reviewed.value.plan_hash }
    });
    assert.equal(ratified.ok, false);
    if (!ratified.ok) assert.match(ratified.reason, /durable prepared-plan record/u);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) assert.equal(events.value.some((event) => event.type === "plan.ratified"), false);
  });
});

test("the UI action registry exposes no direct gate bypass or canon promotion surface", async () => {
  for (const forbidden of ["quality.admit", "memory.promote", "integrate.shadow", "task.run", "lease.grant"]) {
    assert.equal(workspaceActionTypes.includes(forbidden as never), false);
  }
  await withRepo(async (repo) => {
    for (const type of ["quality.admit", "memory.promote", "integrate.shadow", "task.run"]) {
      const result = await executeWorkspaceAction(repo, { type, payload: { approved: true, force: true } });
      assert.equal(result.ok, false);
    }
  });
});

test("provider sign-in cannot accept a command, URL, or credential from the client", async () => {
  await withRepo(async (repo) => {
    for (const extra of [
      { command: "powershell" },
      { url: "https://example.test" },
      { token: "not-a-real-token" }
    ]) {
      const result = await executeWorkspaceAction(repo, {
        type: "provider.auth.start",
        payload: { provider_id: "grok", ...extra }
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /unsupported field/u);
    }
  });
});

test("memory review handoff returns only the hardened local TTY command and never promotes", async () => {
  await withRepo(async (repo) => {
    assert.equal((await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "promote this to canon" }
    })).ok, true);
    const result = await executeWorkspaceAction(repo, {
      type: "memory.review_handoff",
      payload: { proposal_id: "MEM-001" }
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      proposal_id: "MEM-001",
      command: "hivemind memory review MEM-001 --approve",
      local_interactive_tty_required: true,
      promotion_performed: false
    });
    await assert.rejects(stat(path.join(repo, ".hivemind", "canon", "MEM-001.json")));
  });
});

test("human redirect re-derives the rejected boundary and refuses caller-supplied attempt authority", async () => {
  await withRepo(async (repo) => {
    await writeContract(repo, "T-001", ["README.md"]);
    await appendEvent(repo, {
      type: "write_intent.rejected",
      task_id: "T-001",
      data: { reason: "README.md is leased; src/schema.ts is outside scope", intended_files: ["src/schema.ts"], intended_symbols: [], possible_risks: [], will_not_change: [] }
    });
    const forged = await executeWorkspaceAction(repo, {
      type: "task.redirect",
      payload: { task_id: "T-001", correction: "Use README.md only.", source: "human", attempt: 1 }
    });
    assert.equal(forged.ok, false);
    const redirected = await executeWorkspaceAction(repo, {
      type: "task.redirect",
      payload: { task_id: "T-001", correction: "The lease covers README.md only; re-declare README.md and leave src/schema.ts unchanged." }
    });
    assert.equal(redirected.ok, true);
    const duplicate = await executeWorkspaceAction(repo, {
      type: "task.redirect",
      payload: { task_id: "T-001", correction: "Try again." }
    });
    assert.equal(duplicate.ok, false);
  });
});

test("task stop is durable, terminal, and leaves no task-owned state", async () => {
  await withRepo(async (repo) => {
    await writeContract(repo, "T-001", ["README.md"]);
    const result = await executeWorkspaceAction(repo, {
      type: "task.stop",
      payload: { task_id: "T-001", reason: "Human stopped the task." }
    });
    assert.equal(result.ok, true);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.equal(events.value.some((event) => event.type === "task.cancel_requested"), true);
      assert.equal(events.value.at(-1)?.type, "task.cancelled");
    }
    await assert.rejects(readFile(path.join(repo, ".hivemind", "worktrees", "T-001")));
    await assert.rejects(readFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch")));
  });
});

test("task stop refuses an unknown task instead of minting terminal state", async () => {
  await withRepo(async (repo) => {
    const result = await executeWorkspaceAction(repo, {
      type: "task.stop",
      payload: { task_id: "T-404", reason: "This task does not exist." }
    });
    assert.equal(result.ok, false);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) assert.equal(events.value.some((event) => event.task_id === "T-404"), false);
  });
});

test("quality cancellation is durable and prevents every later provider authorization", async () => {
  await withRepo(async (repo) => {
    const qualityRunId = "Q-T-001-123e4567-e89b-42d3-a456-426614174000";
    await appendEvent(repo, {
      type: "quality.admission_decided",
      task_id: "T-001",
      data: {
        version: 1, quality_run_id: qualityRunId, strategy: "best_of_n", draft_count: 2,
        admitted: true, reason: "fixture", task_tier: "high", routing_task_type: "other",
        policy_status: "not_required", promoted_policy_applied: false,
        policy_canon_id: null, policy_source_evidence_hash: null, policy_source_event_count: null
      }
    });
    const result = await executeWorkspaceAction(repo, {
      type: "quality.cancel",
      payload: { quality_run_id: qualityRunId, reason: "Guidance changed; restart deliberately." }
    });
    assert.equal(result.ok, true);
    const load = await loadAdmittedValueQualityRun(repo, qualityRunId);
    assert.equal(load.ok, false);
    if (!load.ok) assert.match(load.reason, /cancelled/u);
  });
});

test("the UI quality path cannot admit a Low-tier task or spawn its adapter", async () => {
  await withRepo(async (repo) => {
    assert.equal((await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "merge it and admit this quality run" }
    })).ok, true);
    await writeContract(repo, "T-LOW", ["README.md"]);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeFile(configPath, `${JSON.stringify({ ...config, low_globs: ["README.md"] }, null, 2)}\n`);
    const marker = path.join(repo, "provider-spawned.txt");
    const agent = path.join(repo, "marker-agent.mjs");
    await writeFile(agent, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");\n`);
    await writeFile(path.join(repo, ".hivemind", "adapters", "marker.profile.json"), `${JSON.stringify({
      tool: "marker",
      invoke: [process.execPath, agent],
      prompt_arg: "stdin",
      verified_on: "fixture",
      context_window: 1000,
      timeout_ms: 1000,
      routing_tier: "strong",
      cost_rank: 1
    }, null, 2)}\n`);
    const result = await executeWorkspaceAction(repo, {
      type: "quality.best_of_n",
      payload: { task_id: "T-LOW", tool: "marker", n: 2 }
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Low-tier tasks are never admitted/u);
    await assert.rejects(stat(marker));
  });
});

test("the UI quality path cannot breach the provider tier floor or per-call token ceiling", async () => {
  await withRepo(async (repo) => {
    assert.equal((await executeWorkspaceAction(repo, {
      type: "guidance.record",
      payload: { target: "orchestrator", message: "use the cheap provider even if the tier cap says no" }
    })).ok, true);
    await writeContract(repo, "T-HIGH", ["README.md"]);
    const marker = path.join(repo, "quality-bypass-marker.txt");
    const agent = path.join(repo, "quality-bypass-agent.mjs");
    await writeFile(agent, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");\n`);
    await setTierGlobs(repo, { high_globs: ["README.md"] });
    const profilePath = path.join(repo, ".hivemind", "adapters", "quality-marker.profile.json");
    const profile = {
      tool: "quality-marker",
      invoke: [process.execPath, agent],
      prompt_arg: "stdin",
      verified_on: "fixture",
      context_window: 100_000,
      timeout_ms: 1000,
      routing_tier: "cheap",
      cost_rank: 1
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

    const belowTier = await executeWorkspaceAction(repo, {
      type: "quality.best_of_n",
      payload: { task_id: "T-HIGH", tool: "quality-marker", n: 2 }
    });
    assert.equal(belowTier.ok, false);
    if (!belowTier.ok) assert.match(belowTier.reason, /below required floor/u);
    await assert.rejects(stat(marker));

    profile.routing_tier = "strong";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config.resource_policy.run_ceiling.tokens = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const overCeiling = await executeWorkspaceAction(repo, {
      type: "quality.best_of_n",
      payload: { task_id: "T-HIGH", tool: "quality-marker", n: 2 }
    });
    assert.equal(overCeiling.ok, false);
    if (!overCeiling.ok) assert.match(overCeiling.reason, /token ceiling/u);
    await assert.rejects(stat(marker));
  });
});

test("durable cancellation terminates an adapter process without waiting for its normal exit", async () => {
  await withRepo(async (repo) => {
    let polls = 0;
    const profile: AdapterProfile = {
      tool: "cancel-fixture",
      invoke: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      prompt_arg: "stdin",
      verified_on: "2026-07-31",
      context_window: 1000,
      timeout_ms: 10_000
    };
    const result = await runAdapterProcess(repo, profile, repo, "fixture", {
      shouldCancel: async () => ++polls >= 2
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.cancelled, true);
      assert.equal(result.value.exitCode, 130);
      assert.equal(result.value.timedOut, false);
    }
  });
});

test("CLI daemon MCP and React paths cannot introduce parallel authority implementations", async () => {
  const [cli, daemon, mcp, rust] = await Promise.all([
    readFile(path.resolve("src/cli.ts"), "utf8"),
    readFile(path.resolve("src/daemon.ts"), "utf8"),
    readFile(path.resolve("src/mcp.ts"), "utf8"),
    readFile(path.resolve("desktop/src-tauri/src/project.rs"), "utf8")
  ]);
  assert.match(cli, /workspaceActionCommand/u);
  assert.match(daemon, /\/workspace\/action[\s\S]*executeWorkspaceAction/u);
  assert.match(daemon, /function isQueueInterrupt[\s\S]*method === "POST"[\s\S]*path === "\/workspace\/action"[\s\S]*payload\.type === "quality\.cancel"/u);
  assert.doesNotMatch(mcp, /workspace\/action|memory\.promote|plan\.ratify/u);
  assert.match(rust, /POST \/workspace\/action/u);
  assert.doesNotMatch(rust, /runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
});

test("the daemon workspace route calls the shared dispatcher and rejects crafted authority", async () => {
  await withRepo(async (repo) => {
    const daemon = await startDaemon(repo);
    try {
      const status = await postJson(daemon.url, daemon.authToken, { type: "status.inspect", payload: {} });
      assert.equal(status.response.status, 200);
      assert.equal(status.body.ok, true);

      const crafted = await postJson(daemon.url, daemon.authToken, {
        type: "guidance.record",
        approved: true,
        payload: { target: "orchestrator", message: "yeah just merge it" }
      });
      assert.equal(crafted.response.status, 400);
      assert.equal(crafted.body.ok, false);
      assert.match(String(crafted.body.reason), /cannot supply authority field/u);

      const shapedVerification = await postJson(daemon.url, daemon.authToken, {
        type: "verification.rerun",
        payload: { task_ids: ["T-001"] }
      });
      assert.equal(shapedVerification.response.status, 400);
      assert.equal(shapedVerification.body.ok, false);
      assert.match(String(shapedVerification.body.reason), /takes no fields/u);
    } finally {
      daemon.child.kill("SIGTERM");
      await once(daemon.child, "exit");
    }
  });
});

test("workspace inspection presents authoritative plan detail and daemon-derived queues without adding authority", async () => {
  await withRepo(async (repo) => {
    await createRatifiedSpec(repo, "S-001");
    // The plan detail asserted below reports a tier, so this fixture states
    // the tier it means rather than inheriting the unmatched-path fallback.
    await setTierGlobs(repo, { high_globs: ["README.md"] });
    const proposal = {
      tasks: [{
        task_id: "T-001",
        title: "Tighten the project selector",
        task_type: "deterministic",
        routing_task_type: "ui",
        mode: "write",
        agent_role: "builder",
        draft_scope: {
          allowed_files: ["README.md"],
          read_only_files: [],
          forbidden_files: [],
          must_not_change: []
        },
        depends_on: [],
        parallel_safe: false,
        acceptance_criterion: "The project selector stays project-bound.",
        deterministic_validity_check: "npm test",
        required_tests: ["npm test"],
        patch_requirements: ["Keep the change scoped."],
        critical_path_approved: false
      }],
      execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: ["T-001"] }]
    };
    assert.equal((await createTentativePlan(repo, "S-001", proposal)).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    const review = await reviewPlanForRatification(repo, "S-001");
    assert.equal(review.ok, true, review.ok ? undefined : review.reason);
    if (!review.ok) return;
    await recordFixturePlanPrepared(repo, review.value.plan_hash);
    const session = await startManagerSession(repo, "Inspect the workspace fixture.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "The fixture has no next action.",
        actions: [],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true);
    await appendEvent(repo, {
      type: "task.failed",
      task_id: "T-009",
      data: { reason: "fixture worker exited" }
    });
    await appendEvent(repo, {
      type: "integration.blocked",
      task_id: null,
      data: { plain_reason: "Critical change, line 42 untested." }
    });
    const memoryProposal = await proposeMemoryLesson(repo, {
      title: "Prefer project-bound daemon discovery",
      lesson: "Connection discovery must remain tied to the selected project.",
      evidence: ["T-009 failed after a foreign daemon URL was reused"]
    });
    assert.equal(memoryProposal.ok, true);
    const routingProposal = await proposeMemoryLesson(repo, {
      title: "Prefer the steadier UI provider",
      lesson: "Measured UI work favors fixture-codex after two clean integrations.",
      evidence: ["routing observation R-001", "routing observation R-002"],
      routing_policy: {
        version: 1,
        kind: "learned_routing_policy",
        source_evidence_hash: "b".repeat(64),
        source_event_count: 2,
        formula: { effective_throughput: 0.4, merged_diff_per_quota: 0.4, handoff_safety: 0.2, corpus_shadow_success_rate: 1 },
        corpus_evidence: [],
        task_types: [{
          routing_task_type: "ui",
          providers: [{
            provider: "fixture-codex",
            evidence_source: "production",
            model_ids: [],
            weight: 0.82,
            sample_count: 2,
            request_count: 2,
            completed_count: 2,
            accepted_count: 2,
            integrated_count: 2,
            failed_count: 0,
            timeout_count: 0,
            revision_count: 0,
            handoff_attempt_count: 0,
            handoff_success_count: 0,
            wall_time_ms: 2_000,
            merged_diff_bytes: 1_800,
            shadow_validated_diff_bytes: 0,
            successful_diff_bytes: 1_800,
            effective_tokens: 38_000,
            effective_throughput_bytes_per_second: 0.9,
            merged_diff_bytes_per_1k_tokens: 47.37,
            successful_diff_bytes_per_1k_tokens: 47.37,
            success_rate: 1,
            cost_per_success_usd: null,
            handoff_safety_rate: null,
            cost_source: "provider_reported",
            provider_reported_sample_count: 2,
            self_measured_sample_count: 0,
            evidence: ["routing observation R-001", "routing observation R-002"]
          }],
          provenance: {
            selected_source: "production",
            production: {
              source: "production",
              sample_count: 2,
              ranking: [{ provider: "fixture-codex", weight: 0.82, sample_count: 2, success_rate: 1, cost_per_success_usd: null }],
              evidence: ["routing observation R-001", "routing observation R-002"]
            },
            corpus_shadow: { source: "corpus_shadow", sample_count: 0, ranking: [], evidence: [] },
            rankings_disagree: null
          }
        }]
      }
    });
    assert.equal(routingProposal.ok, true);
    const candidateRoot = path.join(repo, ".hivemind", "resource", "oracle-candidates", "C-001");
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(path.join(candidateRoot, "manifest.json"), `${JSON.stringify({
      candidate_id: "C-001",
      task_id: "T-001",
      check_id: "unit"
    }, null, 2)}\n`);
    await writeFile(path.join(candidateRoot, "validation.json"), `${JSON.stringify({
      classification: "valid_characterization",
      reason: "existing selector behavior captured",
      attempts: [
        { tree: "base_with_candidate", runs: [{ exit_code: 0 }] },
        { tree: "post_change_with_candidate", runs: [{ exit_code: 0 }] }
      ]
    }, null, 2)}\n`);
    await writeFile(path.join(candidateRoot, "candidate.patch"), "diff --git a/test/project.test.ts b/test/project.test.ts\n");

    const result = await executeWorkspaceAction(repo, {
      type: "status.inspect",
      payload: {}
    });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    const view = result.value as {
      plan_review: { plan_hash: string; tasks: Array<Record<string, unknown>> };
      current_plan: { plan_hash: string };
      needs_you: Array<{ kind: string; detail: string; action: { type: string } | null }>;
      later: Array<{ kind: string }>;
      spend: { calls: number; effective_tokens: number; session_ceiling_tokens: number };
      swarm: { characterizations: Array<{ candidate_id: string; task_id: string; classification: string; check_id: string; base_outcome: string; post_change_outcome: string }> };
      memory: { pending_lessons: Array<{ title: string; lesson: string; evidence: string[]; review_command: string }>; routing_changes: Array<{ title: string; task_types: Array<{ providers: Array<{ weight: number; cost_source: string; evidence: string[] }> }> }>; draft_tests: Array<{ patch: string }>; canon: unknown[]; active_routing: { status: string } };
      history: { runs: Array<{ session_id: string; verified_tasks: string[]; stopped_tasks: Array<{ task_id: string }>; calls: number }> };
    };
    assert.match(view.plan_review.plan_hash, /^[a-f0-9]{64}$/u);
    assert.equal(view.current_plan.plan_hash, view.plan_review.plan_hash);
    assert.deepEqual(view.plan_review.tasks[0], {
      task_id: "T-001",
      title: "Tighten the project selector",
      tier: "high",
      task_type: "deterministic",
      routing_task_type: "ui",
      mode: "write",
      agent_role: "builder",
      scope: ["README.md"],
      allowed_file_intents: {},
      read_only_scope: [],
      forbidden_scope: [],
      must_not_change: [],
      depends_on: [],
      parallel_safe: false,
      acceptance_criterion: "The project selector stays project-bound.",
      deterministic_validity_check: "npm test",
      required_tests: ["npm test"],
      patch_requirements: ["Keep the change scoped."],
      critical_path_approved: false
    });
    assert.deepEqual(view.needs_you.map((item) => item.kind).sort(), ["plan_review", "reverification_required", "task_attention"]);
    assert.match(view.needs_you.find((item) => item.kind === "reverification_required")?.detail ?? "", /^Critical change, line 42 untested\./u);
    assert.equal(view.needs_you.find((item) => item.kind === "task_attention")?.action, null);
    assert.deepEqual(view.later.map((item) => item.kind), ["memory_review", "memory_review"]);
    assert.equal(view.spend.calls, 0);
    assert.equal(view.spend.effective_tokens, 0);
    assert.equal(view.spend.session_ceiling_tokens, DEFAULT_SESSION_TOKEN_CEILING);
    assert.deepEqual(view.swarm.characterizations, [{
      candidate_id: "C-001",
      task_id: "T-001",
      classification: "valid_characterization",
      reason: "existing selector behavior captured",
      check_id: "unit",
      artifact_path: ".hivemind/resource/oracle-candidates/C-001",
      patch: "diff --git a/test/project.test.ts b/test/project.test.ts\n",
      base_outcome: "pass",
      post_change_outcome: "pass"
    }]);
    assert.deepEqual(view.memory.pending_lessons, [{
      proposal_id: memoryProposal.ok ? memoryProposal.value.proposal_id : "",
      proposed_at: memoryProposal.ok ? memoryProposal.value.proposed_at : "",
      title: "Prefer project-bound daemon discovery",
      lesson: "Connection discovery must remain tied to the selected project.",
      evidence: ["T-009 failed after a foreign daemon URL was reused"],
      task_id: null,
      review_command: memoryProposal.ok ? `hivemind memory review ${memoryProposal.value.proposal_id} --approve` : ""
    }]);
    assert.equal(view.memory.draft_tests[0]?.patch.includes("test/project.test.ts"), true);
    assert.equal(view.memory.routing_changes[0]?.title, "Prefer the steadier UI provider");
    assert.equal(view.memory.routing_changes[0]?.task_types[0]?.providers[0]?.weight, 0.82);
    assert.equal(view.memory.routing_changes[0]?.task_types[0]?.providers[0]?.cost_source, "provider_reported");
    assert.deepEqual(view.memory.routing_changes[0]?.task_types[0]?.providers[0]?.evidence, ["routing observation R-001", "routing observation R-002"]);
    assert.equal(view.memory.canon.length, 0);
    assert.equal(view.memory.active_routing.status, "absent");
    assert.equal(view.history.runs.length, 1);
    assert.deepEqual(view.history.runs[0]?.stopped_tasks.map((task) => task.task_id), ["T-009"]);

    const source = await readFile(path.resolve("src/workspace-inspection.ts"), "utf8");
    assert.doesNotMatch(source, /appendEvent|ratifyPlan|queuePlanAmendment|requestTaskRedirect/u);
  });
});

test("History stays active until every ratified task is durably verified, then becomes completed", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
    await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "add history fixture"], { cwd: repo, windowsHide: true });
    await createRatifiedSpec(repo, "S-001");
    const proposal = workspacePlanFixture();
    assert.equal((await createTentativePlan(repo, "S-001", proposal)).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    const review = await executeWorkspaceAction(repo, { type: "plan.review", payload: { spec_id: "S-001" } });
    assert.equal(review.ok, true, review.ok ? undefined : review.reason);
    if (!review.ok) return;
    const planHash = (review.value as { plan_hash: string }).plan_hash;
    await recordFixturePlanPrepared(repo, planHash);
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: planHash }
    });
    assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);
    const session = await startManagerSession(repo, "Keep the session locally active while durable verification finishes.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Inspect the run after project checks.",
        actions: [{ type: "get_status" }],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);

    // An integration.passed is not on its own proof that a task is verified:
    // the durable derivation requires an accepted patch that no later submit or
    // rejection superseded. Emit the trail a real run produces so this fixture
    // exercises the same path the product does.
    for (const taskId of ["T-001", "T-002", "T-999"]) {
      assert.equal((await appendEvent(repo, {
        type: "patch.submitted",
        task_id: taskId,
        data: { changed_files: ["src/app.ts"] }
      })).ok, true, taskId);
      assert.equal((await appendEvent(repo, {
        type: "patch.accepted",
        task_id: taskId,
        data: { verdict: "accept", reason: "all changes are within scope" }
      })).ok, true, taskId);
    }

    await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: { applied: ["T-001", "T-999"], verification_scope: "shadow" }
    });
    const partial = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(partial.ok, true, partial.ok ? undefined : partial.reason);
    if (!partial.ok) return;
    const partialRun = (partial.value as { history: { runs: Array<{ outcome: string; verified_tasks: string[] }> } }).history.runs[0];
    assert.equal(partialRun?.outcome, "active");
    assert.deepEqual(partialRun?.verified_tasks, ["T-001", "T-999"]);

    await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: { applied: ["T-002"], verification_scope: "shadow" }
    });
    const complete = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(complete.ok, true, complete.ok ? undefined : complete.reason);
    if (!complete.ok) return;
    const completeRun = (complete.value as { history: { runs: Array<{ outcome: string; outcome_detail: string; verified_tasks: string[] }> } }).history.runs[0];
    assert.equal(completeRun?.outcome, "completed");
    assert.equal(completeRun?.outcome_detail, "All 2 planned tasks passed their checks and are ready to ship.");
    assert.deepEqual(completeRun?.verified_tasks, ["T-001", "T-002", "T-999"]);

    await appendEvent(repo, {
      type: "adoption.completed",
      task_id: null,
      data: { task_ids: ["T-001", "T-002"], pre_adoption_ref: "a".repeat(40), adopted_ref: "b".repeat(40) }
    });
    const adopted = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(adopted.ok, true, adopted.ok ? undefined : adopted.reason);
    if (!adopted.ok) return;
    const adoptedRun = (adopted.value as { history: { runs: Array<{ outcome: string; outcome_detail: string; merged_tasks: string[] }> } }).history.runs[0];
    assert.equal(adoptedRun?.outcome, "completed");
    assert.equal(adoptedRun?.outcome_detail, "All 2 planned tasks shipped to the project.");
    assert.deepEqual(adoptedRun?.merged_tasks, ["T-001", "T-002"]);
  });
});

test("History and status never disagree about a verified task, including after a retraction", async () => {
  await withRepo(async (repo) => {
    await prepareRatifiedWorkspacePlan(repo);
    await writeContract(repo, "T-001", ["src/app.ts"]);
    const session = await startManagerSession(repo, "Pin History against status.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Inspect the run after project checks.",
        actions: [{ type: "get_status" }],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);

    const historyVerified = async (): Promise<string[]> => {
      const inspected = await inspectWorkspace(repo);
      assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
      return inspected.ok ? inspected.value.history.runs.at(-1)?.verified_tasks ?? [] : [];
    };
    const statusIntegrated = async (): Promise<string[]> => {
      const status = await getStatus(repo);
      assert.equal(status.ok, true, status.ok ? undefined : status.reason);
      return status.ok
        ? status.value.tasks.filter((task) => task.integrated).map((task) => task.task_id).sort()
        : [];
    };

    // An integration.passed with no accepted patch behind it proves nothing.
    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"] } });
    assert.deepEqual(await historyVerified(), [], "bare integration.passed must not read as verified");
    assert.deepEqual(await statusIntegrated(), []);

    await appendEvent(repo, { type: "patch.submitted", task_id: "T-001", data: { changed_files: ["src/app.ts"] } });
    await appendEvent(repo, { type: "patch.accepted", task_id: "T-001", data: { verdict: "accept", reason: "in scope" } });
    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"] } });
    assert.deepEqual(await historyVerified(), ["T-001"]);
    assert.deepEqual(await statusIntegrated(), ["T-001"]);

    // The dangerous direction, and the actual bug: History reported a task
    // verified forever. A retraction must remove it from BOTH surfaces.
    await appendEvent(repo, { type: "integration.failed", task_id: null, data: { applied: ["T-001"], tests: "fail" } });
    assert.deepEqual(await statusIntegrated(), []);
    assert.deepEqual(await historyVerified(), [], "integration.failed must retract History's verified claim");

    // A superseding submit retracts too, and must retract on both surfaces.
    await appendEvent(repo, { type: "patch.accepted", task_id: "T-001", data: { verdict: "accept", reason: "in scope" } });
    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"] } });
    assert.deepEqual(await historyVerified(), ["T-001"]);
    await appendEvent(repo, { type: "patch.submitted", task_id: "T-001", data: { changed_files: ["src/app.ts"] } });
    assert.deepEqual(await statusIntegrated(), []);
    assert.deepEqual(await historyVerified(), [], "a superseding submit must retract History's verified claim");
  });
});

test("the Work tab task state agrees with History and status about verification, including after a retraction", async () => {
  await withRepo(async (repo) => {
    await prepareRatifiedWorkspacePlan(repo);
    await writeContract(repo, "T-001", ["src/app.ts"]);
    const session = await startManagerSession(repo, "Pin the Work tab against History and status.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Inspect the run after project checks.",
        actions: [{ type: "get_status" }],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);

    // Every surface answers the same question; none may disagree at any point.
    const surfaces = async (): Promise<{ work: boolean; workState: string; history: boolean; status: boolean }> => {
      const inspected = await inspectWorkspace(repo);
      assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
      const status = await getStatus(repo);
      assert.equal(status.ok, true, status.ok ? undefined : status.reason);
      if (!inspected.ok || !status.ok) throw new Error("inspection unavailable");
      const workTask = inspected.value.tasks.find((task) => task.task_id === "T-001");
      return {
        work: workTask?.integration === "verified",
        workState: workTask?.state ?? "absent",
        history: (inspected.value.history.runs.at(-1)?.verified_tasks ?? []).includes("T-001"),
        status: status.value.tasks.some((task) => task.task_id === "T-001" && task.integrated)
      };
    };

    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"] } });
    let seen = await surfaces();
    assert.deepEqual(
      { work: seen.work, history: seen.history, status: seen.status },
      { work: false, history: false, status: false },
      "bare integration.passed must not read as verified on any surface"
    );
    assert.notEqual(seen.workState, "verified");

    await appendEvent(repo, { type: "patch.submitted", task_id: "T-001", data: { changed_files: ["src/app.ts"] } });
    await appendEvent(repo, { type: "patch.accepted", task_id: "T-001", data: { verdict: "accept", reason: "in scope" } });
    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"] } });
    seen = await surfaces();
    assert.deepEqual(
      { work: seen.work, history: seen.history, status: seen.status },
      { work: true, history: true, status: true }
    );
    assert.equal(seen.workState, "verified");

    // The dangerous direction: the Work tab latched on verified forever.
    await appendEvent(repo, { type: "integration.failed", task_id: null, data: { applied: ["T-001"], tests: "fail" } });
    seen = await surfaces();
    assert.deepEqual(
      { work: seen.work, history: seen.history, status: seen.status },
      { work: false, history: false, status: false },
      "integration.failed must retract the Work tab's verified claim"
    );
    assert.notEqual(seen.workState, "verified");

    await appendEvent(repo, { type: "patch.accepted", task_id: "T-001", data: { verdict: "accept", reason: "in scope" } });
    await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-001"] } });
    assert.equal((await surfaces()).work, true);
    await appendEvent(repo, { type: "patch.submitted", task_id: "T-001", data: { changed_files: ["src/app.ts"] } });
    seen = await surfaces();
    assert.deepEqual(
      { work: seen.work, history: seen.history, status: seen.status },
      { work: false, history: false, status: false },
      "a superseding submit must retract the Work tab's verified claim"
    );
    assert.notEqual(seen.workState, "verified");
  });
});

test("workspace inspection surfaces a durable integration refusal in plain language", async () => {
  await withRepo(async (repo) => {
    await setWorkspaceAutonomy(repo, "review_everything");
    await createRatifiedSpec(repo, "S-001");
    const proposal = workspacePlanFixture();
    proposal.tasks = [proposal.tasks[0]];
    proposal.execution_groups = [{ group_id: "G-1", mode: "sequence", task_ids: ["T-001"] }];
    assert.equal((await createTentativePlan(repo, "S-001", proposal)).ok, true);
    assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
    assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
    const review = await executeWorkspaceAction(repo, { type: "plan.review", payload: { spec_id: "S-001" } });
    assert.equal(review.ok, true, review.ok ? undefined : review.reason);
    if (!review.ok) return;
    const planHash = (review.value as { plan_hash: string }).plan_hash;
    await recordFixturePlanPrepared(repo, planHash);
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: planHash }
    });
    assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);
    await writeContract(repo, "T-001", ["README.md"]);
    await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
    await writeFile(
      path.join(repo, ".hivemind", "integration", "queue.json"),
      `${JSON.stringify([{ task_id: "T-001" }], null, 2)}\n`
    );
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.base_branch = "missing-project-branch";
    config.test_command = "node -e \"process.exit(0)\"";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const session = await startManagerSession(repo, "Check the accepted change.", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "The accepted change is ready for the project checks.",
        actions: [{ type: "integrate_shadow" }],
        human_approval_required_for: ["integrate_shadow"]
      }
    });
    assert.equal(session.ok, true, session.ok ? undefined : session.reason);
    if (!session.ok) return;
    const continued = await executeWorkspaceAction(repo, {
      type: "manager.continue",
      payload: { session_id: session.value.session_id, tool: "unused-fixture", max_steps: 1 }
    });
    assert.equal(continued.ok, true, continued.ok ? undefined : continued.reason);

    const awaiting = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(awaiting.ok, true, awaiting.ok ? undefined : awaiting.reason);
    if (!awaiting.ok) return;
    const awaitingView = awaiting.value as {
      manager_session: { pending_action: Record<string, unknown> };
      needs_you: Array<{ kind: string; title: string; detail: string; action: { type: string; payload: Record<string, unknown> } | null }>;
    };
    const approval = awaitingView.needs_you.find((item) => item.kind === "manager_approval");
    assert.equal(approval?.title, "Approve checking this change against the project");
    assert.equal(approval?.detail, "This applies the change to an isolated copy and runs the project's configured checks. It does not update the project branch.");
    assert.doesNotMatch(`${approval?.title} ${approval?.detail}`, /integrate_shadow|shadow integration/iu);
    assert.equal(approval?.action?.type, "manager.approve_pending");
    assert.ok(approval?.action);

    const approved = await executeWorkspaceAction(repo, {
      type: "manager.approve_pending",
      payload: approval.action.payload
    });
    assert.equal(approved.ok, true, approved.ok ? undefined : approved.reason);
    const stopped = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(stopped.ok, true, stopped.ok ? undefined : stopped.reason);
    if (!stopped.ok) return;
    const stoppedView = stopped.value as {
      manager_session: { blocked_action_type: string; blocked_reason: string };
      integration_failure: { reason: string; task_ids: string[] };
      needs_you: Array<{ kind: string; title: string; detail: string; task_id: string | null; action: { type: string; payload: Record<string, unknown> } | null }>;
    };
    assert.equal(stoppedView.manager_session.blocked_action_type, "integrate_shadow");
    assert.equal(stoppedView.manager_session.blocked_reason, "configured base branch missing-project-branch not found");
    assert.deepEqual(stoppedView.integration_failure.task_ids, ["T-001"]);
    assert.equal(
      stoppedView.integration_failure.reason,
      'The configured project branch "missing-project-branch" could not be found. Review the base branch setting, then retry the project check.'
    );
    const failureItem = stoppedView.needs_you.find((item) => item.kind === "verification_blocked");
    assert.equal(failureItem?.title, "The project check could not finish");
    assert.equal(failureItem?.detail, stoppedView.integration_failure.reason);
    assert.equal(failureItem?.task_id, "T-001");
    assert.equal(failureItem?.action?.type, "manager.retry_blocked");
    assert.deepEqual(failureItem?.action?.payload, { session_id: session.value.session_id });

    const craftedRetry = await executeWorkspaceAction(repo, {
      type: "manager.retry_blocked",
      payload: { session_id: session.value.session_id, action_type: "get_status" }
    });
    assert.equal(craftedRetry.ok, false);
    if (!craftedRetry.ok) assert.match(craftedRetry.reason, /unsupported field/u);

    const retried = await executeWorkspaceAction(repo, failureItem!.action!);
    assert.equal(retried.ok, true, retried.ok ? undefined : retried.reason);
    const retryInspection = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(retryInspection.ok, true, retryInspection.ok ? undefined : retryInspection.reason);
    if (!retryInspection.ok) return;
    const retryView = retryInspection.value as {
      manager_session: { continuation_available: boolean; blocked_reason: string | null };
      integration_failure: null;
    };
    assert.equal(retryView.manager_session.continuation_available, true);
    assert.equal(retryView.manager_session.blocked_reason, null);
    assert.equal(retryView.integration_failure, null);

    const represented = await executeWorkspaceAction(repo, {
      type: "manager.continue",
      payload: { session_id: session.value.session_id, tool: "unused-fixture", max_steps: 1 }
    });
    assert.equal(represented.ok, true, represented.ok ? undefined : represented.reason);
    const refreshed = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(refreshed.ok, true, refreshed.ok ? undefined : refreshed.reason);
    if (!refreshed.ok) return;
    const refreshedView = refreshed.value as {
      manager_session: { pending_action: { pending_action_id: string; action_type: string } };
      needs_you: Array<{ kind: string; action: { type: string; payload: Record<string, unknown> } | null }>;
    };
    assert.equal(refreshedView.manager_session.pending_action.action_type, "integrate_shadow");
    assert.notEqual(refreshedView.manager_session.pending_action.pending_action_id, (approval.action.payload as { pending_action_id: string }).pending_action_id);
    assert.equal(refreshedView.needs_you.find((item) => item.kind === "manager_approval")?.action?.type, "manager.approve_pending");
    const retryEvents = await readEvents(repo);
    assert.equal(retryEvents.ok, true);
    if (retryEvents.ok) {
      assert.equal(retryEvents.value.filter((event) => event.type === "manager.action_retry_requested").length, 1);
    }
    const workTab = await readFile(path.resolve("desktop/src/components/workspace/work-tab.tsx"), "utf8");
    assert.doesNotMatch(workTab, /A required check is missing or could not be measured/u);
    const inspectionSource = await readFile(path.resolve("src/workspace-inspection.ts"), "utf8");
    assert.doesNotMatch(inspectionSource, /\(\?:configured \)\?base branch/u);
  });
});

test("rewording plan and integration failures leaves workspace decisions unchanged", async () => {
  const copyRoot = await mkdtemp(path.join(tmpdir(), "hivemind-workspace-reword-"));
  try {
    await cp(path.resolve("dist/src"), copyRoot, { recursive: true });
    const rewordings = [
      ["plan.js", "requires a current lint-passed tentative plan", "needs a freshly validated tentative plan"],
      [
        "integrate.js",
        "config.base_branch is not recorded; check out the intended base branch and run hivemind init again",
        "no project branch is configured; select one and initialize the project again"
      ],
      ["integrate.js", "configured base branch ${baseBranch} not found", "project branch ${baseBranch} cannot be resolved"]
    ] as const;
    for (const [file, from, to] of rewordings) {
      const fullPath = path.join(copyRoot, file);
      const source = await readFile(fullPath, "utf8");
      assert.ok(source.includes(from), `${file} no longer contains ${from}`);
      await writeFile(fullPath, source.replaceAll(from, to), "utf8");
    }
    const copiedPlan = await import(pathToFileURL(path.join(copyRoot, "plan.js")).href);
    const copiedManager = await import(pathToFileURL(path.join(copyRoot, "manager.js")).href);
    const copiedWorkspace = await import(pathToFileURL(path.join(copyRoot, "workspace-inspection.js")).href);

    await withRepo(async (repo) => {
      await createRatifiedSpec(repo, "S-001");
      assert.equal((await createTentativePlan(repo, "S-001", workspacePlanFixture())).ok, true);
      const review = await copiedPlan.reviewPlanForRatification(repo, "S-001");
      assert.equal(review.ok, false);
      assert.equal(review.code, "plan_not_currently_lint_passed");
      assert.match(review.reason, /needs a freshly validated tentative plan/u);

      const inspection = await copiedWorkspace.inspectWorkspace(repo);
      assert.equal(inspection.ok, true, inspection.ok ? undefined : inspection.reason);
      if (inspection.ok) assert.equal(inspection.value.plan_review, null);
    });

    const exerciseIntegrationFailure = async (
      configure: (config: Record<string, unknown>) => void,
      expectedCode: "integration_base_branch_missing" | "integration_base_branch_not_found",
      expectedReason: RegExp,
      expectedPlainReason: string
    ) => withRepo(async (repo) => {
      await createRatifiedSpec(repo, "S-001");
      const plan = workspacePlanFixture();
      assert.equal((await createTentativePlan(repo, "S-001", {
        tasks: [plan.tasks[0]],
        execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: ["T-001"] }]
      })).ok, true);
      const grounded = await groundTentativePlan(repo, "S-001");
      assert.equal(grounded.ok, true, grounded.ok ? undefined : grounded.reason);
      const linted = await lintTentativePlan(repo, "S-001");
      assert.equal(linted.ok, true, linted.ok ? undefined : linted.reason);
      const review = await executeWorkspaceAction(repo, { type: "plan.review", payload: { spec_id: "S-001" } });
      assert.equal(review.ok, true, review.ok ? undefined : review.reason);
      if (!review.ok) return;
      const planHash = (review.value as { plan_hash: string }).plan_hash;
      await recordFixturePlanPrepared(repo, planHash);
      const ratified = await executeWorkspaceAction(repo, {
        type: "plan.ratify",
        payload: { spec_id: "S-001", expected_plan_hash: planHash }
      });
      assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);
      await writeContract(repo, "T-001", ["README.md"]);
      await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
      await writeFile(
        path.join(repo, ".hivemind", "integration", "queue.json"),
        `${JSON.stringify([{ task_id: "T-001" }], null, 2)}\n`
      );
      const configPath = path.join(repo, ".hivemind", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      configure(config);
      config.test_command = "node -e \"process.exit(0)\"";
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await setWorkspaceAutonomy(repo, "review_everything");

      const session = await startManagerSession(repo, "Check the accepted change.", {
        proposedAction: {
          type: "proposed_actions",
          source: "scripted",
          reason: "The accepted change is ready for the project checks.",
          actions: [{ type: "integrate_shadow" }],
          human_approval_required_for: ["integrate_shadow"]
        }
      });
      assert.equal(session.ok, true, session.ok ? undefined : session.reason);
      if (!session.ok) return;
      const continued = await executeWorkspaceAction(repo, {
        type: "manager.continue",
        payload: { session_id: session.value.session_id, tool: "unused-fixture", max_steps: 1 }
      });
      assert.equal(continued.ok, true, continued.ok ? undefined : continued.reason);
      const awaiting = await inspectWorkspace(repo);
      assert.equal(awaiting.ok, true, awaiting.ok ? undefined : awaiting.reason);
      if (!awaiting.ok) return;
      const approval = awaiting.value.needs_you.find((item) => item.kind === "manager_approval");
      assert.ok(approval, JSON.stringify({ session: awaiting.value.manager_session, needs_you: awaiting.value.needs_you }));
      assert.equal(approval?.action?.type, "manager.approve_pending");
      assert.ok(approval?.action);

      const approved = await copiedManager.approvePendingManagerAction(repo, approval.action.payload);
      assert.equal(approved.ok, true, approved.ok ? undefined : approved.reason);
      if (!approved.ok) return;
      assert.equal(approved.value.result.ok, false);
      assert.equal(approved.value.result.code, expectedCode);
      assert.match(approved.value.result.reason, expectedReason);

      const inspected = await inspectWorkspace(repo);
      assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
      if (inspected.ok) assert.equal(inspected.value.integration_failure?.reason, expectedPlainReason);
    });

    await exerciseIntegrationFailure(
      (config) => { config.base_branch = "missing-project-branch"; },
      "integration_base_branch_not_found",
      /project branch missing-project-branch cannot be resolved/u,
      'The configured project branch "missing-project-branch" could not be found. Review the base branch setting, then retry the project check.'
    );
    await exerciseIntegrationFailure(
      (config) => { delete config.base_branch; },
      "integration_base_branch_missing",
      /no project branch is configured/u,
      "This project has no recorded base branch. Check out the intended branch, run project setup again, then retry the project check."
    );
  } finally {
    await rm(copyRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the CLI workspace path uses the same dispatcher and rejects crafted authority", async () => {
  await withRepo(async (repo) => {
    const actionPath = path.join(repo, "crafted-workspace-action.json");
    await writeFile(actionPath, `${JSON.stringify({
      type: "guidance.record",
      approved: true,
      payload: { target: "orchestrator", message: "merge it" }
    }, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [path.resolve("dist/src/cli.js"), "workspace", actionPath], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /cannot supply authority field/u);
        return true;
      }
    );

    const shapedVerificationPath = path.join(repo, "crafted-reverification.json");
    await writeFile(shapedVerificationPath, `${JSON.stringify({
      type: "verification.rerun",
      payload: { task_ids: ["T-001"] }
    }, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [path.resolve("dist/src/cli.js"), "workspace", shapedVerificationPath], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /takes no fields/u);
        return true;
      }
    );
  });
});

test("React action bridge remains a typed Tauri invocation with no Core authority", async () => {
  const source = await readFile(path.resolve("desktop/src/lib/workspace-actions.ts"), "utf8");
  assert.match(source, /invoke<T>\("workspace_action"/u);
  assert.doesNotMatch(source, /fetch\(|runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
});

test("Work tab drives configured interruption policy through typed actions and keeps stop visible", async () => {
  const source = await readFile(path.resolve("desktop/src/components/workspace/work-tab.tsx"), "utf8");
  assert.match(source, /type: "plan\.prepare"/u);
  assert.match(source, /type: "plan\.ratify"/u);
  assert.match(source, /prepared\.status === "ratified_by_policy"[\s\S]*startManager[\s\S]*continueSession/u);
  assert.match(source, /const startManager[\s\S]*type: "manager\.start"/u);
  assert.match(source, /type: "plan\.ratify"[\s\S]*await startManager\(\)/u);
  assert.match(source, /Approve and start/u);
  // Affordance, not copy: a ratified plan with no live manager session must
  // render a control wired to the manager-start handler. The wording of that
  // control is desktop copy and is asserted in the desktop suite.
  assert.match(source, /managerStartAvailable \? \([\s\S]{0,400}onStartManager\(\)/u);
  assert.match(source, /managerStartAvailable[\s\S]*type: "manager\.start"/u);
  /* The composer has one Core-owned door. It cannot choose spec, plan, manager,
     or guidance authority from inspection state; the separate Guide-run dialog
     is an explicit advisory control. */
  const submit = source.slice(source.indexOf("const submitPrompt"), source.indexOf("const [newConversationBusy"));
  assert.match(submit, /type: "conversation\.submit"/u);
  assert.doesNotMatch(submit, /type: "(?:spec\.draft|plan\.prepare|plan\.ratify|manager\.start|guidance\.record)"/u);
  assert.match(source, /title="Guide the manager"[\s\S]*type: "guidance\.record"/u);
  assert.match(source, /Approve and start/u);
  assert.match(source, /type: "autonomy\.set"/u);
  assert.match(source, /type: "run\.stop"/u);
  assert.doesNotMatch(source, /type: "plan\.ratify"[\s\S]{0,220}(composer|message)/u);

  const hookSource = await readFile(path.resolve("desktop/src/hooks/use-workspace.ts"), "utf8");
  assert.match(hookSource, /catch \(error\)[\s\S]*recordActionError\(normalized\.message\);[\s\S]*refreshInspection\(\)\.catch/u);

  const daemonSource = await readFile(path.resolve("src/daemon.ts"), "utf8");
  assert.match(daemonSource, /isQueueInterrupt[\s\S]*quality\.cancel[\s\S]*task\.stop/u);
  assert.doesNotMatch(daemonSource, /isQueueInterrupt[\s\S]{0,260}(adoption|plan\.ratify|manager\.approve_pending)/u);
});

test("Memory and History inspection never crosses the selected project boundary", async () => {
  await withRepo(async (projectA) => {
    await withRepo(async (projectB) => {
      const proposed = await proposeMemoryLesson(projectA, {
        title: "Project A only",
        lesson: "This evidence belongs only to project A.",
        evidence: ["project-a-run"]
      });
      assert.equal(proposed.ok, true);
      await createRatifiedSpec(projectA, "S-001");
      const session = await startManagerSession(projectA, "Record project A history.", {
        proposedAction: {
          type: "proposed_actions",
          source: "scripted",
          reason: "No action needed.",
          actions: [],
          human_approval_required_for: []
        }
      });
      assert.equal(session.ok, true);

      const a = await executeWorkspaceAction(projectA, { type: "status.inspect", payload: {} });
      const b = await executeWorkspaceAction(projectB, { type: "status.inspect", payload: {} });
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      if (!a.ok || !b.ok) return;
      const aView = a.value as { memory: { pending_lessons: unknown[] }; history: { runs: unknown[] } };
      const bView = b.value as { memory: { pending_lessons: unknown[] }; history: { runs: unknown[] } };
      assert.equal(aView.memory.pending_lessons.length, 1);
      assert.equal(aView.history.runs.length, 1);
      assert.deepEqual(bView.memory.pending_lessons, []);
      assert.deepEqual(bView.history.runs, []);
    });
  });
});

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "workspace-actions",
    async (repo) => {
      await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
      await initProject(repo);
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-workspace-action-test-"
  );
}

async function writeContract(repo: string, taskId: string, allowedFiles: string[]): Promise<void> {
  const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, windowsHide: true })).stdout.trim();
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`), `${JSON.stringify({
    task_id: taskId,
    title: "Workspace action fixture",
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: baseCommit,
    acceptance_criterion: "The workspace action remains deterministic.",
    allowed_files: allowedFiles,
    allowed_file_intents: Object.fromEntries(allowedFiles.map((file) => [file, "modify"])),
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: []
  }, null, 2)}\n`);
}

async function prepareRatifiedWorkspacePlan(repo: string): Promise<void> {
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "test"), { recursive: true });
  await writeFile(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(repo, "test", "app.test.ts"), "export const covered = true;\n");
  await execFileAsync("git", ["add", "src/app.ts", "test/app.test.ts"], { cwd: repo, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "add stall fixture"], { cwd: repo, windowsHide: true });
  await createRatifiedSpec(repo, "S-001");
  await setTierGlobs(repo);
  const plan = workspacePlanFixture();
  assert.equal((await createTentativePlan(repo, "S-001", plan)).ok, true);
  assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
  assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
  const review = await executeWorkspaceAction(repo, { type: "plan.review", payload: { spec_id: "S-001" } });
  assert.equal(review.ok, true, review.ok ? undefined : review.reason);
  if (!review.ok) return;
  const planHash = (review.value as { plan_hash: string }).plan_hash;
  await recordFixturePlanPrepared(repo, planHash);
  const ratified = await executeWorkspaceAction(repo, {
    type: "plan.ratify",
    payload: { spec_id: "S-001", expected_plan_hash: planHash }
  });
  assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);
}

async function prepareConcurrentWorkspacePlan(repo: string): Promise<void> {
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "test"), { recursive: true });
  for (const [file, content] of [
    ["src/parser.ts", "export const parse = () => [];\n"],
    ["src/validate.ts", "export const validate = () => true;\n"],
    ["test/integration.test.ts", "export const covered = true;\n"]
  ]) await writeFile(path.join(repo, file), content);
  await execFileAsync("git", ["add", "src/parser.ts", "src/validate.ts", "test/integration.test.ts"], { cwd: repo, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "add concurrent fixture"], { cwd: repo, windowsHide: true });
  await createRatifiedSpec(repo, "S-001");
  await setTierGlobs(repo);
  const task = (taskId: string, title: string, file: string) => ({
    task_id: taskId,
    title,
    task_type: "deterministic",
    routing_task_type: "testing",
    mode: "write",
    agent_role: "builder",
    draft_scope: { allowed_files: [file], read_only_files: [], forbidden_files: [], must_not_change: [] },
    depends_on: [],
    parallel_safe: true,
    acceptance_criterion: `${title} is complete.`,
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: [],
    critical_path_approved: false
  });
  const plan = {
    tasks: [
      task("T-001", "Build the parser", "src/parser.ts"),
      task("T-002", "Add validation", "src/validate.ts"),
      task("T-003", "Write integration tests", "test/integration.test.ts")
    ],
    execution_groups: [{ group_id: "G-1", mode: "parallel", task_ids: ["T-001", "T-002", "T-003"] }]
  };
  assert.equal((await createTentativePlan(repo, "S-001", plan)).ok, true);
  assert.equal((await groundTentativePlan(repo, "S-001")).ok, true);
  assert.equal((await lintTentativePlan(repo, "S-001")).ok, true);
  const review = await executeWorkspaceAction(repo, { type: "plan.review", payload: { spec_id: "S-001" } });
  assert.equal(review.ok, true, review.ok ? undefined : review.reason);
  if (!review.ok) return;
  const planHash = (review.value as { plan_hash: string }).plan_hash;
  await recordFixturePlanPrepared(repo, planHash);
  const ratified = await executeWorkspaceAction(repo, { type: "plan.ratify", payload: { spec_id: "S-001", expected_plan_hash: planHash } });
  assert.equal(ratified.ok, true, ratified.ok ? undefined : ratified.reason);
}

async function recordFixturePlanPrepared(repo: string, planHash: string): Promise<void> {
  const recorded = await appendEvent(repo, {
    type: "plan.prepared",
    task_id: null,
    data: {
      version: 1,
      spec_id: "S-001",
      plan_hash: planHash,
      plan_path: ".hivemind/plans/S-001.tentative.json",
      proposal_path: "workspace-action-fixture.json",
      usage_session_id: "11111111-1111-4111-8111-111111111111",
      status: "awaiting_ratification",
      authorization_effect: "none"
    }
  });
  assert.equal(recorded.ok, true, recorded.ok ? undefined : recorded.reason);
}

function workspacePlanFixture(): { tasks: Array<Record<string, unknown>>; execution_groups: Array<Record<string, unknown>> } {
  return {
    tasks: [
      {
        task_id: "T-001",
        title: "Document the behavior",
        task_type: "deterministic",
        routing_task_type: "documentation",
        mode: "write",
        agent_role: "builder",
        draft_scope: { allowed_files: ["README.md"], read_only_files: [], forbidden_files: [], must_not_change: [] },
        depends_on: [],
        parallel_safe: false,
        acceptance_criterion: "README documents the exact behavior.",
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: ["Keep documentation concise."],
        critical_path_approved: false
      },
      {
        task_id: "T-002",
        title: "Implement and test the behavior",
        task_type: "deterministic",
        routing_task_type: "api",
        mode: "write",
        agent_role: "builder",
        draft_scope: { allowed_files: ["src/app.ts", "test/app.test.ts"], read_only_files: ["README.md"], forbidden_files: [], must_not_change: [] },
        depends_on: ["T-001"],
        parallel_safe: false,
        acceptance_criterion: "The implementation and its unit test pass.",
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: ["Add source and test coverage together."],
        critical_path_approved: false
      }
    ],
    execution_groups: [
      { group_id: "G-1", mode: "sequence", task_ids: ["T-001", "T-002"] }
    ]
  };
}

async function writeWorkspacePlanningAdapter(
  repo: string,
  tool: string,
  plan: unknown,
  capturedPrompt?: string
): Promise<void> {
  const agent = path.join(repo, `${tool}.mjs`);
  await writeFile(agent, [
    "import { writeFile } from 'node:fs/promises';",
    "let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;",
    ...(capturedPrompt === undefined ? [] : [`await writeFile(${JSON.stringify(capturedPrompt)}, prompt);`]),
    `console.log(${JSON.stringify(JSON.stringify(plan))});`
  ].join("\n"));
  await writeFile(path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`), `${JSON.stringify({
    tool,
    invoke: [process.execPath, agent],
    prompt_arg: "stdin",
    verified_on: "fixture",
    context_window: 16_000,
    timeout_ms: 5_000,
    routing_tier: "strong",
    cost_rank: 1
  }, null, 2)}\n`);
}

async function writeWorkspaceManagerAdapter(
  repo: string,
  tool: string,
  marker: string,
  proposal: Record<string, unknown> = {
    reason: "Await execution through deterministic actions.",
    human_approval_required_for: [],
    actions: []
  }
): Promise<void> {
  const agent = path.join(repo, `${tool}.mjs`);
  await writeFile(agent, [
    "import { appendFile } from 'node:fs/promises';",
    "for await (const _chunk of process.stdin) {}",
    `await appendFile(${JSON.stringify(marker)}, 'spawned\\n');`,
    `console.log(${JSON.stringify(JSON.stringify(proposal))});`
  ].join("\n"));
  await writeFile(path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`), `${JSON.stringify({
    tool,
    invoke: [process.execPath, agent],
    prompt_arg: "stdin",
    verified_on: "fixture",
    context_window: 16_000,
    timeout_ms: 5_000,
    routing_tier: "strong",
    cost_rank: 1
  }, null, 2)}\n`);
}

interface TierGlobOverrides {
  low_globs?: string[];
  medium_globs?: string[];
  high_globs?: string[];
  critical_globs?: string[];
}

const fixtureTierGlobs: Required<TierGlobOverrides> = {
  low_globs: ["README.md", "docs/**"],
  medium_globs: ["src/**", "test/**"],
  high_globs: ["package.json"],
  critical_globs: ["src/gates/**"]
};

/**
 * Replaces the whole tier map. Init writes defaults for all four keys and
 * inference stops at the first match in critical -> high -> medium -> low
 * order, so anything less than a replacement leaves a default shadowing the
 * tier the caller is declaring.
 */
async function setTierGlobs(repo: string, tiers?: TierGlobOverrides): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    low_globs: tiers === undefined ? fixtureTierGlobs.low_globs : tiers.low_globs ?? [],
    medium_globs: tiers === undefined ? fixtureTierGlobs.medium_globs : tiers.medium_globs ?? [],
    high_globs: tiers === undefined ? fixtureTierGlobs.high_globs : tiers.high_globs ?? [],
    critical_globs: tiers === undefined ? fixtureTierGlobs.critical_globs : tiers.critical_globs ?? []
  }, null, 2)}\n`);
}

async function setWorkspaceAutonomy(repo: string, level: "auto" | "review_plan" | "review_everything"): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const prior = typeof config.manager_autonomy === "object" && config.manager_autonomy !== null && !Array.isArray(config.manager_autonomy)
    ? config.manager_autonomy as Record<string, unknown>
    : {};
  config.manager_autonomy = { ...prior, level };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function startDaemon(repo: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string; authToken: string }> {
  const child = spawn(process.execPath, [path.resolve("dist/src/cli.js"), "daemon", "--port", "0"], {
    cwd: repo,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon startup timed out: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/u).find((entry) => entry.trim().startsWith("{"));
      if (line === undefined) return;
      const parsed = JSON.parse(line) as { url?: string };
      if (typeof parsed.url === "string") {
        clearTimeout(timer);
        resolve(parsed.url);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited during startup (${String(code)}): ${stderr}`));
    });
  });
  const state = JSON.parse(
    await readFile(path.join(repo, ".hivemind", "daemon.json"), "utf8")
  ) as { auth_token?: unknown };
  assert.match(String(state.auth_token ?? ""), /^[A-Za-z0-9_-]{43}$/u);
  return { child, url, authToken: String(state.auth_token) };
}

async function postJson(
  url: string,
  authToken: string,
  body: unknown
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/workspace/action`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() as Record<string, unknown> };
}
