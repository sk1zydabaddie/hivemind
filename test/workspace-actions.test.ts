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
import { executeWorkspaceAction, workspaceActionTypes } from "../src/workspace-actions.js";
import { loadAdmittedValueQualityRun } from "../src/value-quality.js";
import { runAdapterProcess, type AdapterProfile } from "../src/adapter.js";
import { createTentativePlan, groundTentativePlan, lintTentativePlan } from "../src/plan.js";
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

    const manager = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Propose the next step.", tool: "guidance-manager" }
    });
    assert.equal(manager.ok, true, manager.ok ? undefined : manager.reason);
    assert.equal(await readFile(callsPath, "utf8"), "call\n");
    const secondManager = await executeWorkspaceAction(repo, {
      type: "manager.start",
      payload: { message: "Propose another step.", tool: "guidance-manager" }
    });
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
      command: "hivemind memory review MEM-001",
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
    await appendEvent(repo, {
      type: "memory.proposed",
      task_id: null,
      data: { proposal_id: "MEM-001", title: "Prefer project-bound daemon discovery" }
    });
    const candidateRoot = path.join(repo, ".hivemind", "resource", "oracle-candidates", "C-001");
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(path.join(candidateRoot, "manifest.json"), `${JSON.stringify({
      candidate_id: "C-001",
      task_id: "T-001",
      check_id: "unit"
    }, null, 2)}\n`);
    await writeFile(path.join(candidateRoot, "validation.json"), `${JSON.stringify({
      classification: "valid_characterization",
      reason: "existing selector behavior captured"
    }, null, 2)}\n`);

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
      swarm: { characterizations: Array<{ candidate_id: string; task_id: string; classification: string; check_id: string }> };
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
    assert.deepEqual(view.needs_you.map((item) => item.kind).sort(), ["merge_blocked", "plan_review", "task_attention"]);
    assert.equal(view.needs_you.find((item) => item.kind === "merge_blocked")?.detail, "Critical change, line 42 untested.");
    assert.deepEqual(view.later.map((item) => item.kind), ["memory_review"]);
    assert.equal(view.spend.calls, 0);
    assert.equal(view.spend.effective_tokens, 0);
    assert.equal(view.spend.session_ceiling_tokens, 500_000);
    assert.deepEqual(view.swarm.characterizations, [{
      candidate_id: "C-001",
      task_id: "T-001",
      classification: "valid_characterization",
      reason: "existing selector behavior captured",
      check_id: "unit",
      artifact_path: ".hivemind/resource/oracle-candidates/C-001"
    }]);

    const source = await readFile(path.resolve("src/workspace-inspection.ts"), "utf8");
    assert.doesNotMatch(source, /appendEvent|ratifyPlan|queuePlanAmendment|requestTaskRedirect/u);
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
  });
});

test("React action bridge remains a typed Tauri invocation with no Core authority", async () => {
  const source = await readFile(path.resolve("desktop/src/lib/workspace-actions.ts"), "utf8");
  assert.match(source, /invoke<T>\("workspace_action"/u);
  assert.doesNotMatch(source, /fetch\(|runGate|integrateShadow|requestLease|reviewMemoryProposal/u);
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
