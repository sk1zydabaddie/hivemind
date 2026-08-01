import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { createTentativePlan, groundTentativePlan, lintTentativePlan } from "../src/plan.js";
import { readQuotaLedger } from "../src/resource-ledger.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

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
    const failedStart = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Execute the exact ratified plan.", tool: "fixture-manager" }
    });
    assert.equal(failedStart.ok, false);
    if (!failedStart.ok) assert.match(failedStart.reason, /at most one next action/u);
    const afterFailedStart = await executeWorkspaceAction(repo, { type: "status.inspect", payload: {} });
    assert.equal(afterFailedStart.ok, true, afterFailedStart.ok ? undefined : afterFailedStart.reason);
    if (afterFailedStart.ok) {
      const failedView = afterFailedStart.value as {
        manager_session: unknown;
        current_plan: { plan_hash: string };
        spend: { calls: number; effective_tokens: number };
      };
      assert.equal(failedView.manager_session, null);
      assert.equal(failedView.current_plan.plan_hash, result.plan_hash);
      assert.equal(failedView.spend.calls, 2);
      assert.equal(failedView.spend.effective_tokens > 0, true);
    }

    await writeWorkspaceManagerAdapter(repo, "fixture-manager", managerMarker);
    const started = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Execute the exact ratified plan.", tool: "fixture-manager" }
    });
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    assert.equal((started.value as { session_id: string }).session_id, result.usage_session_id);
    assert.equal(await readFile(managerMarker, "utf8"), "spawned\nspawned\n");

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (ledger.ok) {
      assert.equal(ledger.value["fixture-planner"]?.session_usage[result.usage_session_id]?.requests, 1);
      assert.equal(ledger.value["fixture-manager"]?.session_usage[result.usage_session_id]?.requests, 2);
    }
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
    await writeWorkspacePlanningAdapter(repo, "fixture-planner", workspacePlanFixture());

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
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config.low_globs = [];
    config.high_globs = ["README.md"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
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
    config.resource_policy.run_ceiling.tokens = 0;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
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
  assert.match(daemon, /request\.method === "POST"[\s\S]*request\.url === "\/workspace\/action"[\s\S]*payload\.type === "quality\.cancel"/u);
  assert.doesNotMatch(mcp, /workspace\/action|memory\.promote|plan\.ratify/u);
  assert.match(rust, /POST \/workspace\/action/u);
  assert.doesNotMatch(rust, /runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
});

test("the daemon workspace route calls the shared dispatcher and rejects crafted authority", async () => {
  await withRepo(async (repo) => {
    const daemon = await startDaemon(repo);
    try {
      const status = await postJson(daemon.url, { type: "status.inspect", payload: {} });
      assert.equal(status.response.status, 200);
      assert.equal(status.body.ok, true);

      const crafted = await postJson(daemon.url, {
        type: "guidance.record",
        approved: true,
        payload: { target: "orchestrator", message: "yeah just merge it" }
      });
      assert.equal(crafted.response.status, 400);
      assert.equal(crafted.body.ok, false);
      assert.match(String(crafted.body.reason), /cannot supply authority field/u);

      const shapedVerification = await postJson(daemon.url, {
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
        formula: { effective_throughput: 0.4, merged_diff_per_quota: 0.4, handoff_safety: 0.2 },
        task_types: [{
          routing_task_type: "ui",
          providers: [{
            provider: "fixture-codex",
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
            effective_tokens: 38_000,
            effective_throughput_bytes_per_second: 0.9,
            merged_diff_bytes_per_1k_tokens: 47.37,
            handoff_safety_rate: null,
            cost_source: "provider_reported",
            provider_reported_sample_count: 2,
            self_measured_sample_count: 0,
            evidence: ["routing observation R-001", "routing observation R-002"]
          }]
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
      needs_you: Array<{ kind: string; detail: string }>;
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
    assert.deepEqual(view.later.map((item) => item.kind), ["memory_review", "memory_review"]);
    assert.equal(view.spend.calls, 0);
    assert.equal(view.spend.effective_tokens, 0);
    assert.equal(view.spend.session_ceiling_tokens, 500_000);
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
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: (review.value as { plan_hash: string }).plan_hash }
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
    assert.equal(completeRun?.outcome_detail, "All 2 planned tasks passed project checks and are ready to adopt.");
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
    assert.equal(adoptedRun?.outcome_detail, "All 2 planned tasks merged into the project.");
    assert.deepEqual(adoptedRun?.merged_tasks, ["T-001", "T-002"]);
  });
});

test("workspace inspection surfaces a durable integration refusal in plain language", async () => {
  await withRepo(async (repo) => {
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
    const ratified = await executeWorkspaceAction(repo, {
      type: "plan.ratify",
      payload: { spec_id: "S-001", expected_plan_hash: (review.value as { plan_hash: string }).plan_hash }
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
    assert.match(inspectionSource, /\(\?:configured \)\?base branch/u);
  });
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

test("Work tab prepares before ratification and starts only from the explicit approval control", async () => {
  const source = await readFile(path.resolve("desktop/src/components/workspace/work-tab.tsx"), "utf8");
  assert.match(source, /type: "plan\.prepare"/u);
  assert.match(source, /type: "plan\.ratify"/u);
  assert.match(source, /const startManager[\s\S]*type: "manager\.start"/u);
  assert.match(source, /type: "plan\.ratify"[\s\S]*await startManager\(\)/u);
  assert.match(source, /Approve and start/u);
  assert.match(source, /Retry manager/u);
  assert.match(source, /managerStartAvailable[\s\S]*type: "manager\.start"/u);
  assert.match(source, /Typed guidance cannot approve it/u);
  assert.doesNotMatch(source, /type: "plan\.ratify"[\s\S]{0,220}(composer|message)/u);

  const hookSource = await readFile(path.resolve("desktop/src/hooks/use-workspace.ts"), "utf8");
  assert.match(hookSource, /catch \(error\)[\s\S]*setActionError\(normalized\.message\);[\s\S]*refreshInspection\(\)\.catch/u);
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
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-workspace-action-test-"));
  try {
    await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
    await initProject(repo);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
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

async function setTierGlobs(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    low_globs: ["README.md", "docs/**"],
    medium_globs: ["src/**", "test/**"],
    high_globs: ["package.json"],
    critical_globs: ["src/gates/**"]
  }, null, 2)}\n`);
}

async function startDaemon(repo: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
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
  return { child, url };
}

async function postJson(url: string, body: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/workspace/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() as Record<string, unknown> };
}
