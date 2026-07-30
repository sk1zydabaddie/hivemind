import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import * as generatorModule from "../src/characterization-generator.js";
import { writeContextPack } from "../src/context-pack.js";
import { appendEvent } from "../src/events.js";
import { initProject } from "../src/init.js";
import { readQuotaLedger } from "../src/resource-ledger.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const cliPath = path.join(projectRoot, "dist", "src", "cli.js");

test("on-demand generator writes in a disposable base checkout and M7.6c alone validates its candidate", async () => {
  await withGeneratorRepo(async ({ repo, baseCommit }) => {
    await writeAdapter(repo, "fake-characterizer", {
      requiredPromptFragments: [
        "Task contract and grounded scope:",
        `"base_commit": "${baseCommit}"`,
        "Repository-authored test-only paths:",
        "Task-bound M7.6a structural impact evidence:",
        "Task-bound M7.6b runtime changed-line evidence:",
        "Changed-file manifest:",
        "Context-pack reference: .hivemind/cache/context-packs/T-001.json"
      ],
      files: {
        "test/generated-characterization.test.js": [
          "import assert from 'node:assert/strict';",
          "import { value } from '../src/value.js';",
          "assert.equal(typeof value, 'number');",
          ""
        ].join("\n")
      }
    });
    const before = await protectedState(repo);

    const result = JSON.parse(
      (await runCli(repo, [
        "verify",
        "characterize",
        "T-001",
        "--tool",
        "fake-characterizer"
      ])).stdout
    ) as {
      task_id: string;
      candidate_id: string;
      tool: string;
      check_id: string;
      session_id: string;
      disposer: string;
      candidate: {
        artifact_path: string;
        classification: string;
        validation: {
          gate: { verdict: string };
          test_scope_source: string;
          configured_test_paths: string[];
        };
      };
    };

    assert.equal(result.task_id, "T-001");
    assert.equal(result.tool, "fake-characterizer");
    assert.equal(result.check_id, "candidate");
    assert.equal(result.session_id, "characterization-T-001");
    assert.equal(result.disposer, "M7.6c validateCharacterizationCandidate");
    assert.equal(result.candidate.classification, "valid_characterization");
    assert.equal(result.candidate.validation.gate.verdict, "accept");
    assert.equal(result.candidate.validation.test_scope_source, "verification.test_paths");
    assert.deepEqual(result.candidate.validation.configured_test_paths, ["test/**/*.test.js"]);

    const artifactRoot = path.join(repo, result.candidate.artifact_path);
    const candidatePatch = await readFile(path.join(artifactRoot, "candidate.patch"), "utf8");
    assert.match(candidatePatch, /test\/generated-characterization\.test\.js/u);
    assert.doesNotMatch(candidatePatch, /^diff --git a\/(?:\.hivemind|src\/)/mu);
    assert.equal((await stat(path.join(artifactRoot, "manifest.json"))).isFile(), true);
    assert.equal((await stat(path.join(artifactRoot, "validation.json"))).isFile(), true);
    assert.deepEqual(await protectedState(repo), before);

    const ledger = await readQuotaLedger(repo);
    assert.equal(ledger.ok, true);
    if (ledger.ok) {
      assert.equal(ledger.value["fake-characterizer"]?.self_measured.requests, 1);
      assert.equal(ledger.value["fake-characterizer"]?.last_request?.accounting_source, "self_measured");
    }
    const worktrees = await gitRawStdout(repo, ["worktree", "list", "--porcelain"]);
    assert.equal(worktrees.match(/^worktree /gmu)?.length, 1);
  });
});

test("a self-validating adapter claim and source edit cannot bypass M7.6c", async () => {
  await withGeneratorRepo(async ({ repo }) => {
    await writeAdapter(repo, "self-validator", {
      stdout: JSON.stringify({
        valid: true,
        classification: "valid_characterization",
        approved: true
      }),
      files: {
        "src/forbidden.js": "export const bypass = true;\n"
      }
    });

    const result = JSON.parse(
      (await runCli(repo, [
        "verify",
        "characterize",
        "T-001",
        "--tool",
        "self-validator"
      ])).stdout
    ) as {
      candidate: {
        classification: string;
        reason: string;
        validation: { gate: { verdict: string } };
      };
    };

    assert.equal(result.candidate.classification, "rejected");
    assert.equal(result.candidate.validation.gate.verdict, "reject");
    assert.match(result.candidate.reason, /candidate scope gate reject/iu);
    assert.equal(await exists(path.join(repo, "src", "forbidden.js")), false);
  });
});

test("unconfigured test paths refuse before adapter invocation and do not affect normal state", async () => {
  await withGeneratorRepo(async ({ repo }) => {
    await setVerificationConfig(repo, undefined);
    const marker = path.join(repo, ".hivemind", "adapter-invoked.marker");
    await writeAdapter(repo, "must-not-run", {
      marker,
      files: {
        "test/generated-characterization.test.js": "throw new Error('must not run');\n"
      }
    });

    await assertCliRejects(
      repo,
      ["verify", "characterize", "T-001", "--tool", "must-not-run"],
      /no configured test paths/
    );
    assert.equal(await exists(marker), false);
    assert.deepEqual(await readQuotaLedger(repo), { ok: true, value: {} });
    assert.equal(await exists(path.join(repo, ".hivemind", "resource", "oracle-candidates")), false);
    assert.equal(
      (await readFile(path.join(repo, "src", "value.js"), "utf8")).replace(/\r\n/gu, "\n"),
      "export const value = 1;\n"
    );
  });
});

test("run and session token ceilings refuse characterization before adapter spawn", async () => {
  for (const ceiling of [
    { resource_policy: { run_ceiling: { tokens: 0 }, session_ceiling: { tokens: 500_000 } }, name: "run" },
    { resource_policy: { run_ceiling: { tokens: 150_000 }, session_ceiling: { tokens: 0 } }, name: "session" }
  ]) {
    await withGeneratorRepo(async ({ repo }) => {
      await setResourcePolicy(repo, ceiling.resource_policy);
      const marker = path.join(repo, ".hivemind", `${ceiling.name}-ceiling-adapter.marker`);
      await writeAdapter(repo, `${ceiling.name}-ceiling-agent`, {
        marker,
        files: {
          "test/generated-characterization.test.js": "throw new Error('must not run');\n"
        }
      });

      await assertCliRejects(
        repo,
        ["verify", "characterize", "T-001", "--tool", `${ceiling.name}-ceiling-agent`],
        /token budget exceeded/
      );
      assert.equal(await exists(marker), false);
      assert.equal(await exists(path.join(repo, ".hivemind", "resource", "oracle-candidates")), false);
    });
  }
});

test("characterization refuses dangerous adapter profiles without an override path", async () => {
  await withGeneratorRepo(async ({ repo }) => {
    const marker = path.join(repo, ".hivemind", "dangerous-adapter.marker");
    await writeAdapter(repo, "dangerous-characterizer", {
      marker,
      files: {
        "test/generated-characterization.test.js": "throw new Error('must not run');\n"
      },
      extraInvokeArgs: ["--dangerously-skip-permissions"]
    });

    await assertCliRejects(
      repo,
      ["verify", "characterize", "T-001", "--tool", "dangerous-characterizer"],
      /dangerous invocation flags/
    );
    assert.equal(await exists(marker), false);
  });
});

test("generation has one disposer and no automatic daemon, manager, MCP, or integration path", async () => {
  assert.deepEqual(Object.keys(generatorModule), ["generateCharacterizationCandidate"]);
  const generatorSource = await readFile(path.join(projectRoot, "src", "characterization-generator.ts"), "utf8");
  assert.match(generatorSource, /validateCharacterizationCandidate\(repoRoot,/u);
  assert.doesNotMatch(generatorSource, /from "\.\/(?:gate|check-runner|integrate|memory-canon|memory-review)\.js"/u);
  assert.doesNotMatch(generatorSource, /writeJsonAtomic|oracle-candidates/u);

  const characterizationSource = await readFile(path.join(projectRoot, "src", "characterization.ts"), "utf8");
  assert.match(characterizationSource, /oracle-candidates/u);
  const callers = await sourceFilesContaining("validateCharacterizationCandidate(");
  assert.deepEqual(callers, [
    "src/characterization-generator.ts",
    "src/characterization.ts"
  ]);

  for (const sourceFile of ["src/daemon.ts", "src/integrate.ts", "src/manager.ts", "src/mcp.ts"]) {
    const source = await readFile(path.join(projectRoot, sourceFile), "utf8");
    assert.doesNotMatch(source, /characterization-generator|generateCharacterizationCandidate/u);
  }
  const integrateSource = await readFile(path.join(projectRoot, "src", "integrate.ts"), "utf8");
  assert.match(integrateSource, /automatic_generation_launched: false/u);
  const cliSource = await readFile(path.join(projectRoot, "src", "cli.ts"), "utf8");
  assert.match(cliSource, /command === "verify"/u);
  const verifySource = await readFile(path.join(projectRoot, "src", "verify.ts"), "utf8");
  assert.match(verifySource, /characterize <task-id> --tool <tool>/u);
});

interface GeneratorFixture {
  repo: string;
  baseCommit: string;
}

async function withGeneratorRepo(run: (fixture: GeneratorFixture) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-characterization-generator-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(repo, "src", "value.js"), "export const value = 1;\n");
    await writeFile(
      path.join(repo, "test", "smoke.test.js"),
      [
        "import assert from 'node:assert/strict';",
        "import { value } from '../src/value.js';",
        "assert.equal(value, 1);",
        ""
      ].join("\n")
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    assert.equal(await initProject(repo), 0);
    await setVerificationConfig(repo, ["test/**/*.test.js"]);
    await writeContract(repo, baseCommit);
    await writeTaskPatch(repo);
    await seedVerificationEvidence(repo);
    const contextPack = await writeContextPack(repo, {
      taskId: "T-001",
      baseCommit,
      tool: "fixture-scout",
      createdAt: "2026-07-29T00:00:00.000Z",
      reads: [],
      stdout: "The value module is exercised through test files.",
      stderr: ""
    });
    assert.equal(contextPack.ok, true);
    await mkdir(path.join(repo, ".hivemind", "worktrees", "T-001"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "worktrees", "T-001", "sentinel.txt"), "task worktree sentinel\n");
    await mkdir(path.join(repo, ".hivemind", "canon"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "canon", "sentinel.json"), '{"canon":true}\n');
    await run({ repo, baseCommit });
  } finally {
    await cleanupRepo(repo);
  }
}

async function setVerificationConfig(repo: string, testPaths: string[] | undefined): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.verification = {
    checks: [
      {
        id: "candidate",
        command: "node --test test/generated-characterization.test.js",
        entry_files: ["test/smoke.test.js"]
      }
    ],
    ...(testPaths === undefined ? {} : { test_paths: testPaths })
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function setResourcePolicy(
  repo: string,
  resourcePolicy: {
    run_ceiling: { tokens: number };
    session_ceiling: { tokens: number };
  }
): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.resource_policy = resourcePolicy;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeContract(repo: string, baseCommit: string): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "tasks", "T-001.contract.json"),
    `${JSON.stringify({
      task_id: "T-001",
      title: "Change exported value",
      agent_role: "builder",
      routing_task_type: "refactor",
      base_commit: baseCommit,
      acceptance_criterion: "The exported value changes.",
      allowed_files: ["src/value.js"],
      allowed_file_intents: { "src/value.js": "modify" },
      read_only_files: ["test/smoke.test.js"],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node --test test/smoke.test.js"],
      patch_requirements: []
    }, null, 2)}\n`
  );
}

async function writeTaskPatch(repo: string): Promise<void> {
  await writeFile(path.join(repo, "src", "value.js"), "export const value = 2;\n");
  const patch = await gitRawStdout(repo, ["diff", "--binary", "HEAD"]);
  await git(repo, ["checkout", "--", "src/value.js"]);
  const patchDir = path.join(repo, ".hivemind", "patches", "T-001");
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), patch);
}

async function seedVerificationEvidence(repo: string): Promise<void> {
  const result = await appendEvent(repo, {
    type: "verification.completed",
    task_id: null,
    data: {
      task_ids: ["T-001"],
      mode: "full",
      reason: "fixture oracle measurement",
      changed_files: ["src/value.js"],
      impact_set: ["src/value.js"],
      selected_checks: [
        {
          id: "candidate",
          command: "node --test test/generated-characterization.test.js",
          sources: ["inventory"]
        }
      ],
      skipped_checks: [],
      graph_fingerprint: "fixture",
      canon_ids: [],
      structural_oracle: {
        kind: "structural",
        status: "uncovered",
        advisory_only: true,
        runtime_coverage: "not_measured",
        graph_fingerprint: "fixture",
        impact_files: ["src/value.js"],
        covered_impact_files: [],
        uncovered_impact_files: ["src/value.js"],
        unknown_impact_files: [],
        check_associations: [{ impact_file: "src/value.js", check_ids: [] }],
        unknown_reasons: [],
        limitations: ["fixture inventory declaration"]
      },
      runtime_coverage: {
        kind: "runtime_changed_line",
        status: "weak",
        advisory_only: true,
        configured: true,
        uncovered_lines: [{ file: "src/value.js", line: 1, hits: 0 }],
        unknown_files: [],
        unknown_reasons: []
      },
      results: [],
      tests: "pass"
    }
  });
  assert.equal(result.ok, true);
}

async function writeAdapter(
  repo: string,
  tool: string,
  options: {
    files: Record<string, string>;
    requiredPromptFragments?: string[];
    stdout?: string;
    marker?: string;
    extraInvokeArgs?: string[];
  }
): Promise<void> {
  const scriptPath = path.join(repo, ".hivemind", "adapters", `${tool}.mjs`);
  const script = [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    "let prompt = '';",
    "for await (const chunk of process.stdin) prompt += chunk.toString('utf8');",
    ...((options.requiredPromptFragments ?? []).map(
      (fragment) =>
        `if (!prompt.includes(${JSON.stringify(fragment)})) { console.error(${JSON.stringify(`missing prompt fragment: ${fragment}`)}); process.exit(7); }`
    )),
    ...(options.marker === undefined
      ? []
      : [`await writeFile(${JSON.stringify(options.marker)}, "invoked\\n");`]),
    ...Object.entries(options.files).flatMap(([relativePath, content]) => [
      `await mkdir(path.dirname(${JSON.stringify(relativePath)}), { recursive: true });`,
      `await writeFile(${JSON.stringify(relativePath)}, ${JSON.stringify(content)});`
    ]),
    `console.log(${JSON.stringify(options.stdout ?? "candidate written")});`
  ].join("\n");
  await writeFile(scriptPath, `${script}\n`);
  await writeFile(
    path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`),
    `${JSON.stringify({
      tool,
      invoke: [process.execPath, scriptPath, ...(options.extraInvokeArgs ?? [])],
      prompt_arg: "stdin",
      verified_on: "2026-07-29",
      context_window: 100_000,
      routing_tier: "strong",
      cost_rank: 1
    }, null, 2)}\n`
  );
}

async function protectedState(repo: string): Promise<Record<string, string>> {
  return {
    head: await gitStdout(repo, ["rev-parse", "HEAD"]),
    source: await readFile(path.join(repo, "src", "value.js"), "utf8"),
    existingTest: await readFile(path.join(repo, "test", "smoke.test.js"), "utf8"),
    taskWorktree: await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "sentinel.txt"), "utf8"),
    canon: await readFile(path.join(repo, ".hivemind", "canon", "sentinel.json"), "utf8")
  };
}

async function sourceFilesContaining(needle: string): Promise<string[]> {
  const sourceDir = path.join(projectRoot, "src");
  const entries = await readdir(sourceDir);
  const matches: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".ts")).sort()) {
    if ((await readFile(path.join(sourceDir, entry), "utf8")).includes(needle)) {
      matches.push(`src/${entry}`);
    }
  }
  return matches;
}

async function runCli(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
}

async function assertCliRejects(repo: string, args: string[], pattern: RegExp): Promise<void> {
  await assert.rejects(
    runCli(repo, args),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.match(String((error as { stderr?: unknown }).stderr ?? ""), pattern);
      return true;
    }
  );
}

async function cleanupRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitRawStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/u)) {
      if (line.startsWith("worktree ")) {
        const worktreePath = line.slice("worktree ".length);
        if (path.resolve(worktreePath) !== path.resolve(repo)) {
          await git(repo, ["worktree", "remove", "--force", worktreePath]);
        }
      }
    }
  } catch {
    // Best-effort fixture cleanup before deleting its temporary repository.
  }
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
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
