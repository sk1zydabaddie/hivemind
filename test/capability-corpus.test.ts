import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  describeCapabilityCorpus,
  runCapabilityCorpus,
  validateCapabilityCorpusProfiles
} from "../src/capability-corpus.js";
import type { HivemindConfig } from "../src/config.js";
import type { TaskContract } from "../src/contract.js";
import { readQuotaLedgerState } from "../src/resource-ledger.js";
import { routeTaskProvider } from "../src/routing.js";

const execFileAsync = promisify(execFile);
const sourceRoot = process.cwd();

test("checked-in Codex profiles are explicit, confined tier pins and preserve routing floors", async () => {
  const validated = await validateCapabilityCorpusProfiles(sourceRoot);
  assert.equal(validated.ok, true, validated.ok ? undefined : validated.reason);
  if (!validated.ok) return;
  assert.deepEqual(
    validated.value.map(({ spec }) => [spec.tool, spec.model, spec.routing_tier, spec.cost_rank]),
    [
      ["codex-luna", "gpt-5.6-luna", "cheap", 4],
      ["codex-terra", "gpt-5.6-terra", "standard", 10],
      ["codex", "gpt-5.6-sol", "strong", 20]
    ]
  );

  await withHostRepo(async (repo) => {
    await installProfiles(repo, path.join(repo, "fake-bin", "codex.cmd"));
    const config = hostConfig(repo);
    const low = await routeTaskProvider(repo, routeContract("README.md"), config);
    const medium = await routeTaskProvider(repo, routeContract("src/library.mjs"), config);
    const high = await routeTaskProvider(repo, routeContract("src/cli.mjs"), config);
    const critical = await routeTaskProvider(repo, routeContract("src/gate.mjs"), config);

    assert.equal(low.ok, true, low.ok ? undefined : low.reason);
    assert.equal(medium.ok, true, medium.ok ? undefined : medium.reason);
    assert.equal(high.ok, true, high.ok ? undefined : high.reason);
    assert.equal(critical.ok, true, critical.ok ? undefined : critical.reason);
    if (low.ok && medium.ok && high.ok && critical.ok) {
      assert.equal(low.value.tool, "codex-luna");
      assert.equal(medium.value.tool, "codex-terra");
      assert.equal(high.value.tool, "codex");
      assert.equal(critical.value.tool, "codex");
    }
  });
});

test("capability corpus description is fixed, shadow-only, and dependency-aware", () => {
  const description = describeCapabilityCorpus();
  assert.equal(description.expected_provider_calls, 9);
  assert.equal(description.adoption, false);
  assert.equal(description.promotion, false);
  assert.deepEqual(description.tasks.map((task) => task.case_id), ["documentation", "library", "dependent_cli"]);
  assert.deepEqual(description.tasks[2].depends_on, ["T-002"]);
  assert.match(description.tasks[2].deterministic_validity_check, /dependent_cli/u);
  assert.equal(
    description.profiles.every((profile) => profile.price.cached_input_usd_per_million === profile.price.input_usd_per_million / 10),
    true
  );
});

test("fake Codex corpus uses the real disposer and exposes cost per successful task", async () => {
  await withHostRepo(async (repo) => {
    const fakeBin = path.join(repo, "fake-bin");
    const tracePath = path.join(fakeBin, "calls.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "fake-codex.mjs"), fakeCodexSource(tracePath), "utf8");
    await writeFile(
      path.join(fakeBin, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`,
      "utf8"
    );
    await installProfiles(repo, path.join(fakeBin, "codex.cmd"));

    const before = await protectedState(repo);
    const result = await runCapabilityCorpus(repo, { corpusRunId: "CC-FIXTURE" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;

    const report = result.value;
    assert.equal(report.advisory_only, true);
    assert.equal(report.shadow_only, true);
    assert.equal(report.routing_authority, false);
    assert.equal(report.attempts.length, 9);
    const calls = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(calls.length, 9);
    assert.deepEqual(calls.map((call) => call.task), [
      "T-001", "T-002", "T-003",
      "T-001", "T-002", "T-003",
      "T-001", "T-002", "T-003"
    ]);

    const lunaCli = report.attempts.find((attempt) => attempt.tool === "codex-luna" && attempt.task_id === "T-003");
    assert.notEqual(lunaCli, undefined);
    assert.equal(lunaCli?.status, "verification_failed");
    assert.equal(lunaCli?.gate?.verdict, "accept");
    assert.equal(lunaCli?.shadow_tests_passed, false);
    assert.equal(lunaCli?.validity_check_passed, false);
    const lunaChecks = lunaCli?.verification?.checks ?? [];
    assert.equal(lunaChecks.find((check) => check.id === "full-suite")?.exit_code, 0);
    assert.notEqual(lunaChecks.find((check) => check.id === "contract-validity:T-003")?.exit_code, 0);

    for (const tool of ["codex-terra", "codex"]) {
      const attempts = report.attempts.filter((attempt) => attempt.tool === tool);
      assert.equal(attempts.every((attempt) => attempt.success), true);
      const library = attempts.find((attempt) => attempt.task_id === "T-002");
      const cli = attempts.find((attempt) => attempt.task_id === "T-003");
      assert.notEqual(library?.dependency_base_commit, cli?.dependency_base_commit);
      assert.deepEqual(cli?.depends_on, ["T-002"]);
    }

    const luna = report.providers.find((provider) => provider.tool === "codex-luna");
    const terra = report.providers.find((provider) => provider.tool === "codex-terra");
    const sol = report.providers.find((provider) => provider.tool === "codex");
    assert.equal(luna?.success_count, 2);
    assert.equal(luna?.sol_fallback?.retry_count, 1);
    assert.equal(luna?.sol_fallback?.successful_task_count, 3);
    assert.equal(luna?.sol_fallback?.failed_task_retry_premiums[0].case_id, "dependent_cli");
    assert.notEqual(luna?.direct_cost_per_successful_task_usd, null);
    assert.notEqual(luna?.sol_fallback?.cost_per_successful_task_usd, null);
    assert.equal(terra?.success_count, 3);
    assert.equal(sol?.success_count, 3);
    assert.equal(report.providers.every((provider) => provider.provider_reported_attempt_count === 3), true);
    assert.equal(report.attempts.every((attempt) => attempt.provider_reported_usage?.reasoning_tokens === 10), true);
    assert.equal(report.attempts.every((attempt) => attempt.cache_economics?.cached_input_ratio === 0.2), true);
    assert.equal(report.providers.every((provider) => provider.cache_economics?.cached_input_ratio === 0.2), true);

    const ledger = await readQuotaLedgerState(repo);
    assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
    if (ledger.ok) {
      assert.equal(Object.values(ledger.value.providers).reduce((sum, entry) => sum + entry.self_measured.requests, 0), 9);
      assert.equal(Object.values(ledger.value.reservations).every((reservation) => reservation.status === "settled"), true);
    }
    assert.deepEqual(await protectedState(repo), before);
    assert.equal(await gitOutput(repo, ["status", "--short"]), "");

    const artifactRoot = path.join(repo, report.artifact_path);
    assert.equal((await stat(path.join(artifactRoot, "manifest.json"))).isFile(), true);
    assert.equal((await stat(path.join(artifactRoot, "report.json"))).isFile(), true);
    const traceBeforeRetry = await readFile(tracePath, "utf8");
    const duplicate = await runCapabilityCorpus(repo, { corpusRunId: "CC-FIXTURE" });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.ok ? "" : duplicate.reason, /already exists/u);
    assert.equal(await readFile(tracePath, "utf8"), traceBeforeRetry);
  });
});

test("capability corpus repeats one selected profile in fresh immutable iterations", async () => {
  await withHostRepo(async (repo) => {
    const fakeBin = path.join(repo, "fake-bin");
    const tracePath = path.join(fakeBin, "calls.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "fake-codex.mjs"), fakeCodexSource(tracePath), "utf8");
    await writeFile(
      path.join(fakeBin, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`,
      "utf8"
    );
    await installProfiles(repo, path.join(fakeBin, "codex.cmd"));

    const result = await runCapabilityCorpus(repo, {
      corpusRunId: "CC-REPETITION",
      tools: ["codex-luna"],
      iterations: 2
    });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;

    assert.deepEqual(result.value.selected_tools, ["codex-luna"]);
    assert.equal(result.value.iterations, 2);
    assert.equal(result.value.attempts.length, 6);
    assert.deepEqual(result.value.attempts.map((attempt) => attempt.iteration), [1, 1, 1, 2, 2, 2]);
    assert.deepEqual(result.value.providers.map((provider) => provider.tool), ["codex-luna"]);
    assert.equal(new Set(result.value.attempts.map((attempt) => attempt.artifact_path)).size, 6);
    assert.equal(result.value.attempts.every((attempt) => attempt.artifact_path.includes(`iteration-${String(attempt.iteration).padStart(3, "0")}`)), true);
    const calls = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.task), ["T-001", "T-002", "T-003", "T-001", "T-002", "T-003"]);
  });
});

test("capability corpus rejects unbounded or invalid repetition requests before spawn", async () => {
  await withHostRepo(async (repo) => {
    const fakeBin = path.join(repo, "fake-bin");
    const tracePath = path.join(fakeBin, "calls.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "fake-codex.mjs"), fakeCodexSource(tracePath), "utf8");
    await writeFile(
      path.join(fakeBin, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`,
      "utf8"
    );
    await installProfiles(repo, path.join(fakeBin, "codex.cmd"));

    for (const options of [
      { tools: ["codex-luna"], iterations: 0 },
      { tools: ["codex-luna"], iterations: 11 },
      { tools: ["codex-luna", "codex-luna"], iterations: 1 },
      { tools: ["codex-unknown"], iterations: 1 }
    ]) {
      const result = await runCapabilityCorpus(repo, options);
      assert.equal(result.ok, false);
    }
    assert.equal(await existsForTest(tracePath), false);
  });
});

test("capability corpus retains usage, cache economics, and overshoot evidence when output is refused", async () => {
  await withHostRepo(async (repo) => {
    const fakeBin = path.join(repo, "fake-bin");
    const tracePath = path.join(fakeBin, "calls.jsonl");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, "fake-codex.mjs"),
      fakeCodexSource(tracePath, {
        input_tokens: 1_800,
        cached_input_tokens: 1_440,
        output_tokens: 200,
        reasoning_output_tokens: 10
      }),
      "utf8"
    );
    await writeFile(
      path.join(fakeBin, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`,
      "utf8"
    );
    await installProfiles(repo, path.join(fakeBin, "codex.cmd"));
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.resource_policy = {
      run_ceiling: { tokens: 1_500 },
      session_ceiling: { tokens: 20_000 }
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = await runCapabilityCorpus(repo, { corpusRunId: "CC-OVERSHOOT" });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    const attempted = result.value.attempts.filter((attempt) => attempt.status !== "dependency_blocked");
    assert.equal(attempted.length, 6);
    assert.equal(attempted.every((attempt) => attempt.status === "adapter_failed"), true);
    assert.equal(attempted.every((attempt) => attempt.provider_reported_usage?.total_tokens === 2_000), true);
    assert.equal(attempted.every((attempt) => attempt.provider_reported_usage?.reasoning_tokens === 10), true);
    assert.equal(attempted.every((attempt) => attempt.cache_economics?.cached_input_ratio === 0.8), true);
    assert.equal(attempted.every((attempt) => attempt.budget_overshoot?.overshoot_tokens === 500), true);
    assert.equal(attempted.every((attempt) => attempt.cost_usd !== null), true);
    assert.equal(result.value.providers.every((provider) => provider.provider_reported_attempt_count === 2), true);
    assert.equal(result.value.providers.every((provider) => provider.total_effective_tokens === 4_000), true);
  });
});

async function withHostRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-capability-test-"));
  try {
    await git(repo, ["init", "--initial-branch=master"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, ".gitignore"), ".hivemind/\nfake-bin/\n", "utf8");
    await writeFile(path.join(repo, "README.md"), "# Host fixture\n", "utf8");
    await git(repo, ["add", ".gitignore", "README.md"]);
    await git(repo, ["commit", "-m", "seed host"]);
    for (const relative of ["adapters", "resource", "log", "tasks", "patches", "worktrees", "canon"]) {
      await mkdir(path.join(repo, ".hivemind", relative), { recursive: true });
    }
    await writeFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "", "utf8");
    await writeFile(path.join(repo, ".hivemind", "config.json"), `${JSON.stringify(hostConfig(repo), null, 2)}\n`, "utf8");
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function existsForTest(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function installProfiles(repo: string, fakeCodexPath: string): Promise<void> {
  await mkdir(path.dirname(fakeCodexPath), { recursive: true });
  for (const tool of ["codex-luna", "codex-terra", "codex"]) {
    const source = JSON.parse(await readFile(path.join(sourceRoot, ".hivemind", "adapters", `${tool}.profile.json`), "utf8"));
    const commandIndex = source.invoke.indexOf("codex.cmd");
    source.invoke[commandIndex] = fakeCodexPath;
    await writeFile(
      path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`),
      `${JSON.stringify(source, null, 2)}\n`,
      "utf8"
    );
  }
}

function hostConfig(repo: string): HivemindConfig {
  return {
    version: 1,
    stack: "typescript-node",
    repo_root: repo,
    base_branch: "master",
    test_command: "node --test",
    allowed_globs: [],
    forbidden_globs: [".hivemind/**"],
    low_globs: ["README.md"],
    medium_globs: ["src/library.mjs"],
    high_globs: ["src/cli.mjs"],
    critical_globs: ["src/gate.mjs"],
    resource_policy: {
      run_ceiling: { tokens: 150_000 },
      session_ceiling: { tokens: 500_000 }
    }
  };
}

function routeContract(file: string): TaskContract {
  return {
    task_id: "T-ROUTE",
    title: "Route fixture",
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: "0123456789012345678901234567890123456789",
    acceptance_criterion: "The route is selected.",
    allowed_files: [file],
    allowed_file_intents: { [file]: "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: [],
    patch_requirements: []
  };
}

async function protectedState(repo: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relative of [
    ".hivemind/log/events.jsonl",
    ".hivemind/canon",
    ".hivemind/patches",
    ".hivemind/worktrees"
  ]) {
    const absolute = path.join(repo, relative);
    result[relative] = (await stat(absolute)).isDirectory()
      ? (await gitOutput(repo, ["status", "--short", "--ignored", absolute])).trim()
      : await readFile(absolute, "utf8");
  }
  return result;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

function fakeCodexSource(
  tracePath: string,
  usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 50,
    reasoning_output_tokens: 10
  }
): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const task = /Task ID: (T-\\d+)/u.exec(prompt)?.[1];
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex < 0 ? "unknown" : process.argv[modelIndex + 1];
appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ task, model }) + "\\n");
if (task === "T-001") {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync("README.md", "utf8");
  writeFileSync("README.md", readme + "\\n## JSON record file format\\n\\nEach record requires string id and string name fields.\\n");
} else if (task === "T-002") {
  mkdirSync("src", { recursive: true });
  mkdirSync("test", { recursive: true });
  writeFileSync("src/sort-records.mjs", 'export function sortRecords(records) {\\n  return [...records].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));\\n}\\n');
  writeFileSync("test/sort-records.test.mjs", 'import test from "node:test";\\nimport assert from "node:assert/strict";\\nimport { sortRecords } from "../src/sort-records.mjs";\\ntest("sorts without mutation", () => { const input = [{ id: "2", name: "A" }, { id: "1", name: "A" }]; assert.deepEqual(sortRecords(input).map((x) => x.id), ["1", "2"]); assert.deepEqual(input.map((x) => x.id), ["2", "1"]); });\\n');
} else if (task === "T-003") {
  mkdirSync("src", { recursive: true });
  mkdirSync("test", { recursive: true });
  const flag = model.includes("luna") ? "--file" : "--input";
  writeFileSync("src/cli.mjs", 'import { readFile } from "node:fs/promises";\\nimport { sortRecords } from "./sort-records.mjs";\\nconst args = process.argv.slice(2);\\nconst index = args.indexOf("' + flag + '");\\nif (index < 0 || !args[index + 1]) { console.error("missing ' + flag + '"); process.exit(1); }\\nconst records = sortRecords(JSON.parse(await readFile(args[index + 1], "utf8")));\\nif (args.includes("--json")) console.log(JSON.stringify(records));\\nelse console.log(records.map((record) => record.name + " [" + record.id + "]").join("\\\\n"));\\n');
  writeFileSync("test/cli.test.mjs", 'import test from "node:test";\\nimport assert from "node:assert/strict";\\nimport { spawnSync } from "node:child_process";\\ntest("CLI emits JSON", () => { const result = spawnSync(process.execPath, ["src/cli.mjs", "' + flag + '", "fixtures/records.json", "--json"], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).map((x) => x.id), ["1", "2", "3"]); });\\n');
} else {
  throw new Error("unknown task in fixture prompt");
}
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fixture patch ready" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: ${JSON.stringify(usage)} }));
`;
}
