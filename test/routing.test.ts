import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ProviderRoutingTier } from "../src/adapter.js";
import type { HivemindConfig } from "../src/config.js";
import type { TaskContract } from "../src/contract.js";
import { appendEvent } from "../src/events.js";
import {
  appendRoutingObservation,
  deriveLearnedRoutingPolicy,
  proposeLearnedRoutingPolicy,
  readPromotedRoutingPolicy
} from "../src/learned-routing.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import { reviewMemoryProposalInteractively } from "../src/memory-review.js";
import { recordQuotaUsage } from "../src/resource-ledger.js";
import { inferTaskTier, routeTaskProvider } from "../src/routing.js";

test("routeTaskProvider never downgrades a Critical task below the strong provider floor", async () => {
  await withTempRepo(async ({ repo, config }) => {
    const contract = contractFor({ allowed_files: ["src/schema.ts"] });
    await writeProfile(repo, "cheap", "cheap", 1);
    await writeProfile(repo, "strong", "strong", 50);
    await recordQuotaUsage(repo, {
      provider: "strong",
      input_text: "prompt",
      model_output_text: "429 too many requests",
      wall_time_ms: 1,
      throttled: true
    });

    const result = await routeTaskProvider(repo, contract, config);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.task_tier, "critical");
    assert.equal(result.value.tool, "strong");
    assert.equal(result.value.provider_tier, "strong");
  });
});

test("routeTaskProvider rejects explicit below-floor tools for Critical tasks", async () => {
  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "weak", "standard", 1);

    const result = await routeTaskProvider(repo, contractFor({ allowed_files: ["src/schema.ts"] }), config, "weak");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /below required floor for critical task tier/);
  });
});

test("routeTaskProvider routes Low-tier work to the cheapest eligible provider", async () => {
  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "local", "local", 1);
    await writeProfile(repo, "strong", "strong", 20);

    const result = await routeTaskProvider(repo, contractFor({ allowed_files: ["README.md"] }), config);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.task_tier, "low");
    assert.equal(result.value.tool, "local");
  });
});

test("explicit quality routing preferences choose cheapest and strongest only within the tier floor", async () => {
  await withTempRepo(async ({ repo, config }) => {
    config.medium_globs = ["src/medium.ts"];
    await writeProfile(repo, "standard-cheap", "standard", 1);
    await writeProfile(repo, "strong-expensive", "strong", 50);
    const contract = contractFor({ allowed_files: ["src/medium.ts"] });

    const cheapest = await routeTaskProvider(
      repo,
      contract,
      config,
      undefined,
      { preference: "cheapest" }
    );
    const strongest = await routeTaskProvider(
      repo,
      contract,
      config,
      undefined,
      { preference: "strongest" }
    );

    assert.equal(cheapest.ok, true, cheapest.ok ? undefined : cheapest.reason);
    assert.equal(strongest.ok, true, strongest.ok ? undefined : strongest.reason);
    if (cheapest.ok && strongest.ok) {
      assert.equal(cheapest.value.task_tier, "medium");
      assert.equal(cheapest.value.tool, "standard-cheap");
      assert.equal(cheapest.value.provider_tier, "standard");
      assert.equal(strongest.value.task_tier, "medium");
      assert.equal(strongest.value.tool, "strong-expensive");
      assert.equal(strongest.value.provider_tier, "strong");
    }

    const critical = await routeTaskProvider(
      repo,
      contractFor({ allowed_files: ["src/schema.ts"] }),
      config,
      undefined,
      { preference: "cheapest" }
    );
    assert.equal(critical.ok, true, critical.ok ? undefined : critical.reason);
    if (critical.ok) {
      assert.equal(critical.value.tool, "strong-expensive");
      assert.equal(critical.value.provider_tier, "strong");
    }
  });
});

test("routeTaskProvider fails closed on malformed auto-route provider metadata", async () => {
  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "bad", "standard", 1, { routing_tier: "tiny" });

    const result = await routeTaskProvider(repo, contractFor({ allowed_files: ["README.md"] }), config);

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /routing_tier must be one of/);
  });
});

test("inferTaskTier defaults unmatched scope to High", () => {
  assert.equal(inferTaskTier(contractFor({ allowed_files: ["unmatched.ts"] }), configFor("D:\\fixture")), "high");
});

test("metric-derived routing is inspectable, scoped, and inert until human promotion", async () => {
  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "provider-a", "strong", 20);
    await writeProfile(repo, "provider-b", "strong", 1);
    await appendSuccessfulSample(repo, "T-A1", "run-a1", "provider-a", 2_000, 1_000, "provider_reported");
    await appendSuccessfulSample(repo, "T-A2", "run-a2", "provider-a", 2_000, 1_200, "provider_reported");
    await appendRejectedSample(repo, "T-B1", "run-b1", "provider-b", 400);
    await appendRejectedSample(repo, "T-B2", "run-b2", "provider-b", 450);

    const derived = await deriveLearnedRoutingPolicy(repo);
    assert.equal(derived.ok, true);
    if (!derived.ok) {
      return;
    }
    const cliScores = derived.value.task_types.find((entry) => entry.routing_task_type === "cli");
    assert.notEqual(cliScores, undefined);
    const providerA = cliScores?.providers.find((entry) => entry.provider === "provider-a");
    const providerB = cliScores?.providers.find((entry) => entry.provider === "provider-b");
    assert.notEqual(providerA, undefined);
    assert.notEqual(providerB, undefined);
    assert.equal(providerA?.cost_source, "provider_reported");
    assert.equal(providerA?.provider_reported_sample_count, 2);
    assert.equal(providerA?.completed_count, 2);
    assert.equal(providerA?.integrated_count, 2);
    assert.equal(providerA?.failed_count, 0);
    assert.equal(providerB?.cost_source, "self_measured");
    assert.equal(providerB?.self_measured_sample_count, 2);
    assert.equal(providerB?.request_count, 2);
    assert.equal(providerB?.revision_count, 2);
    assert.equal(providerB?.completed_count, 2);
    assert.equal(providerB?.failed_count, 2);
    assert.equal((providerA?.weight ?? 0) > (providerB?.weight ?? 0), true);
    assert.equal((providerA?.merged_diff_bytes ?? 0) > 0, true);
    assert.equal((providerA?.evidence.length ?? 0) >= 6, true);
    assert.deepEqual(derived.value.formula, {
      effective_throughput: 0.4,
      merged_diff_per_quota: 0.4,
      handoff_safety: 0.2
    });

    const beforePromotion = await routeTaskProvider(
      repo,
      contractFor({ routing_task_type: "cli" }),
      config
    );
    assert.equal(beforePromotion.ok, true);
    if (!beforePromotion.ok) {
      return;
    }
    assert.equal(beforePromotion.value.tool, "provider-b");
    assert.equal(beforePromotion.value.learned_policy?.status, "fallback");

    const proposal = await proposeLearnedRoutingPolicy(repo);
    assert.equal(proposal.ok, true);
    if (!proposal.ok) {
      return;
    }
    assert.notEqual(proposal.value.routing_policy, null);
    assert.equal((await readPromotedRoutingPolicy(repo)).promoted, "absent");

    const stillUnpromoted = await routeTaskProvider(
      repo,
      contractFor({ routing_task_type: "cli" }),
      config
    );
    assert.equal(stillUnpromoted.ok, true);
    if (stillUnpromoted.ok) {
      assert.equal(stillUnpromoted.value.tool, "provider-b");
    }

    const promoted = await runInteractiveReview(repo, proposal.value.proposal_id);
    assert.equal(promoted.ok, true);
    assert.equal((await readPromotedRoutingPolicy(repo)).promoted, "active");

    const afterPromotion = await routeTaskProvider(
      repo,
      contractFor({ routing_task_type: "cli" }),
      config
    );
    assert.equal(afterPromotion.ok, true);
    if (!afterPromotion.ok) {
      return;
    }
    assert.equal(afterPromotion.value.tool, "provider-a");
    assert.equal(afterPromotion.value.learned_policy?.status, "applied");

    const unrelatedType = await routeTaskProvider(
      repo,
      contractFor({ routing_task_type: "ui" }),
      config
    );
    assert.equal(unrelatedType.ok, true);
    if (unrelatedType.ok) {
      assert.equal(unrelatedType.value.tool, "provider-b");
      assert.equal(unrelatedType.value.learned_policy?.status, "fallback");
    }

    await appendEvent(repo, {
      type: "patch.rejected",
      task_id: "T-NEW",
      data: { verdict: "reject", reason: "new evidence makes promoted weights stale" }
    });
    const stale = await routeTaskProvider(repo, contractFor({ routing_task_type: "cli" }), config);
    assert.equal(stale.ok, true);
    if (stale.ok) {
      assert.equal(stale.value.tool, "provider-b");
      assert.equal(stale.value.learned_policy?.status, "fallback");
      assert.match(stale.value.learned_policy?.reason ?? "", /does not match current Tier-1 routing evidence/);
    }
  });
});

test("empty and invalid promoted-policy state degrade to the existing tier route", async () => {
  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "provider-a", "strong", 20);
    await writeProfile(repo, "provider-b", "strong", 1);
    await appendSuccessfulSample(repo, "T-A1", "run-a1", "provider-a", 2_000, 1_000, "provider_reported");
    const derived = await deriveLearnedRoutingPolicy(repo);
    assert.equal(derived.ok, true);
    if (!derived.ok) {
      return;
    }
    const emptyProposal = await proposeMemoryLesson(repo, {
      title: "Empty routing policy fixture",
      lesson: "An empty promoted policy must remain inert.",
      evidence: ["events.jsonl#L1"],
      routing_policy: { ...derived.value, task_types: [] }
    });
    assert.equal(emptyProposal.ok, true);
    if (!emptyProposal.ok) {
      return;
    }
    assert.equal((await runInteractiveReview(repo, emptyProposal.value.proposal_id)).ok, true);
    const emptyResult = await routeTaskProvider(repo, contractFor({ routing_task_type: "cli" }), config);
    assert.equal(emptyResult.ok, true);
    if (emptyResult.ok) {
      assert.equal(emptyResult.value.tool, "provider-b");
      assert.equal(emptyResult.value.learned_policy?.status, "fallback");
      assert.match(emptyResult.value.learned_policy?.reason ?? "", /no weights for cli/);
    }
  });

  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "provider-a", "strong", 20);
    await writeProfile(repo, "provider-b", "strong", 1);
    const canonDir = path.join(repo, ".hivemind", "canon");
    await mkdir(canonDir, { recursive: true });
    await writeFile(path.join(canonDir, "corrupt.memory.json"), "{not-json}\n");

    const invalidResult = await routeTaskProvider(repo, contractFor({ routing_task_type: "cli" }), config);
    assert.equal(invalidResult.ok, true);
    if (invalidResult.ok) {
      assert.equal(invalidResult.value.tool, "provider-b");
      assert.equal(invalidResult.value.learned_policy?.status, "fallback");
      assert.match(invalidResult.value.learned_policy?.reason ?? "", /invalid JSON/);
    }
  });
});

test("promoted learned policy that would downgrade Critical work is refused by the tier floor", async () => {
  await withTempRepo(async ({ repo, config }) => {
    await writeProfile(repo, "weak-favorite", "cheap", 1);
    await writeProfile(repo, "strong-safe", "strong", 50);
    await appendSuccessfulSample(repo, "T-WEAK", "run-weak", "weak-favorite", 4_000, 900, "provider_reported");
    await appendRejectedSample(repo, "T-STRONG", "run-strong", "strong-safe", 1_000);
    const proposal = await proposeLearnedRoutingPolicy(repo);
    assert.equal(proposal.ok, true);
    if (!proposal.ok) {
      return;
    }
    assert.equal((await runInteractiveReview(repo, proposal.value.proposal_id)).ok, true);

    const result = await routeTaskProvider(
      repo,
      contractFor({ allowed_files: ["src/schema.ts"], routing_task_type: "cli" }),
      config
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.task_tier, "critical");
    assert.equal(result.value.tool, "strong-safe");
    assert.equal(result.value.learned_policy?.status, "refused_tier_cap");
    assert.match(result.value.learned_policy?.reason ?? "", /below required floor for critical task tier/);
  });
});

async function withTempRepo(run: (context: { repo: string; config: HivemindConfig }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-routing-test-"));
  try {
    const config = configFor(repo);
    await writeConfig(repo, config);
    await run({ repo, config });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function appendSuccessfulSample(
  repo: string,
  taskId: string,
  runId: string,
  provider: string,
  diffBytes: number,
  tokens: number,
  source: "provider_reported" | "self_measured"
): Promise<void> {
  assert.equal((await appendRoutingObservation(repo, taskId, {
    version: 1,
    run_id: runId,
    provider,
    routing_task_type: "cli",
    request_count: 1,
    wall_time_ms: 1_000,
    self_measured_tokens: 100,
    provider_reported_tokens: source === "provider_reported" ? tokens : null,
    effective_tokens: tokens,
    cost_source: source,
    diff_bytes: diffBytes,
    exit_code: 0,
    timed_out: false,
    handoff_from: null
  })).ok, true);
  assert.equal((await appendEvent(repo, {
    type: "task.completed",
    task_id: taskId,
    data: { run_id: runId, tool: provider, status: "completed" }
  })).ok, true);
  assert.equal((await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "fixture accepted" }
  })).ok, true);
  assert.equal((await appendEvent(repo, {
    type: "integration.passed",
    task_id: null,
    data: { applied: [taskId], tests: "pass" }
  })).ok, true);
}

async function appendRejectedSample(
  repo: string,
  taskId: string,
  runId: string,
  provider: string,
  tokens: number
): Promise<void> {
  assert.equal((await appendRoutingObservation(repo, taskId, {
    version: 1,
    run_id: runId,
    provider,
    routing_task_type: "cli",
    request_count: 1,
    wall_time_ms: 2_000,
    self_measured_tokens: tokens,
    provider_reported_tokens: null,
    effective_tokens: tokens,
    cost_source: "self_measured",
    diff_bytes: 500,
    exit_code: 0,
    timed_out: false,
    handoff_from: null
  })).ok, true);
  assert.equal((await appendEvent(repo, {
    type: "task.completed",
    task_id: taskId,
    data: { run_id: runId, tool: provider, status: "completed" }
  })).ok, true);
  assert.equal((await appendEvent(repo, {
    type: "patch.rejected",
    task_id: taskId,
    data: { verdict: "reject", reason: "fixture rejected", changed_files: ["package.json"] }
  })).ok, true);
}

async function runInteractiveReview(repo: string, proposalId: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(output, "isTTY", { value: true });
  output.resume();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
  if (stdinDescriptor === undefined || stderrDescriptor === undefined) {
    throw new Error("process stdio descriptors are unavailable");
  }
  Object.defineProperty(process, "stdin", { configurable: true, enumerable: true, get: () => input });
  Object.defineProperty(process, "stderr", { configurable: true, enumerable: true, get: () => output });
  input.end(`approve ${proposalId}\n`);
  try {
    return await reviewMemoryProposalInteractively(repo, proposalId);
  } finally {
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stderr", stderrDescriptor);
  }
}

function contractFor(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: "T-001",
    title: "Route task",
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: "abc123",
    acceptance_criterion: "Routing fixture selects one provider.",
    allowed_files: ["README.md"],
    allowed_file_intents: { "README.md": "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: [],
    ...overrides
  };
}

function configFor(repo: string): HivemindConfig {
  return {
    version: 1,
    stack: "typescript-node",
    repo_root: repo,
    test_command: "",
    allowed_globs: [],
    forbidden_globs: [],
    low_globs: ["README.md"],
    critical_globs: ["src/schema.ts"]
  };
}

async function writeConfig(repo: string, config: HivemindConfig): Promise<void> {
  await mkdir(path.join(repo, ".hivemind"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function writeProfile(
  repo: string,
  tool: string,
  routingTier: ProviderRoutingTier,
  costRank: number,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: routingTier,
        cost_rank: costRank,
        ...overrides
      },
      null,
      2
    )}\n`
  );
}
