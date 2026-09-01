import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

/* ── The `-c` override form is PER KEY, and each key names its measurement ──
 *
 * A blanket ban stood here, written when the only measured key was inert. It
 * was too strong: on 2026-08-23 a canary passed through `-c notify` fired and
 * received codex's own turn-complete payload, so that key demonstrably applies.
 * Three keys are now measured -- `sandbox_mode` works, `notify` works,
 * `model_reasoning_effort` is inert -- so the rule is a per-key allowlist and
 * the burden is a measurement, not an opinion.
 *
 * Proven to bite: add `model_reasoning_effort` to any invocation and this
 * fails, naming the key and the reason it is refused. */
test("every -c override an invocation carries is a key measured to apply", () => {
  /* Keys measured to take effect on the invocation path, with what proved it.
     Anything absent from this table is refused, so adding an override means
     measuring it first. */
  const MEASURED_TO_APPLY = new Map([
    [
      "notify",
      "2026-08-23: a canary passed through `-c notify` fired with codex's agent-turn-complete payload while the user's own chain did not run"
    ],
    ["sandbox_mode", "measured earlier: `codex doctor -c` reported the flipped value"]
  ]);
  const MEASURED_INERT = new Map([
    [
      "model_reasoning_effort",
      "accepted by argv, reported applied by `codex doctor`, echoed in the JSON stream, and 30x the reasoning tokens of the form that applies"
    ]
  ]);

  const offenders: string[] = [];
  const check = (label: string, argv: readonly string[]): void => {
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "-c" && argv[index] !== "--config") continue;
      const assignment = argv[index + 1] ?? "";
      const key = assignment.split("=")[0]!.trim();
      if (MEASURED_INERT.has(key)) {
        offenders.push(`${label}: ${key} is measured INERT (${MEASURED_INERT.get(key)!})`);
        continue;
      }
      if (!MEASURED_TO_APPLY.has(key)) {
        offenders.push(`${label}: ${key} has never been measured on this path`);
      }
    }
  };
  for (const agent of agentCatalogue) {
    if (agent.invoke !== null) check(agent.id, agent.invoke);
  }
  check("corpus", corpusInvoke("gpt-5.6-luna"));
  assert.deepEqual(offenders, [], `unmeasured or inert -c overrides: ${offenders.join("; ")}`);
});

/* And the one that is carried is carried on purpose: a Codex worker must not
   run the user's turn-event programs, and the measurement says this is how. */
test("a Codex invocation neutralises the user's notify chain rather than refusing it", () => {
  const codex = agentCatalogue.find((agent) => agent.harness === "codex-cli" && agent.invoke !== null);
  assert.ok(codex, "no connectable Codex entry");
  const argv = codex!.invoke!;
  const at = argv.findIndex((entry) => entry === "-c" || entry === "--config");
  assert.ok(at >= 0, "no -c override at all: the notify chain would run per turn");
  assert.equal(argv[at + 1], "notify=[]");
});

/* ── What CAN be forced off is forced off, not refused ────────────────────
 *
 * This was the opposite test until 2026-08-23: it asserted that a Codex config
 * carrying a `notify` chain refused the connection. The refusal was removed
 * because the override was measured to apply, and the refusal had two costs a
 * test cannot see -- it blocked every Codex model on every project for a
 * machine-wide setting, and its remedy was hand-editing a file on the flow
 * that exists so nobody has to.
 *
 * What is asserted now: a hostile notify chain no longer stops a connection,
 * and the mechanism that refuses genuinely unforceable settings is still
 * wired, still consulted before the probe, and empty on purpose. */
test("a notify chain no longer refuses a Codex connection, because it is neutralised per spawn", async () => {
  const repo = await repoWithProject();
  const home = await mkdtemp(path.join(tmpdir(), "hivemind-codex-home-"));
  const previous = process.env.CODEX_HOME;
  try {
    await initProjectForDesktop(repo);
    /* Exactly the shape that used to refuse: two chained programs. */
    await writeFile(
      path.join(home, "config.toml"),
      'notify = ["C:/Users/x/notify.exe", "turn-ended"]\n',
      "utf8"
    );
    process.env.CODEX_HOME = home;

    /* Nothing in the registry claims this any more. */
    assert.deepEqual(await findHostileHarnessSettings("codex-cli", home), []);

    /* And the connection gets PAST the hostile check: it fails in the probe,
       which is where a stub makes it fail, rather than being refused for the
       config file. */
    let probeRuns = 0;
    const attempted = await connectAdapter(repo, "worker", "codex-luna", {
      /* A FAILING probe result, not a throw: a throw escapes `connectAdapter`
         and the assertions below never run, which is how the first version of
         this test reported a failure that was its own. */
      runner: async () => {
        probeRuns += 1;
        return {
          ok: false,
          reason: "probe stub: no provider was called",
          stdout: "",
          stderr: "",
          exitCode: 1,
          timedOut: false,
          wallTimeMs: 1,
          effectiveTokens: 0,
          wroteNonceFile: false
        };
      }
    });
    assert.equal(attempted.ok, false);
    assert.equal(probeRuns, 1, "the connection never reached the probe");
    assert.doesNotMatch(
      attempted.ok ? "" : attempted.reason,
      /config\.toml/u,
      "a machine-wide setting is refusing a connection again"
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("the hostile-settings mechanism is still wired, and empty by intent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hivemind-empty-home-"));
  try {
    /* No harness declares anything, so every answer is empty rather than
       throwing -- an empty table must not become a broken code path. */
    for (const harness of ["codex-cli", "claude", "opencode", "grok"]) {
      assert.deepEqual(await findHostileHarnessSettings(harness, home), []);
    }
    /* Connect still consults it before the probe, so a future declaration
       refuses for free rather than needing the call site rebuilt. */
    const source = await readFile("src/config-actions.ts", "utf8");
    const connect = source.slice(source.indexOf("async function connectCatalogueAgent"));
    const hostileAt = connect.indexOf("findHostileHarnessSettings");
    const probeAt = connect.indexOf("await probeAdapter");
    assert.ok(hostileAt > 0, "connect no longer consults the hostile-settings table");
    assert.ok(hostileAt < probeAt, "the hostile check must run before the probe, not after");
  } finally {
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
