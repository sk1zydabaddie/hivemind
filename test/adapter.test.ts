import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildAgentPrompt,
  findDangerousAdapterArgs,
  findRefusedAdapterModes,
  invokeAgent,
  loadAdapterProfile,
  parseAdapterProviderUsage,
  resolveAdapterUsageParser,
  runAdapterProcess,
  validateAdapterProfile
} from "../src/adapter.js";
import { initProject } from "../src/init.js";
import { estimateTokens, readQuotaLedger, readQuotaLedgerState } from "../src/resource-ledger.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

test("buildAgentPrompt includes the scoped contract fields and diff-only instruction", () => {
  const prompt = buildAgentPrompt({
    task_id: "T-001",
    title: "Add adapter invocation",
    agent_role: "builder",
    routing_task_type: "orchestration",
    base_commit: "abc123",
    acceptance_criterion: "Adapter prompt includes scoped contract details.",
    allowed_files: ["src/adapter.ts"],
    allowed_file_intents: { "src/adapter.ts": "modify" },
    read_only_files: ["Hivemind_AI_Overview.md"],
    forbidden_files: ["src/gate.ts"],
    allowed_symbols: ["invokeAgent"],
    forbidden_symbols: ["forbiddenCall"],
    must_not_change: ["diff capture"],
    required_tests: ["npm test"],
    patch_requirements: ["no commits"]
  });

  assert.match(prompt, /Submit a diff only/);
  assert.match(prompt, /Title: Add adapter invocation/);
  assert.match(prompt, /Allowed files:\n- src\/adapter\.ts/);
  assert.match(prompt, /Forbidden files:\n- src\/gate\.ts/);
  assert.match(prompt, /Required tests:\n- npm test/);
  assert.match(prompt, /Must not change:\n- diff capture/);
});

test("loadAdapterProfile validates the requested tool profile", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const profile = await loadAdapterProfile(repo, "fake");

    assert.equal(profile.ok, true);
    if (!profile.ok) {
      return;
    }
    assert.equal(profile.profile.tool, "fake");
    assert.deepEqual(profile.profile.invoke, ["node", "fake-agent.mjs"]);
  });
});

test("loadAdapterProfile accepts UTF-8 BOM prefixed JSON", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeProfile(
      repo,
      "fake",
      {
        tool: "fake",
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024
      },
      true
    );

    const profile = await loadAdapterProfile(repo, "fake");

    assert.equal(profile.ok, true);
  });
});

test("validateAdapterProfile rejects missing volatile invocation data", () => {
  assert.deepEqual(validateAdapterProfile({ tool: "fake" }, "fake"), [
    "invoke must be a non-empty array of non-empty strings",
    "prompt_arg must be stdin or arg",
    "verified_on is required",
    "context_window must be a positive integer"
  ]);
});

test("validateAdapterProfile rejects empty invoke entries", () => {
  assert.deepEqual(
    validateAdapterProfile(
      {
        tool: "fake",
        invoke: ["node", ""],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024
      },
      "fake"
    ),
    ["invoke must be a non-empty array of non-empty strings"]
  );
});

test("validateAdapterProfile rejects invalid timeout values", () => {
  assert.deepEqual(
    validateAdapterProfile(
      {
        tool: "fake",
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024,
        timeout_ms: 0
      },
      "fake"
    ),
    ["timeout_ms must be a positive integer when provided"]
  );
});

test("validateAdapterProfile rejects invalid routing metadata", () => {
  assert.deepEqual(
    validateAdapterProfile(
      {
        tool: "fake",
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024,
        routing_tier: "tiny",
        cost_rank: 0
      },
      "fake"
    ),
    ["routing_tier must be one of local, cheap, standard, strong when provided", "cost_rank must be a positive integer when provided"]
  );
});

test("validateAdapterProfile rejects unknown provider usage parsers", () => {
  assert.deepEqual(
    validateAdapterProfile(
      {
        tool: "fake",
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-07-27",
        context_window: 1024,
        usage_parser: "guess"
      },
      "fake"
    ),
    ["usage_parser must be one of codex-jsonl, codex-text, claude-json when provided"]
  );
});

test("adapter profiles fail closed on unknown settings and refused ultra modes", () => {
  const base = {
    tool: "codex-worker",
    invoke: ["codex", "exec", "-"],
    prompt_arg: "stdin",
    verified_on: "2026-08-01",
    context_window: 1024,
    settings: { dynamic_workflows: true }
  };
  const problems = validateAdapterProfile(base, "codex-worker");
  assert.ok(problems.includes("unsupported adapter profile field: settings"));
  assert.ok(problems.some((problem) => problem.includes("refused orchestration mode")));
  assert.deepEqual(
    findRefusedAdapterModes({ invoke: ["claude", "--dynamic-workflows"] }),
    ['profile.invoke[1]="--dynamic-workflows"']
  );
});

test("adapter usage parsers normalize Codex text, Codex JSONL, and Claude JSON inside the adapter boundary", () => {
  assert.deepEqual(
    parseAdapterProviderUsage("codex-text", "", "\u001b[2mtokens used\u001b[0m\n14,351\n"),
    {
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      total_tokens: 14351
    }
  );
  assert.deepEqual(
    parseAdapterProviderUsage(
      "codex-jsonl",
      [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 120,
            cached_input_tokens: 40,
            output_tokens: 80,
            output_tokens_details: { reasoning_tokens: 50 },
            total_tokens: 200
          }
        })
      ].join("\n"),
      ""
    ),
    {
      input_tokens: 120,
      cached_input_tokens: 40,
      output_tokens: 80,
      reasoning_tokens: 50,
      total_tokens: 200
    }
  );
  assert.deepEqual(
    parseAdapterProviderUsage(
      "claude-json",
      JSON.stringify({
        result: "done",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
          output_tokens: 40
        }
      }),
      ""
    ),
    {
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 40,
      reasoning_tokens: null,
      total_tokens: 190
    }
  );
});

test("adapter selects provider parsers from tool invocation while unknown tools keep self-metered fallback", () => {
  const base = {
    prompt_arg: "stdin" as const,
    verified_on: "2026-07-27",
    context_window: 1024
  };
  assert.equal(
    resolveAdapterUsageParser({ ...base, tool: "codex-worker", invoke: ["codex.cmd", "exec", "-"] }),
    "codex-text"
  );
  assert.equal(
    resolveAdapterUsageParser({ ...base, tool: "codex-planner", invoke: ["codex", "exec", "--json", "-"] }),
    "codex-jsonl"
  );
  assert.equal(
    resolveAdapterUsageParser({ ...base, tool: "claude", invoke: ["claude.cmd", "-p", "--output-format", "json"] }),
    "claude-json"
  );
  assert.equal(
    resolveAdapterUsageParser({ ...base, tool: "fake", invoke: ["node", "fake-agent.mjs"] }),
    undefined
  );
});

test("loadAdapterProfile defaults routing metadata when omitted", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const profile = await loadAdapterProfile(repo, "fake");

    assert.equal(profile.ok, true);
    if (!profile.ok) {
      return;
    }
    assert.equal(profile.profile.routing_tier, undefined);
    assert.equal(profile.profile.cost_rank, undefined);
  });
});

test("findDangerousAdapterArgs detects provider bypass flags", () => {
  assert.deepEqual(findDangerousAdapterArgs(["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"]), [
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  assert.deepEqual(findDangerousAdapterArgs(["claude", "--permission-mode", "bypassPermissions"]), ["bypassPermissions"]);
});

test("ultra modes are refused before spawn for worker and orchestrator roles", async () => {
  await withTempRepo(async ({ repo }) => {
    for (const tool of ["fake-worker", "manager"]) {
      const marker = path.join(repo, `${tool}.spawned`);
      const result = await runAdapterProcess(
        repo,
        {
          tool,
          invoke: [process.execPath, "--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`, "--ultracode"],
          prompt_arg: "stdin",
          verified_on: "2026-08-01",
          context_window: 1024
        },
        repo,
        "fixture"
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /refused before spawn.*one-worker\/one-scope/u);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    }
  });
});

test("ambiguous inherited provider ultra settings are refused before spawn", async () => {
  await withTempRepo(async ({ repo }) => {
    const prior = process.env.CODEX_EFFORT;
    process.env.CODEX_EFFORT = "ultra";
    try {
      const marker = path.join(repo, "env.spawned");
      const result = await runAdapterProcess(
        repo,
        {
          tool: "fake",
          invoke: [process.execPath, "--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
          prompt_arg: "stdin",
          verified_on: "2026-08-01",
          context_window: 1024
        },
        repo,
        "fixture"
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /environment CODEX_EFFORT/u);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally {
      if (prior === undefined) delete process.env.CODEX_EFFORT;
      else process.env.CODEX_EFFORT = prior;
    }
  });
});

test("invokeAgent runs stdin adapter inside the task worktree and writes agent.log", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(
      path.join(worktree.value.worktree, "fake-stdin-agent.mjs"),
      [
        "let prompt = '';",
        "for await (const chunk of process.stdin) prompt += chunk;",
        "console.log(JSON.stringify({ cwd: process.cwd(), sawTitle: prompt.includes('Title: Invoke fake adapter') }));",
        "console.error('stderr from fake stdin adapter');"
      ].join("\n")
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-stdin-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 0);
    assert.equal(result.value.logPath, path.join(worktree.value.worktree, "agent.log"));
    const log = await readFile(result.value.logPath, "utf8");
    assert.match(log, /exit_code: 0/);
    assert.match(log, /"cwd":/);
    assert.match(log, /"sawTitle":true/);
    assert.match(log, /stderr from fake stdin adapter/);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.self_measured.requests, 1);
    assert.equal(ledger.value.fake.source, "dual-channel");
    assert.equal(ledger.value.fake.observed_limit, null);
    assert.equal(ledger.value.fake.provider_usage_capture.last_status, "not_available");
    const state = await readQuotaLedgerState(repo);
    assert.equal(state.ok, true);
    if (!state.ok) return;
    const reservations = Object.values(state.value.reservations);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].status, "settled");
    assert.equal(reservations[0].task_id, "T-001");
    assert.equal(reservations[0].run_id, "T-001");
    assert.equal(reservations[0].provider, "fake");
    assert.ok(reservations[0].session_id);
    assert.ok(reservations[0].daemon_instance_id);
    assert.ok(reservations[0].process_identity);
  });
});

test("invokeAgent updates observed quota limit on a simulated throttle", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "throttle-agent.mjs"), "console.error('429 too many requests'); process.exit(1);\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "throttle-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 1);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.self_measured.requests, 1);
    assert.notEqual(ledger.value.fake.observed_limit, null);
    assert.equal(ledger.value.fake.observed_limit?.reason, "throttle");
    assert.equal(ledger.value.fake.observed_limit?.requests, ledger.value.fake.self_measured.requests);
    assert.equal(ledger.value.fake.reconciliation.routing_source, "observed_limit");
  });
});

test("invokeAgent meters model stdout separately from stderr chatter and records provider reconciliation", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    const modelOutput = "scoped model answer";
    const stderrChatter = `prompt echo ${"x".repeat(4000)}`;
    await writeFile(
      path.join(worktree.value.worktree, "codex-shaped-agent.mjs"),
      [
        `process.stdout.write(${JSON.stringify(modelOutput)});`,
        `process.stderr.write(${JSON.stringify(`${stderrChatter}\n\u001b[2mtokens used\u001b[0m\n14,351\n`)});`
      ].join("\n")
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "codex-shaped-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-07-27",
      context_window: 1024,
      usage_parser: "codex-text"
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    const entry = ledger.value.fake;
    assert.equal(entry.self_measured.output_tokens_estimated, estimateTokens(modelOutput));
    assert.ok(entry.self_measured.output_tokens_estimated < estimateTokens(stderrChatter));
    assert.equal(entry.provider_reported?.total_tokens, 14351);
    assert.equal(entry.provider_usage_capture.last_status, "captured");
    assert.equal(entry.last_request?.effective_tokens, 14351);
    assert.equal(entry.reconciliation.provider_reported_total_tokens, 14351);
    assert.equal(entry.reconciliation.accounting_source, "provider_reported");
    assert.equal(entry.reconciliation.absolute_divergence_tokens, 14351 - (
      entry.self_measured.input_tokens_estimated + entry.self_measured.output_tokens_estimated
    ));
  });
});

test("invokeAgent records and surfaces provider usage that was expected but unparseable", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "unparseable-agent.mjs"), "console.log('not-json-provider-output');\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "unparseable-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-07-28",
      context_window: 1024,
      usage_parser: "codex-jsonl"
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /provider usage expected but unparseable/);
    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) {
      return;
    }
    assert.equal(ledger.value.fake.self_measured.requests, 1);
    assert.equal(ledger.value.fake.provider_usage_capture.last_status, "expected_but_unparseable");
    assert.equal(ledger.value.fake.provider_usage_capture.expected_but_unparseable_requests, 1);
    assert.equal(ledger.value.fake.last_request?.accounting_source, "self_measured");
  });
});

test("invokeAgent refuses before spawning when the manager session token budget is exhausted", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    const markerPath = path.join(worktree.value.worktree, "spawned.txt");
    await writeFile(
      path.join(worktree.value.worktree, "budget-agent.mjs"),
      `await (await import("node:fs/promises")).writeFile(${JSON.stringify(markerPath)}, "spawned");\n`
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "budget-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-07-28",
      context_window: 1024
    });
    await setResourcePolicy(repo, { session_ceiling: { tokens: 0 } });

    const result = await invokeAgent(repo, "T-001", "fake", { usageSessionId: "manager-session" });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /session manager-session has 0 settled tokens and 0 active reserved tokens.*ceiling 0/);
    await assertMissing(markerPath);
  });
});

test("invokeAgent rejects dangerous adapter flags unless explicitly approved", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "dangerous-agent.mjs"), "console.log('should not run without approval');\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "dangerous-agent.mjs", "--dangerously-skip-permissions"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /dangerous invocation flags/);
    await assertMissing(path.join(worktree.value.worktree, "agent.log"));
  });
});

test("invokeAgent runs dangerous adapter flags with explicit approval", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "approved-dangerous-agent.mjs"), "console.log('approved dangerous adapter run');\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "approved-dangerous-agent.mjs", "--dangerously-skip-permissions"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake", { allowDangerousAdapter: true });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.match(await readFile(result.value.logPath, "utf8"), /approved dangerous adapter run/);
  });
});

test("invokeAgent passes the prompt as an argument when the profile requests arg mode", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(
      path.join(worktree.value.worktree, "fake-arg-agent.mjs"),
      "console.log(process.argv[2].includes('Submit a diff only') ? 'arg prompt ok' : 'arg prompt missing');\n"
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-arg-agent.mjs"],
      prompt_arg: "arg",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 0);
    assert.match(await readFile(result.value.logPath, "utf8"), /arg prompt ok/);
  });
});

test("invokeAgent surfaces non-zero adapter exits without crashing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "fake-fail-agent.mjs"), "console.error('planned exit'); process.exit(7);\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-fail-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 7);
    assert.match(result.value.failureReason ?? "", /worker fake exited 7/u);
    assert.match(result.value.failureReason ?? "", /planned exit/u);
    assert.match(result.value.failureReason ?? "", /agent\.log/u);
    const log = await readFile(result.value.logPath, "utf8");
    assert.match(log, /exit_code: 7/);
    assert.match(log, /planned exit/);
  });
});

test("invokeAgent times out a wedged adapter and writes agent.log", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(
      path.join(worktree.value.worktree, "fake-timeout-agent.mjs"),
      [
        "await import('node:fs/promises').then(({ appendFile }) => appendFile('README.md', 'changed before timeout\\n'));",
        "setInterval(() => undefined, 1000);"
      ].join("\n")
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-timeout-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024,
      timeout_ms: 50
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 124);
    const log = await readFile(result.value.logPath, "utf8");
    assert.match(log, /exit_code: 124/);
    assert.match(log, /timed_out: true/);
    assert.match(log, /adapter timed out after 50ms/);
  });
});

test("invokeAgent returns a scoped error when the profile is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);

    const result = await invokeAgent(repo, "T-001", "missing");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /adapter profile not found/);
  });
});

test("invokeAgent returns a scoped error when the worktree is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "unused.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /worktree not found/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"));
  });
});

test("invokeAgent returns a scoped error when the adapter command cannot start", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["definitely-missing-hivemind-command"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /failed to start adapter "fake"/);
    const ledger = await readQuotaLedgerState(repo);
    assert.equal(ledger.ok, true);
    if (!ledger.ok) return;
    const reservations = Object.values(ledger.value.reservations);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].status, "released");
    assert.equal(reservations[0].settlement?.reason, "spawn_failed");
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-adapter-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
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
  await rm(repo, { recursive: true, force: true });
}

async function writeContract(repo: string, taskId: string, baseCommit: string): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Invoke fake adapter",
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Fake adapter invocation completes.",
        allowed_files: ["README.md"],
        read_only_files: ["package.json"],
        forbidden_files: ["src/gate.ts"],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: ["gate"],
        required_tests: ["npm test"],
        patch_requirements: ["small diff"]
      },
      null,
      2
    )}\n`
  );
}

async function writeProfile(repo: string, tool: string, profile: unknown, bom = false): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(path.join(adaptersDir, `${tool}.profile.json`), `${bom ? "\uFEFF" : ""}${JSON.stringify(profile, null, 2)}\n`);
}

async function setResourcePolicy(repo: string, resourcePolicy: Record<string, unknown>): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify({ ...config, resource_policy: resourcePolicy }, null, 2)}\n`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
