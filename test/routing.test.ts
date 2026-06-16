import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProviderRoutingTier } from "../src/adapter.js";
import type { HivemindConfig } from "../src/config.js";
import type { TaskContract } from "../src/contract.js";
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
      output_text: "429 too many requests",
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

function contractFor(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: "T-001",
    title: "Route task",
    agent_role: "builder",
    base_commit: "abc123",
    acceptance_criterion: "Routing fixture selects one provider.",
    allowed_files: ["README.md"],
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
