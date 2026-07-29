import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import { loadConfig, type HivemindConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import { reviewMemoryProposalInteractively } from "../src/memory-review.js";
import { rebuildRepoGraph, repoGraphArtifactPath } from "../src/repo-graph.js";
import { runVerification, selectVerificationChecks } from "../src/verification.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

test("localized verification runs fewer checks and still catches the regression", async () => {
  await withVerificationRepo(async ({ repo, worktree, config }) => {
    await writeFile(path.join(worktree, "src", "math.js"), "export const add = (a, b) => a - b;\n");

    const result = await runVerification(repo, worktree, config, ["T-LOW"], ["src/math.js"]);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.audit.mode, "subset");
    assert.deepEqual(result.value.audit.selected_checks.map((check) => check.id), ["math"]);
    assert.deepEqual(result.value.audit.skipped_checks, [
      { id: "text", reason: "outside the resolved impact set" }
    ]);
    assert.equal(result.value.checks.length, 1);
    assert.equal(result.value.checks[0].exit_code, 1);
    assert.equal(result.value.tests, "fail");

    await assert.rejects(
      execAsync(config.test_command, { cwd: worktree, windowsHide: true }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === 1
    );

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      const audit = events.value.at(-1);
      assert.equal(audit?.type, "verification.completed");
      assert.equal(audit?.data.mode, "subset");
      assert.deepEqual(audit?.data.skipped_checks, [
        { id: "text", reason: "outside the resolved impact set" }
      ]);
      assert.equal(audit?.data.tests, "fail");
    }
  });
});

test("KNOWN LIMITATION: an implicit CLI contract can fail outside the graph-selected subset", async () => {
  await withVerificationRepo(async ({ repo, worktree, config }) => {
    const baseMath = [
      "export const add = (a, b) => a + b;",
      "export const cliLabel = 'stable';",
      ""
    ].join("\n");
    const brokenMath = baseMath.replace("cliLabel = 'stable'", "cliLabel = 'broken'");
    const cliContractTest = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { execFileSync } from 'node:child_process';",
      "test('math CLI label', () => {",
      "  const script = \"import('./src/math.js').then(module => process.stdout.write(module.cliLabel))\";",
      "  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();",
      "  assert.equal(output, 'stable');",
      "});",
      ""
    ].join("\n");
    await writeFile(path.join(repo, "src", "math.js"), baseMath);
    await writeFile(path.join(repo, "test", "cli-contract.test.js"), cliContractTest);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "add implicit CLI contract"]);
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeFile(path.join(worktree, "src", "math.js"), brokenMath);
    await writeFile(path.join(worktree, "test", "cli-contract.test.js"), cliContractTest);

    const limitationConfig: HivemindConfig = {
      ...config,
      test_command: [
        "node --test test/math.test.js",
        "node --test test/text.test.js",
        "node test/cli-contract.test.js"
      ].join(" && "),
      verification: {
        checks: [
          ...config.verification!.checks,
          {
            id: "cli-contract",
            command: "node test/cli-contract.test.js",
            entry_files: ["test/cli-contract.test.js"]
          }
        ]
      }
    };
    const narrowed = await runVerification(
      repo,
      worktree,
      limitationConfig,
      ["T-LOW"],
      ["src/math.js"]
    );
    assert.equal(narrowed.ok, true);
    if (!narrowed.ok) {
      return;
    }
    assert.equal(narrowed.value.audit.mode, "subset");
    assert.deepEqual(narrowed.value.audit.selected_checks.map((check) => check.id), ["math"]);
    assert.deepEqual(
      narrowed.value.audit.skipped_checks.map((check) => check.id),
      ["text", "cli-contract"]
    );
    assert.equal(narrowed.value.tests, "pass");
    const runtimeContractValue = await execFileAsync(
      process.execPath,
      ["-e", "import('./src/math.js').then(module => process.stdout.write(module.cliLabel))"],
      { cwd: worktree, windowsHide: true }
    );
    assert.equal(runtimeContractValue.stdout, "broken");
    await assert.rejects(
      execAsync("node test/cli-contract.test.js", { cwd: worktree, windowsHide: true }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === 1
    );
    await assert.rejects(
      execAsync(limitationConfig.test_command, { cwd: worktree, windowsHide: true }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === 1
    );
  });
});

test("verification falls back to the full suite for graph uncertainty, blind spots, and high tiers", async () => {
  await withVerificationRepo(async ({ repo, config }) => {
    const localized = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assert.equal(localized.mode, "subset");

    const nonSource = await selectVerificationChecks(repo, config, ["T-LOW"], ["README.md"]);
    assertFull(nonSource, /non-JS\/TS/);

    const unknownSource = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/missing.js"]);
    assertFull(unknownSource, /cannot resolve changed file/);

    const invalidPath = await selectVerificationChecks(repo, config, ["T-LOW"], ["../outside.js"]);
    assertFull(invalidPath, /invalid or unconfined/);

    const disabled = await selectVerificationChecks(
      repo,
      { ...config, verification: { ...config.verification!, graph_enabled: false } },
      ["T-LOW"],
      ["src/math.js"]
    );
    assertFull(disabled, /disabled/);

    const missingEntry = await selectVerificationChecks(
      repo,
      {
        ...config,
        verification: {
          checks: config.verification!.checks.map((check) => check.id === "math"
            ? { ...check, entry_files: ["test/missing.test.js"] }
            : check)
        }
      },
      ["T-LOW"],
      ["src/math.js"]
    );
    assertFull(missingEntry, /declares missing or unresolvable entry file/);

    const high = await selectVerificationChecks(
      repo,
      { ...config, low_globs: [], high_globs: ["src/**"] },
      ["T-LOW"],
      ["src/math.js"]
    );
    assertFull(high, /high tier/);

    const critical = await selectVerificationChecks(
      repo,
      { ...config, low_globs: [], critical_globs: ["src/**"] },
      ["T-LOW"],
      ["src/math.js"]
    );
    assertFull(critical, /critical tier/);

    await rm(repoGraphArtifactPath(repo));
    const missing = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assertFull(missing, /graph unavailable.*missing/);

    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeFile(repoGraphArtifactPath(repo), "{not-json}\n");
    const invalid = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assertFull(invalid, /graph unavailable.*unreadable/);

    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeFile(path.join(repo, "src", "math.js"), "export const add = (a, b) => a + b + 1;\n");
    const stale = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assertFull(stale, /graph unavailable.*stale/);
  });
});

test("unresolved and dynamic imports force the full suite", async () => {
  await withVerificationRepo(async ({ repo, config }) => {
    await writeFile(
      path.join(repo, "test", "math.test.js"),
      "import('../src/' + process.env.MODULE); export const fixture = true;\n"
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "dynamic import"]);
    assert.equal((await rebuildRepoGraph(repo)).ok, true);

    const dynamic = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assertFull(dynamic, /dynamic import/);

    await writeFile(
      path.join(repo, "test", "math.test.js"),
      "import { add } from '../src/not-present.js'; console.log(add);\n"
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "unresolved import"]);
    assert.equal((await rebuildRepoGraph(repo)).ok, true);

    const unresolved = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assertFull(unresolved, /unresolved import/);
  });
});

test("only human-promoted Tier-2 verification history may add checks", async () => {
  await withVerificationRepo(async ({ repo, config }) => {
    const proposal = await proposeMemoryLesson(repo, {
      title: "Math changes exercise text serialization",
      lesson: "Run the text check when src/math.js changes.",
      evidence: ["integration fixture V-001"],
      verification_policy: {
        version: 1,
        mappings: [{ check_id: "text", paths: ["src/math.js"] }]
      }
    });
    assert.equal(proposal.ok, true);
    if (!proposal.ok) {
      return;
    }

    const unpromoted = await selectVerificationChecks(repo, config, ["T-LOW"], ["src/math.js"]);
    assert.equal(unpromoted.mode, "subset");
    assert.deepEqual(unpromoted.selected_checks.map((check) => check.id), ["math"]);
    assert.deepEqual(unpromoted.canon_ids, []);

    assert.equal((await runInteractiveReview(repo, proposal.value.proposal_id)).ok, true);
    const promoted = await selectVerificationChecks(
      repo,
      {
        ...config,
        verification: {
          checks: [
            ...config.verification!.checks,
            { id: "smoke", command: "node --check src/math.js", entry_files: ["src/smoke.js"] }
          ]
        }
      },
      ["T-LOW"],
      ["src/math.js"]
    );
    assert.equal(promoted.mode, "subset");
    assert.deepEqual(promoted.selected_checks.map((check) => check.id), ["math", "text"]);
    assert.deepEqual(promoted.canon_ids, [proposal.value.proposal_id]);
  });
});

async function withVerificationRepo(
  run: (context: { repo: string; worktree: string; config: HivemindConfig }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-verification-test-"));
  const worktree = await mkdtemp(path.join(tmpdir(), "hivemind-verification-worktree-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "math.js"), "export const add = (a, b) => a + b;\n");
    await writeFile(path.join(repo, "src", "text.js"), "export const upper = (value) => value.toUpperCase();\n");
    await writeFile(
      path.join(repo, "test", "math.test.js"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/math.js'; test('add', () => assert.equal(add(2, 3), 5));\n"
    );
    await writeFile(
      path.join(repo, "test", "text.test.js"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { upper } from '../src/text.js'; test('upper', () => assert.equal(upper('a'), 'A'));\n"
    );
    await writeFile(path.join(repo, "src", "smoke.js"), "export const smoke = true;\n");
    await writeFile(path.join(repo, "README.md"), "# Verification fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    assert.equal(await initProject(repo), 0);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-LOW", baseCommit);
    const config: HivemindConfig = {
      version: 1,
      stack: "typescript-node",
      repo_root: repo,
      test_command: "node -e \"Promise.all([import('./src/math.js'), import('./src/text.js')]).then(([m, t]) => { if (m.add(2, 3) !== 5 || t.upper('a') !== 'A') process.exit(1) })\"",
      allowed_globs: [],
      forbidden_globs: [],
      low_globs: ["src/**"],
      verification: {
        checks: [
          {
            id: "math",
            command: "node -e \"import('./src/math.js').then(m => { if (m.add(2, 3) !== 5) process.exit(1) })\"",
            entry_files: ["test/math.test.js"]
          },
          { id: "text", command: "node --test test/text.test.js", entry_files: ["test/text.test.js"] }
        ]
      }
    };
    await writeFile(path.join(repo, ".hivemind", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const loadedConfig = await loadConfig(repo);
    assert.equal(loadedConfig.ok, true);
    if (!loadedConfig.ok) {
      return;
    }
    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await cp(path.join(repo, "src"), path.join(worktree, "src"), { recursive: true });
    await cp(path.join(repo, "test"), path.join(worktree, "test"), { recursive: true });
    await run({ repo, worktree, config: loadedConfig.config });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
    await rm(worktree, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function writeContract(repo: string, taskId: string, baseCommit: string): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`),
    `${JSON.stringify({
      task_id: taskId,
      title: "Verify math",
      agent_role: "builder",
      routing_task_type: "testing",
      base_commit: baseCommit,
      acceptance_criterion: "The localized math test catches the regression.",
      allowed_files: ["src/math.js"],
      allowed_file_intents: { "src/math.js": "modify" },
      read_only_files: ["test/math.test.js"],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node --test test/math.test.js"],
      patch_requirements: []
    }, null, 2)}\n`
  );
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

function assertFull(audit: Awaited<ReturnType<typeof selectVerificationChecks>>, reason: RegExp): void {
  assert.equal(audit.mode, "full");
  assert.match(audit.reason, reason);
  assert.deepEqual(audit.selected_checks.map((check) => check.id), ["full-suite"]);
  assert.deepEqual(audit.skipped_checks, []);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim();
}
