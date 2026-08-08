import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { generateBestOfN } from "../src/best-of-n.js";
import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { readQuotaLedger } from "../src/resource-ledger.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");

test("best-of-N generates two sequential routed drafts with provenance, cumulative accounting, and measurable distinction", async () => {
  await withBestOfNRepo(async ({ repo, tracePath }) => {
    const canonicalBefore = await canonicalIdentity(repo);
    const result = await generateBestOfN(repo, { task_id: "T-001", tool: "draft-fixture" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }

    assert.equal(result.value.requested_draft_count, 2);
    assert.equal(result.value.sequential, true);
    assert.deepEqual(result.value.drafts.map((draft) => draft.draft_id), ["D-001", "D-002"]);
    assert.deepEqual(result.value.drafts.map((draft) => draft.outcome), ["eligible", "eligible"]);
    assert.deepEqual(
      result.value.drafts.map((draft) => draft.provenance?.tool),
      ["draft-fixture", "draft-fixture"]
    );
    assert.deepEqual(
      result.value.drafts.map((draft) => draft.provenance?.usage_session_id),
      [result.value.quality_run_id, result.value.quality_run_id]
    );
    assert.ok(result.value.drafts.every((draft) => draft.provenance?.provider_tier === "strong"));
    assert.ok(result.value.drafts.every((draft) => draft.gate.disposer === "runGate"));
    assert.ok(result.value.drafts.every((draft) => draft.shadow.disposer === "runVerification"));

    const firstPatch = await readDraftPatch(repo, result.value.quality_run_id, "D-001");
    const secondPatch = await readDraftPatch(repo, result.value.quality_run_id, "D-002");
    assert.match(firstPatch, /export function value/u);
    assert.match(secondPatch, /export class ValueProvider/u);
    assert.doesNotMatch(secondPatch, /export function value/u);

    const trace = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/u);
    assert.deepEqual(trace, ["start:D-001", "end:D-001", "start:D-002", "end:D-002"]);

    assert.equal(result.value.distinctness.prompt_diversity_strategy, "prior-draft contrast framing");
    assert.equal(result.value.distinctness.provider_specific_seed_or_temperature, false);
    assert.equal(result.value.distinctness.human_judgment_required, true);
    assert.equal(result.value.distinctness.pairs.length, 1);
    assert.equal(result.value.distinctness.pairs[0].exact_patch_match, false);
    assert.ok(result.value.distinctness.pairs[0].changed_line_set_jaccard_similarity < 1);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(
            repo,
            ".hivemind",
            "resource",
            "quality-runs",
            result.value.quality_run_id,
            "distinctness.json"
          ),
          "utf8"
        )
      ),
      result.value.distinctness
    );

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
    if (ledger.ok) {
      assert.equal(ledger.value["draft-fixture"].self_measured.requests, 2);
      assert.equal(
        ledger.value["draft-fixture"].session_usage[result.value.quality_run_id].requests,
        2
      );
      assert.ok(
        ledger.value["draft-fixture"].session_usage[result.value.quality_run_id].effective_tokens > 0
      );
    }

    assert.deepEqual(await canonicalIdentity(repo), canonicalBefore);
    await assertOnlyMainCheckoutAndBranch(repo);
    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
    if (events.ok) {
      assert.equal(
        events.value.some((event) =>
          event.type === "task.completed" ||
          event.type === "patch.accepted" ||
          event.type === "integration.passed"
        ),
        false
      );
      assert.equal(
        events.value.filter((event) => event.type === "quality.draft_disposed").length,
        2
      );
    }
  });
});

test("best-of-N enforces count, admission, and tier routing before any provider spawn", async () => {
  await withBestOfNRepo(async ({ repo, tracePath, agentPath }) => {
    const tooFew = await generateBestOfN(repo, { task_id: "T-001", n: 1, tool: "draft-fixture" });
    const tooMany = await generateBestOfN(repo, { task_id: "T-001", n: 4, tool: "draft-fixture" });
    assert.equal(tooFew.ok, false);
    assert.equal(tooMany.ok, false);
    if (!tooFew.ok) {
      assert.match(tooFew.reason, /integer from 2 through 3/);
    }
    if (!tooMany.ok) {
      assert.match(tooMany.reason, /integer from 2 through 3/);
    }
    await assertMissing(tracePath);

    await writeContract(repo, await gitStdout(repo, ["rev-parse", "HEAD"]), {
      allowed_files: ["README.md"],
      allowed_file_intents: { "README.md": "modify" }
    });
    await updateConfig(repo, (config) => {
      config.low_globs = ["README.md"];
    });
    const low = await generateBestOfN(repo, { task_id: "T-001", tool: "draft-fixture" });
    assert.equal(low.ok, false);
    if (!low.ok) {
      assert.match(low.reason, /Low-tier tasks are never admitted/);
    }
    await assertMissing(tracePath);

    await updateConfig(repo, (config) => {
      config.low_globs = [];
    });
    await writeContract(repo, await gitStdout(repo, ["rev-parse", "HEAD"]));
    await writeProfile(repo, "weak-fixture", agentPath, tracePath, {
      routingTier: "cheap"
    });
    const belowTier = await generateBestOfN(repo, { task_id: "T-001", tool: "weak-fixture" });
    assert.equal(belowTier.ok, false);
    if (!belowTier.ok) {
      assert.match(belowTier.reason, /below required floor/);
    }
    await assertMissing(tracePath);

    await writeProfile(repo, "dangerous-fixture", agentPath, tracePath, {
      routingTier: "strong",
      extraInvokeArgs: ["--dangerously-bypass-approvals-and-sandbox"]
    });
    const dangerous = await generateBestOfN(repo, {
      task_id: "T-001",
      tool: "dangerous-fixture"
    });
    assert.equal(dangerous.ok, false);
    if (!dangerous.ok) {
      assert.match(dangerous.reason, /dangerous invocation flags/);
    }
    await assertMissing(tracePath);

    const maximum = await generateBestOfN(repo, {
      task_id: "T-001",
      n: 3,
      tool: "draft-fixture"
    });
    assert.equal(maximum.ok, true, maximum.ok ? undefined : maximum.reason);
    if (maximum.ok) {
      assert.deepEqual(
        maximum.value.drafts.map((draft) => draft.draft_id),
        ["D-001", "D-002", "D-003"]
      );
    }
  });
});

test("best-of-N checks the shared session ceiling before the second call", async () => {
  await withBestOfNRepo(async ({ repo, tracePath, agentPath }) => {
    await updateConfig(repo, (config) => {
      config.resource_policy = {
        run_ceiling: { tokens: 3_100 },
        session_ceiling: { tokens: 6_000 }
      };
    });
    await writeProfile(repo, "metered-fixture", agentPath, tracePath, {
      routingTier: "strong",
      usageTokens: 3_000
    });

    const result = await generateBestOfN(repo, {
      task_id: "T-001",
      n: 2,
      tool: "metered-fixture"
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /draft D-002 provider execution stopped the quality run/);
      assert.match(result.reason, /token budget exceeded/);
      assert.ok(result.quality_run_id);
      if (result.quality_run_id !== undefined) {
        assert.equal(
          await pathExists(
            path.join(
              repo,
              ".hivemind",
              "resource",
              "quality-runs",
              result.quality_run_id,
              "drafts",
              "D-001",
              "manifest.json"
            )
          ),
          true
        );
        assert.equal(
          await pathExists(
            path.join(
              repo,
              ".hivemind",
              "resource",
              "quality-runs",
              result.quality_run_id,
              "drafts",
              "D-002"
            )
          ),
          true
        );
        const ledger = await readQuotaLedger(repo);
        assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
        if (ledger.ok) {
          assert.equal(
            ledger.value["metered-fixture"].session_usage[result.quality_run_id].requests,
            1
          );
          assert.equal(
            ledger.value["metered-fixture"].session_usage[result.quality_run_id].effective_tokens,
            3_000
          );
        }
      }
    }
    assert.deepEqual(
      (await readFile(tracePath, "utf8")).trim().split(/\r?\n/u),
      ["start:D-001", "end:D-001"]
    );
    await assertOnlyMainCheckoutAndBranch(repo);
  });
});

test("adapter failure is preserved as an immutable draft and detached checkout cleanup still holds", async () => {
  await withBestOfNRepo(async ({ repo, tracePath, agentPath }) => {
    await writeProfile(repo, "crash-fixture", agentPath, tracePath, {
      routingTier: "strong",
      mode: "crash"
    });
    const canonicalBefore = await canonicalIdentity(repo);
    const result = await generateBestOfN(repo, {
      task_id: "T-001",
      n: 2,
      tool: "crash-fixture"
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /provider execution stopped/);
      assert.ok(result.quality_run_id);
      if (result.quality_run_id !== undefined) {
        const manifest = JSON.parse(
          await readFile(
            path.join(
              repo,
              ".hivemind",
              "resource",
              "quality-runs",
              result.quality_run_id,
              "drafts",
              "D-001",
              "manifest.json"
            ),
            "utf8"
          )
        ) as Record<string, unknown>;
        assert.equal(manifest.outcome, "producer_crashed");
        assert.equal(
          await pathExists(
            path.join(
              repo,
              ".hivemind",
              "resource",
              "quality-runs",
              result.quality_run_id,
              "drafts",
              "D-002"
            )
          ),
          false
        );
      }
    }
    assert.deepEqual(await canonicalIdentity(repo), canonicalBefore);
    await assertOnlyMainCheckoutAndBranch(repo);
  });
});

test("best-of-N is on-demand only and structurally reuses admission, routing, adapter, ledger, and M7.7b disposal", async () => {
  const proposer = await readFile(path.join(projectRoot, "src", "best-of-n.ts"), "utf8");
  const provider = await readFile(path.join(projectRoot, "src", "quality-provider.ts"), "utf8");
  const cli = await readFile(path.join(projectRoot, "src", "cli.ts"), "utf8");
  assert.match(proposer, /await admitValueQuality\(/u);
  assert.match(proposer, /await authorizeValueQualityCall\(/u);
  assert.match(proposer, /await runQualityProvider\(/u);
  assert.match(proposer, /await disposeSpeculativeDraft\(/u);
  assert.doesNotMatch(proposer, /runGate|runShadowVerification|from "\.\/lease/u);
  assert.match(provider, /await runAdapterProcess\(/u);
  assert.match(provider, /processResult\.value\.quotaRequest/u);
  assert.match(cli, /rest\[0\] === "best-of-n"/u);

  for (const file of ["manager.ts", "daemon.ts", "mcp.ts"]) {
    const source = await readFile(path.join(projectRoot, "src", file), "utf8");
    assert.doesNotMatch(source, /best-of-n|generateBestOfN/u, `${file} must not auto-launch best-of-N`);
  }
});

async function withBestOfNRepo(
  run: (fixture: {
    repo: string;
    baseCommit: string;
    agentPath: string;
    tracePath: string;
  }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-best-of-n-"));
  const agentPath = `${repo}.draft-agent.mjs`;
  const tracePath = `${repo}.trace.log`;
  try {
    await writeFixtureAgent(agentPath);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, ".gitignore"), ".hivemind/\n");
    await writeFile(path.join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "value.js"), "export const value = 'base';\n");
    await writeFile(
      path.join(repo, "test", "smoke.test.js"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('smoke', () => assert.ok(true));\n"
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "best-of-n fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    assert.equal(await initProject(repo), 0);
    await updateConfig(repo, (config) => {
      // Declare the tier these cases exercise. Every scenario here is about
      // High-tier behaviour: High is the tier value-quality admits without a
      // promoted policy, and the "below required floor" refusal is the High
      // provider floor. Init's default globs put src/** in Medium, so the
      // High intent has to be stated rather than inherited from the
      // unmatched-path fallback.
      config.high_globs = ["src/**"];
      config.test_command = "node --check src/value.js";
      config.verification = {
        checks: [
          {
            id: "syntax",
            command: "node --check src/value.js",
            entry_files: ["src/value.js"]
          }
        ]
      };
    });
    await writeContract(repo, baseCommit);
    await writeProfile(repo, "draft-fixture", agentPath, tracePath, {
      routingTier: "strong"
    });
    await seedCanonicalSentinels(repo);
    await run({ repo, baseCommit, agentPath, tracePath });
  } finally {
    await cleanupRepo(repo);
    await rm(agentPath, { force: true });
    await rm(tracePath, { force: true });
  }
}

async function writeFixtureAgent(agentPath: string): Promise<void> {
  await writeFile(
    agentPath,
    [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "const [tracePath, mode = 'normal', usage = '0'] = process.argv.slice(2);",
      "const prompt = readFileSync(0, 'utf8');",
      "const match = prompt.match(/Draft identity: (D-00[1-3])/u);",
      "if (match === null) process.exit(9);",
      "const draftId = match[1];",
      "appendFileSync(tracePath, `start:${draftId}\\n`);",
      "if (mode === 'crash') {",
      "  writeFileSync('src/value.js', \"export const value = 'partial';\\n\");",
      "  process.stderr.write('fixture provider crashed\\n');",
      "  process.exit(7);",
      "}",
      "if (draftId === 'D-001') {",
      "  writeFileSync('src/value.js', \"export function value() { return 'first'; }\\n\");",
      "} else if (draftId === 'D-002') {",
      "  if (!prompt.includes(\"export function value() { return 'first'; }\")) process.exit(8);",
      "  writeFileSync('src/value.js', \"export class ValueProvider { read() { return 'second'; } }\\nexport const value = new ValueProvider().read();\\n\");",
      "} else {",
      "  if (!prompt.includes('export class ValueProvider')) process.exit(8);",
      "  writeFileSync('src/value.js', \"const values = new Map([['current', 'third']]);\\nexport const value = values.get('current');\\n\");",
      "}",
      "appendFileSync(tracePath, `end:${draftId}\\n`);",
      "const total = Number(usage);",
      "if (total > 0) {",
      "  process.stdout.write(`${JSON.stringify({ usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } })}\\n`);",
      "} else {",
      "  process.stdout.write(`fixture completed ${draftId}\\n`);",
      "}"
    ].join("\n"),
    "utf8"
  );
}

async function writeProfile(
  repo: string,
  tool: string,
  agentPath: string,
  tracePath: string,
  options: {
    routingTier: "local" | "cheap" | "standard" | "strong";
    mode?: "normal" | "crash";
    usageTokens?: number;
    extraInvokeArgs?: string[];
  }
): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`),
    `${JSON.stringify({
      tool,
      invoke: [
        process.execPath,
        agentPath,
        tracePath,
        options.mode ?? "normal",
        String(options.usageTokens ?? 0),
        ...(options.extraInvokeArgs ?? [])
      ],
      prompt_arg: "stdin",
      verified_on: "fixture-node",
      context_window: 100_000,
      timeout_ms: 5_000,
      routing_tier: options.routingTier,
      cost_rank: 1,
      ...(options.usageTokens === undefined ? {} : { usage_parser: "codex-jsonl" })
    }, null, 2)}\n`,
    "utf8"
  );
}

async function writeContract(
  repo: string,
  baseCommit: string,
  overrides: Partial<Record<string, unknown>> = {}
): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "tasks", "T-001.contract.json"),
    `${JSON.stringify({
      task_id: "T-001",
      title: "Implement a value provider",
      agent_role: "builder",
      routing_task_type: "refactor",
      base_commit: baseCommit,
      acceptance_criterion: "The value module remains syntactically valid.",
      allowed_files: ["src/value.js"],
      allowed_file_intents: { "src/value.js": "modify" },
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node --check src/value.js"],
      patch_requirements: [],
      ...overrides
    }, null, 2)}\n`,
    "utf8"
  );
}

async function updateConfig(
  repo: string,
  update: (config: Record<string, any>) => void
): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
  update(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function seedCanonicalSentinels(repo: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "worktrees", "T-001"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "patches", "T-001"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
  await mkdir(path.join(repo, ".hivemind", "log", "tasks"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "worktrees", "T-001", "sentinel.txt"), "canonical worktree\n");
  await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "sentinel.txt"), "canonical patch bundle\n");
  await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), "{\"version\":1,\"leases\":[]}\n");
  await writeFile(path.join(repo, ".hivemind", "canon", "sentinel.json"), "{\"canon\":true}\n");
  await writeFile(path.join(repo, ".hivemind", "log", "tasks", "T-001.output.jsonl"), "{\"output\":\"canonical\"}\n");
}

async function canonicalIdentity(repo: string): Promise<Record<string, string>> {
  return {
    head: await gitStdout(repo, ["rev-parse", "HEAD"]),
    status: await gitRawStdout(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    branches: await gitRawStdout(repo, ["branch", "--format=%(refname)"]),
    source: await hashTree(path.join(repo, "src")),
    canonical_worktree: await hashTree(path.join(repo, ".hivemind", "worktrees", "T-001")),
    patch_bundle: await hashTree(path.join(repo, ".hivemind", "patches", "T-001")),
    lease_store: await hashTree(path.join(repo, ".hivemind", "leases")),
    canon: await hashTree(path.join(repo, ".hivemind", "canon")),
    task_output: await hashTree(path.join(repo, ".hivemind", "log", "tasks"))
  };
}

async function readDraftPatch(repo: string, qualityRunId: string, draftId: string): Promise<string> {
  return readFile(
    path.join(
      repo,
      ".hivemind",
      "resource",
      "quality-runs",
      qualityRunId,
      "drafts",
      draftId,
      "diff.patch"
    ),
    "utf8"
  );
}

async function hashTree(root: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      digest.update(`${relative}\0${entry.isDirectory() ? "dir" : "file"}\0`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        digest.update(await readFile(absolute));
      }
    }
  };
  await visit(root);
  return digest.digest("hex");
}

async function assertOnlyMainCheckoutAndBranch(repo: string): Promise<void> {
  const worktrees = (await gitRawStdout(repo, ["worktree", "list", "--porcelain"]))
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1);
  assert.equal(path.resolve(worktrees[0].slice("worktree ".length)), path.resolve(repo));
  assert.deepEqual(
    (await gitRawStdout(repo, ["branch", "--format=%(refname:short)"]))
      .split(/\r?\n/u)
      .filter(Boolean),
    ["main"]
  );
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function cleanupRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitRawStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/u)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (path.resolve(worktreePath) !== path.resolve(repo)) {
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
  return result.stdout;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
