import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ROLE_RECOMMENDATIONS, agentCatalogue, findCatalogueAgent } from "../src/agent-catalogue.js";
import { connectAdapter, initProjectForDesktop } from "../src/config-actions.js";
import { corpusInvoke } from "../src/local-adapters.js";
import { findHostileHarnessSettings } from "../src/harness-config-digest.js";
import { routeTaskProvider } from "../src/routing.js";
import { loadConfig, type HivemindConfig } from "../src/config.js";
import type { TaskContract } from "../src/contract.js";

const run = promisify(execFile);

async function repoWithProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-effort-test-"));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "package.json"), '{"name":"t","scripts":{"test":"node --test"}}\n', "utf8");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "base"], { cwd: dir });
  return dir;
}

async function writeProfile(
  repo: string,
  tool: string,
  routingTier: string,
  costRank: number
): Promise<void> {
  const dir = path.join(repo, ".hivemind", "adapters");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-08-23",
        context_window: 1024,
        routing_tier: routingTier,
        cost_rank: costRank
      },
      null,
      2
    )}\n`
  );
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
    required_tests: ['node -e "process.exit(0)"'],
    patch_requirements: [],
    ...overrides
  };
}

/* ── The tier floor: routine work may run on a cheap model ─────────────────
 *
 * Measured 2026-08-23: model choice spans 3.9x effective rate while effort
 * spans ~1.04x, so the floor that forced Medium onto a standard-tier provider
 * was paying about five times over on the tier ordinary source changes land in.
 *
 * Proven to bite: restore `medium: providerTierRank.standard` and the first
 * assertion fails, with the cheap provider refused below the floor. */
test("Medium work runs on a cheap-tier provider, while High and Critical still force strong", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const loaded = await loadConfig(repo);
    assert.equal(loaded.ok, true);
    const config = (loaded.ok ? loaded.config : null) as HivemindConfig;
    config.medium_globs = ["src/medium.ts"];
    config.high_globs = ["src/high.ts"];
    config.critical_globs = ["src/schema.ts"];

    await writeProfile(repo, "cheap-worker", "cheap", 4);
    await writeProfile(repo, "standard-worker", "standard", 8);
    await writeProfile(repo, "strong-worker", "strong", 20);

    const medium = await routeTaskProvider(repo, contractFor({ allowed_files: ["src/medium.ts"] }), config);
    assert.equal(medium.ok, true, medium.ok ? undefined : medium.reason);
    if (medium.ok) {
      assert.equal(medium.value.task_tier, "medium");
      /* Cheapest wins among the eligible, which is what `compareCandidates`
         already did for low and medium -- the floor was the only thing
         standing between routine work and the cheap model. */
      assert.equal(medium.value.tool, "cheap-worker");
      assert.equal(medium.value.provider_tier, "cheap");
    }

    /* The floor still holds where being wrong is expensive. */
    for (const [file, tier] of [
      ["src/high.ts", "high"],
      ["src/schema.ts", "critical"]
    ] as const) {
      const routed = await routeTaskProvider(repo, contractFor({ allowed_files: [file] }), config);
      assert.equal(routed.ok, true, routed.ok ? undefined : routed.reason);
      if (routed.ok) {
        assert.equal(routed.value.task_tier, tier);
        assert.equal(routed.value.tool, "strong-worker");
      }
    }

    /* And a cheap tool asked for BY NAME on Critical work is still refused. */
    const named = await routeTaskProvider(
      repo,
      contractFor({ allowed_files: ["src/schema.ts"] }),
      config,
      "cheap-worker"
    );
    assert.equal(named.ok, false);
    assert.match(named.ok ? "" : named.reason, /below required floor/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* ── The inert `-c` form: never shipped again, anywhere ────────────────────
 *
 * A structural rule rather than a word ban. `-c model_reasoning_effort=low`
 * was accepted by argv, reported as applied by `codex doctor` and echoed as
 * "low" in the JSON stream while producing 30x the reasoning tokens of the
 * form that genuinely applies. Three independent readbacks agreed on a setting
 * that was not in effect, so no invocation may carry that override form. */
test("no invocation carries a -c config override, in the catalogue or the corpus ladder", () => {
  const offenders: string[] = [];
  const check = (label: string, argv: readonly string[]): void => {
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "-c" && argv[index] !== "--config") continue;
      offenders.push(`${label}: ${argv[index]} ${argv[index + 1] ?? ""}`);
    }
  };
  for (const agent of agentCatalogue) {
    if (agent.invoke !== null) check(agent.id, agent.invoke);
  }
  check("corpus", corpusInvoke("gpt-5.6-luna"));
  assert.deepEqual(
    offenders,
    [],
    "the -c override form is measured inert: accepted, self-reported as applied, echoed in the stream, and without effect"
  );
});

/* ── What cannot be forced off is refused instead ──────────────────────────
 *
 * The replacement for a fake prevention. Proven to bite: remove the refusal
 * from `connectCatalogueAgent` and the probe stub throws instead of the
 * connection being refused for free. */
test("a hostile harness setting refuses the connection before any provider call", async () => {
  const repo = await repoWithProject();
  const home = await mkdtemp(path.join(tmpdir(), "hivemind-codex-home-"));
  const previous = process.env.CODEX_HOME;
  try {
    await initProjectForDesktop(repo);
    await writeFile(
      path.join(home, "config.toml"),
      'notify = ["C:/Users/x/notify.exe", "other.exe"]\n',
      "utf8"
    );
    const found = await findHostileHarnessSettings("codex-cli", home);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.file, "config.toml");
    assert.match(found[0]!.why, /every turn/u);
    assert.match(found[0]!.remedy, /notify = \[\]/u);

    /* An empty list is the safe value and must not refuse. */
    await writeFile(path.join(home, "config.toml"), "notify = []\n", "utf8");
    assert.deepEqual(await findHostileHarnessSettings("codex-cli", home), []);

    /* A commented-out example must not refuse either: the pattern reads
       ACTIVE settings, not documentation. */
    await writeFile(path.join(home, "config.toml"), '# notify = ["prog.exe"]\n', "utf8");
    assert.deepEqual(await findHostileHarnessSettings("codex-cli", home), []);

    /* A harness with no declared hostile settings has none. */
    assert.deepEqual(await findHostileHarnessSettings("opencode", home), []);

    /* And the refusal reaches connect, ahead of the probe: the runner must
       never be reached, and no connection record may be written. */
    await writeFile(path.join(home, "config.toml"), 'notify = ["prog.exe"]\n', "utf8");
    process.env.CODEX_HOME = home;
    let probeRuns = 0;
    const refused = await connectAdapter(repo, "worker", "codex-luna", {
      runner: async () => {
        probeRuns += 1;
        throw new Error("the probe must never run while a hostile setting stands");
      }
    });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /config\.toml/u);
    assert.equal(probeRuns, 0, "a refusal that cost a provider call is not a refusal");
    const written = await readdir(path.join(repo, ".hivemind", "adapters")).catch(() => []);
    assert.ok(
      !written.some((file) => file.includes("connection")),
      `a refused connection left records: ${written.join(", ")}`
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

/* ── The advice has to be runnable ────────────────────────────────────────
 *
 * The tier floor REFUSES rather than downgrades, so a recommended worker pool
 * that does not span the tiers produces a setup that cannot run an ordinary
 * task. That is what shipped until 2026-08-23: one standard-tier worker, while
 * `initProject` puts `package.json` in High and anything uncovered falls back
 * to High. Adding a dependency stopped the run.
 *
 * Proven to bite: drop the strong member from ROLE_RECOMMENDATIONS and the
 * High and Critical assertions fail with "no eligible provider available". */
test("following the worker recommendations produces a pool that can run every tier", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const loaded = await loadConfig(repo);
    assert.equal(loaded.ok, true);
    const config = (loaded.ok ? loaded.config : null) as HivemindConfig;

    const recommended = ROLE_RECOMMENDATIONS.filter((entry) => entry.role === "worker");
    assert.ok(recommended.length >= 2, "a single-member pool cannot span the tiers");
    for (const entry of recommended) {
      const agent = findCatalogueAgent(entry.agent_id);
      assert.ok(agent, `${entry.agent_id} is recommended but not in the catalogue`);
      await writeProfile(repo, entry.agent_id, agent!.routing_tier, agent!.cost_rank);
    }

    /* The four tiers the DEFAULT globs can produce, including the fallback:
       `package.json` is High out of the box and an uncovered path is High too,
       which is what made the old single-worker advice unrunnable. */
    for (const [file, tier] of [
      ["README.md", "low"],
      ["src/thing.ts", "medium"],
      ["package.json", "high"],
      [".github/workflows/ci.yml", "critical"]
    ] as const) {
      const routed = await routeTaskProvider(repo, contractFor({ allowed_files: [file] }), config);
      assert.equal(routed.ok, true, `${tier} (${file}): ${routed.ok ? "" : routed.reason}`);
      if (routed.ok) assert.equal(routed.value.task_tier, tier);
    }

    /* And the cheap member is what routine work actually lands on, which is
       the whole point of pairing it with a strong one. */
    const medium = await routeTaskProvider(repo, contractFor({ allowed_files: ["src/thing.ts"] }), config);
    assert.equal(medium.ok, true);
    if (medium.ok) {
      const chosen = findCatalogueAgent(medium.value.tool);
      assert.equal(chosen?.routing_tier, "cheap");
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The failure the pairing prevents, stated as its own case so it cannot be
   lost if the recommendations change again. */
test("a pool of one standard worker cannot run a task that touches package.json", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const loaded = await loadConfig(repo);
    const config = (loaded.ok ? loaded.config : null) as HivemindConfig;
    await writeProfile(repo, "only-standard", "standard", 10);
    const routed = await routeTaskProvider(repo, contractFor({ allowed_files: ["package.json"] }), config);
    assert.equal(routed.ok, false);
    assert.match(routed.ok ? "" : routed.reason, /no eligible provider|floor/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
