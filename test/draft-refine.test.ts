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
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { generateDraftRefine } from "../src/draft-refine.js";
import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import { reviewMemoryProposalInteractively } from "../src/memory-review.js";
import { readPromotedValueQualityPolicy } from "../src/learned-routing.js";
import { readQuotaLedger } from "../src/resource-ledger.js";
import { useOnlyFixtureAdapterProfiles } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");

test("draft-refine routes cheap then strong, grounds critique in real evidence, and leaves deterministic selection advisory", async () => {
  await withDraftRefineRepo(async ({ repo, tracePath }) => {
    const canonicalBefore = await canonicalIdentity(repo);
    const result = await generateDraftRefine(repo, { task_id: "T-001" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }

    assert.equal(result.value.sequential, true);
    assert.equal(result.value.draft.draft_id, "D-001");
    assert.equal(result.value.refinement.draft_id, "R-001");
    assert.equal(result.value.draft.provenance?.tool, "cheap-fixture");
    assert.equal(result.value.draft.provenance?.provider_tier, "standard");
    assert.equal(result.value.refinement.provenance?.tool, "strong-fixture");
    assert.equal(result.value.refinement.provenance?.provider_tier, "strong");
    assert.equal(result.value.draft.provenance?.usage_session_id, result.value.quality_run_id);
    assert.equal(result.value.refinement.provenance?.usage_session_id, result.value.quality_run_id);
    assert.match(result.value.critique_rationale, /^REFINEMENT CRITIQUE:/u);
    assert.match(result.value.critique_rationale, /D-001 gate accepted and shadow passed/u);
    assert.match(result.value.critique_rationale, /input validation/u);

    assert.equal(result.value.draft.gate.disposer, "runGate");
    assert.equal(result.value.draft.gate.status, "accept");
    assert.equal(result.value.draft.shadow.disposer, "runVerification");
    assert.equal(result.value.draft.shadow.status, "pass");
    assert.equal(result.value.refinement.gate.disposer, "runGate");
    assert.equal(result.value.refinement.gate.status, "accept");
    assert.equal(result.value.refinement.shadow.disposer, "runVerification");
    assert.equal(result.value.refinement.shadow.status, "pass");
    assert.equal(result.value.distinctness.exact_patch_match, false);
    assert.equal(result.value.selection.strategy, "draft_refine");
    assert.equal(result.value.selection.selected_draft_id, "D-001");
    assert.deepEqual(result.value.selection.eligible_draft_ids, ["D-001", "R-001"]);
    assert.equal(result.value.report.refinement.received_actual_draft_patch, true);
    assert.equal(result.value.report.refinement.received_actual_gate_shadow_evidence, true);
    assert.equal(result.value.report.refinement.provider.routing_preference, "strongest");
    assert.equal(result.value.report.draft.provider.routing_preference, "cheapest");
    assert.equal(result.value.report.advisory_only, true);
    assert.equal(result.value.report.automatic_adoption, false);

    const trace = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/u);
    assert.deepEqual(trace, [
      "start:D-001:cheap",
      "end:D-001:cheap",
      "start:R-001:strong",
      "end:R-001:strong"
    ]);
    const refinementOutput = await readFile(
      path.join(repo, result.value.refinement.artifact_path, "output.jsonl"),
      "utf8"
    );
    assert.match(refinementOutput, /REFINEMENT CRITIQUE:/u);
    const report = JSON.parse(
      await readFile(
        path.join(
          repo,
          ".hivemind",
          "resource",
          "quality-runs",
          result.value.quality_run_id,
          "refinement.json"
        ),
        "utf8"
      )
    ) as Record<string, unknown>;
    assert.deepEqual(report, result.value.report);

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
    if (ledger.ok) {
      assert.equal(ledger.value["cheap-fixture"].self_measured.requests, 1);
      assert.equal(ledger.value["strong-fixture"].self_measured.requests, 1);
      assert.equal(
        ledger.value["cheap-fixture"].session_usage[result.value.quality_run_id].requests,
        1
      );
      assert.equal(
        ledger.value["strong-fixture"].session_usage[result.value.quality_run_id].requests,
        1
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
          event.type === "integration.queued" ||
          event.type === "integration.passed"
        ),
        false
      );
      assert.equal(
        events.value.filter((event) => event.type === "quality.draft_disposed").length,
        2
      );
      assert.equal(
        events.value.filter((event) => event.type === "quality.selection_decided").length,
        1
      );
      assert.equal(
        events.value.filter((event) => event.type === "quality.refinement_completed").length,
        1
      );
    }
  });
});

test("a failed refinement is ineligible and does not displace the passing original", async () => {
  await withDraftRefineRepo(async ({ repo, tracePath, agentPath }) => {
    await writeProfile(repo, "strong-fixture", agentPath, tracePath, {
      role: "strong",
      routingTier: "strong",
      costRank: 50,
      mode: "invalid"
    });
    const canonicalBefore = await canonicalIdentity(repo);
    const result = await generateDraftRefine(repo, { task_id: "T-001" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.draft.outcome, "eligible");
    assert.equal(result.value.refinement.outcome, "shadow_failed");
    assert.equal(result.value.selection.selected_draft_id, "D-001");
    assert.deepEqual(result.value.selection.eligible_draft_ids, ["D-001"]);
    assert.deepEqual(await canonicalIdentity(repo), canonicalBefore);
    await assertOnlyMainCheckoutAndBranch(repo);
  });
});

test("a crashed refiner is preserved as ineligible, the original wins, and cleanup still holds", async () => {
  await withDraftRefineRepo(async ({ repo, tracePath, agentPath }) => {
    await writeProfile(repo, "strong-fixture", agentPath, tracePath, {
      role: "strong",
      routingTier: "strong",
      costRank: 50,
      mode: "crash"
    });
    const canonicalBefore = await canonicalIdentity(repo);
    const result = await generateDraftRefine(repo, { task_id: "T-001" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.refinement.outcome, "producer_crashed");
    assert.equal(result.value.refinement.eligible_for_selection, false);
    assert.equal(result.value.selection.selected_draft_id, "D-001");
    assert.deepEqual(result.value.selection.eligible_draft_ids, ["D-001"]);
    assert.deepEqual(await canonicalIdentity(repo), canonicalBefore);
    await assertOnlyMainCheckoutAndBranch(repo);
  });
});

test("draft-refine authorizes the shared ceiling before the second call", async () => {
  await withDraftRefineRepo(async ({ repo, tracePath, agentPath }) => {
    await updateConfig(repo, (config) => {
      config.resource_policy.run_ceiling.tokens = 3_100;
      config.resource_policy.session_ceiling.tokens = 6_000;
    });
    await writeProfile(repo, "cheap-fixture", agentPath, tracePath, {
      role: "cheap",
      routingTier: "standard",
      costRank: 1,
      usageTokens: 3_000
    });

    const result = await generateDraftRefine(repo, { task_id: "T-001" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.draft.outcome, "eligible");
    assert.equal(result.value.refinement.outcome, "producer_crashed");
    assert.match(result.value.refinement.reason ?? "", /token budget exceeded/);
    assert.equal(result.value.selection.selected_draft_id, "D-001");
    assert.equal(
      await pathExists(
        path.join(repo, ".hivemind", "resource", "quality-runs", result.value.quality_run_id, "drafts", "D-001")
      ),
      true
    );
    assert.equal(
      await pathExists(
        path.join(repo, ".hivemind", "resource", "quality-runs", result.value.quality_run_id, "drafts", "R-001")
      ),
      true
    );
    assert.deepEqual(
      (await readFile(tracePath, "utf8")).trim().split(/\r?\n/u),
      ["start:D-001:cheap", "end:D-001:cheap"]
    );
    await assertOnlyMainCheckoutAndBranch(repo);
  });
});

test("draft-refine is on-demand only and structurally reuses admission, routing, provider, substrate, and selection", async () => {
  const source = await readFile(path.join(projectRoot, "src", "draft-refine.ts"), "utf8");
  const provider = await readFile(path.join(projectRoot, "src", "quality-provider.ts"), "utf8");
  const cli = await readFile(path.join(projectRoot, "src", "cli.ts"), "utf8");
  assert.match(source, /await admitValueQuality\(/u);
  assert.match(source, /await authorizeValueQualityCall\(/u);
  assert.match(source, /routingPreference: preference/u);
  assert.match(source, /await runQualityProvider\(/u);
  assert.match(source, /await disposeSpeculativeDraft\(/u);
  assert.match(source, /await selectQualityWinner\(/u);
  assert.doesNotMatch(
    source,
    /runGate|runShadowVerification|from "\.\/lease|requestLease|grantLease|releaseLease/u
  );
  assert.match(provider, /await runAdapterProcess\(/u);
  assert.match(provider, /processResult\.value\.quotaRequest/u);
  assert.match(cli, /rest\[0\] === "draft-refine"/u);
  for (const file of ["manager.ts", "daemon.ts", "mcp.ts", "integrate.ts"]) {
    const contents = await readFile(path.join(projectRoot, "src", file), "utf8");
    assert.doesNotMatch(
      contents,
      /generateDraftRefine|draftRefineCommand|quality\.refinement_completed/u,
      `${file} must not auto-launch or canonically consume draft-refine`
    );
  }
});

test("Low admission refuses draft-refine before any provider spawn", async () => {
  await withDraftRefineRepo(async ({ repo, tracePath }) => {
    await updateConfig(repo, (config) => {
      config.low_globs = ["src/value.js"];
      config.medium_globs = [];
    });
    const result = await generateDraftRefine(repo, { task_id: "T-001" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /Low-tier tasks are never admitted/);
    }
    await assertMissing(tracePath);
  });
});

async function withDraftRefineRepo(
  run: (fixture: {
    repo: string;
    baseCommit: string;
    agentPath: string;
    tracePath: string;
  }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-draft-refine-"));
  const agentPath = `${repo}.quality-agent.mjs`;
  const tracePath = `${repo}.trace.log`;
  try {
    await writeFixtureAgent(agentPath);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, ".gitignore"), ".hivemind/\n");
    await writeFile(path.join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "value.js"), "export const value = 'base';\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "draft-refine fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    assert.equal(await initProject(repo), 0);
    // This fixture declares its own two-provider set and asserts which one
    // each phase routes to, so init's planner and manager defaults have to go.
    await useOnlyFixtureAdapterProfiles(repo);
    await updateConfig(repo, (config) => {
      config.test_command = "node --check src/value.js";
      config.low_globs = [];
      config.medium_globs = ["src/value.js"];
      config.high_globs = [];
      config.critical_globs = [];
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
    await promoteRefactorPolicy(repo);
    await writeProfile(repo, "cheap-fixture", agentPath, tracePath, {
      role: "cheap",
      routingTier: "standard",
      costRank: 1
    });
    await writeProfile(repo, "strong-fixture", agentPath, tracePath, {
      role: "strong",
      routingTier: "strong",
      costRank: 50
    });
    await seedCanonicalSentinels(repo);
    await run({ repo, baseCommit, agentPath, tracePath });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
    await rm(agentPath, { force: true });
    await rm(tracePath, { force: true });
  }
}

async function writeFixtureAgent(agentPath: string): Promise<void> {
  await writeFile(
    agentPath,
    [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "const [tracePath, role, mode = 'normal', usage = '0'] = process.argv.slice(2);",
      "const prompt = readFileSync(0, 'utf8');",
      "const match = prompt.match(/Artifact identity: ([DR]-001)/u);",
      "if (match === null) process.exit(9);",
      "const draftId = match[1];",
      "appendFileSync(tracePath, `start:${draftId}:${role}\\n`);",
      "if (draftId === 'D-001') {",
      "  if (role !== 'cheap') process.exit(8);",
      "  writeFileSync('src/value.js', \"export function value(input) { return input ?? 'draft'; }\\n\");",
      "} else {",
      "  if (role !== 'strong') process.exit(8);",
      "  if (!prompt.includes(\"export function value(input) { return input ?? 'draft'; }\")) process.exit(7);",
      "  if (!prompt.includes('D-001 actual gate evidence:') || !prompt.includes('D-001 actual shadow evidence:')) process.exit(7);",
      "  if (!prompt.includes('\"status\":\"accept\"') || !prompt.includes('\"status\":\"pass\"')) process.exit(7);",
      "  if (mode === 'crash') {",
      "    writeFileSync('src/value.js', \"export const value = 'partial refinement';\\n\");",
      "    process.stderr.write('fixture refiner crashed\\n');",
      "    process.exit(7);",
      "  } else if (mode === 'invalid') {",
      "    writeFileSync('src/value.js', 'export const value = ;\\n');",
      "  } else {",
      "    writeFileSync('src/value.js', \"function normalize(input) { return typeof input === 'string' && input.length > 0 ? input : 'refined'; }\\nexport function value(input) { return normalize(input); }\\n\");",
      "  }",
      "}",
      "appendFileSync(tracePath, `end:${draftId}:${role}\\n`);",
      "const total = Number(usage);",
      "if (total > 0) {",
      "  process.stdout.write(`${JSON.stringify({ usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } })}\\n`);",
      "} else if (draftId === 'R-001') {",
      "  process.stdout.write('REFINEMENT CRITIQUE: D-001 gate accepted and shadow passed, but its broad nullish fallback lacks input validation; the refinement adds explicit string validation while preserving the scoped API.\\n');",
      "} else {",
      "  process.stdout.write('Draft completed.\\n');",
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
    role: "cheap" | "strong";
    routingTier: "standard" | "strong";
    costRank: number;
    mode?: "normal" | "invalid" | "crash";
    usageTokens?: number;
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
        options.role,
        options.mode ?? "normal",
        String(options.usageTokens ?? 0)
      ],
      prompt_arg: "stdin",
      verified_on: "fixture-node",
      context_window: 100_000,
      timeout_ms: 5_000,
      routing_tier: options.routingTier,
      cost_rank: options.costRank,
      ...(options.usageTokens === undefined ? {} : { usage_parser: "codex-jsonl" })
    }, null, 2)}\n`,
    "utf8"
  );
}

async function writeContract(repo: string, baseCommit: string): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "tasks", "T-001.contract.json"),
    `${JSON.stringify({
      task_id: "T-001",
      title: "Harden value normalization",
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
      patch_requirements: []
    }, null, 2)}\n`,
    "utf8"
  );
}

async function promoteRefactorPolicy(repo: string): Promise<void> {
  const status = await readPromotedValueQualityPolicy(repo);
  const proposal = await proposeMemoryLesson(repo, {
    title: "Value-quality admission policy",
    lesson: "Use explicit extra quality effort for human-reviewed error-prone task classes.",
    evidence: ["fixture policy evidence"],
    value_quality_policy: {
      version: 1,
      kind: "value_quality_policy",
      source_evidence_hash: status.current_evidence_hash,
      source_event_count: status.current_evidence_event_count,
      error_prone_routing_task_types: ["refactor"]
    }
  });
  if (!proposal.ok) {
    throw new Error(proposal.reason);
  }
  const promoted = await runInteractiveReview(repo, proposal.value.proposal_id);
  assert.equal(promoted.ok, true, promoted.ok ? undefined : promoted.reason);
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
    worktree: await hashTree(path.join(repo, ".hivemind", "worktrees", "T-001")),
    patch: await hashTree(path.join(repo, ".hivemind", "patches", "T-001")),
    leases: await hashTree(path.join(repo, ".hivemind", "leases")),
    canon: await hashTree(path.join(repo, ".hivemind", "canon")),
    output: await hashTree(path.join(repo, ".hivemind", "log", "tasks"))
  };
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).replaceAll("\\", "/");
      hash.update(relative);
      if (entry.isDirectory()) {
        await visit(full);
      } else {
        hash.update(await readFile(full));
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function assertOnlyMainCheckoutAndBranch(repo: string): Promise<void> {
  const worktrees = (await gitRawStdout(repo, ["worktree", "list", "--porcelain"]))
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1);
  assert.deepEqual(
    (await gitRawStdout(repo, ["branch", "--format=%(refname:short)"]))
      .trim()
      .split(/\r?\n/u),
    ["main"]
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout;
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

async function assertMissing(filePath: string): Promise<void> {
  assert.equal(await pathExists(filePath), false, `expected path to be absent: ${filePath}`);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
