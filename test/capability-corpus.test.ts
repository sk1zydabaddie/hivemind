import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import {
  describeCapabilityCorpus,
  runCapabilityCorpus,
  validateCapabilityCorpusProfiles
} from "../src/capability-corpus.js";
import { readVerifiedCapabilityCorpusReport } from "../src/capability-corpus-evidence.js";
import { corpusProfile, writeLocalAdapterProfiles } from "../src/local-adapters.js";
import type { HivemindConfig } from "../src/config.js";
import type { TaskContract } from "../src/contract.js";
import { readQuotaLedgerState } from "../src/resource-ledger.js";
import { appendEvent, readEvents } from "../src/events.js";
import {
  appendRoutingObservation,
  deriveLearnedRoutingPolicy,
  ingestCapabilityCorpusEvidence,
  proposeLearnedRoutingPolicy,
  readPromotedRoutingPolicy
} from "../src/learned-routing.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import { reviewMemoryProposalInteractively } from "../src/memory-review.js";
import { routeTaskProvider } from "../src/routing.js";

const execFileAsync = promisify(execFile);
const sourceRoot = process.cwd();

/**
 * The ladder is generated, not committed.
 *
 * These three profiles used to be checked in, which made the repository
 * platform-biased: they named `cmd.exe`, so a Linux clone held three profiles
 * it could never spawn, and nothing caught it until the suite ran on Linux. It
 * was also a profile on disk that no probe had checked -- the declaration
 * `project.init` already refuses to write.
 *
 * Core's `profileSpecs` still owns the pins, tiers and cost ranks; only the
 * argv is per-platform, and it is generated. This test therefore validates the
 * generator's output rather than a committed artefact, and asserts exactly the
 * same ladder it always did.
 */
test("the generated Codex ladder is explicit, confined tier pins and preserves routing floors", async () => {
  const generated = await mkdtemp(path.join(tmpdir(), "hivemind-ladder-"));
  await writeLocalAdapterProfiles(generated);
  const validated = await validateCapabilityCorpusProfiles(generated);
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
    await installProfiles(repo, (await installFakeCodex(repo)).command);
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
      /* Was `codex-terra` until 2026-08-23, when the Medium floor moved from
         `standard` to `cheap`. Updated deliberately rather than preserved: the
         old expectation encoded a floor that was measured to cost about five
         times over on the tier ordinary source changes land in, while effort
         -- the thing the pin was protecting -- spans only ~1.04x. The floors
         that matter are asserted immediately below and are unchanged. */
      assert.equal(medium.value.tool, "codex-luna");
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
    const { tracePath, command } = await installFakeCodex(repo);
    await installProfiles(repo, command);

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

    assert.equal((await ingestCapabilityCorpusEvidence(repo, report.corpus_run_id)).ok, true);
    const routingProposal = await proposeLearnedRoutingPolicy(repo);
    assert.equal(routingProposal.ok, true, routingProposal.ok ? undefined : routingProposal.reason);
    if (!routingProposal.ok) return;
    assert.equal((await runInteractiveReview(repo, routingProposal.value.proposal_id)).ok, true);
    const lowRoute = await routeTaskProvider(repo, routeContract("README.md", "documentation"), hostConfig(repo));
    const mediumRoute = await routeTaskProvider(repo, routeContract("src/library.mjs", "data_model"), hostConfig(repo));
    const highRoute = await routeTaskProvider(repo, routeContract("src/cli.mjs", "cli"), hostConfig(repo));
    assert.equal(lowRoute.ok, true, lowRoute.ok ? undefined : lowRoute.reason);
    assert.equal(mediumRoute.ok, true, mediumRoute.ok ? undefined : mediumRoute.reason);
    assert.equal(highRoute.ok, true, highRoute.ok ? undefined : highRoute.reason);
    if (lowRoute.ok && mediumRoute.ok && highRoute.ok) {
      assert.equal(lowRoute.value.tool, "codex-luna");
      /* Same floor change as above: Medium may now run on the cheap tier, and
         a learned policy still cannot promote past the High floor. */
      assert.equal(mediumRoute.value.tool, "codex-luna");
      assert.equal(highRoute.value.tool, "codex");
      assert.equal(lowRoute.value.learned_policy?.status, "applied");
      assert.equal(mediumRoute.value.learned_policy?.status, "applied");
      assert.equal(highRoute.value.learned_policy?.status, "applied");
    }
  });
});

test("capability corpus repeats one selected profile in fresh immutable iterations", async () => {
  await withHostRepo(async (repo) => {
    const { tracePath, command } = await installFakeCodex(repo);
    await installProfiles(repo, command);

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
    const { tracePath, command } = await installFakeCodex(repo);
    await installProfiles(repo, command);

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

test("registered corpus evidence is hash-bound, source-labeled, and cannot use an unrelated policy identity", async () => {
  await withHostRepo(async (repo) => {
    const { tracePath, command } = await installFakeCodex(repo);
    await installProfiles(repo, command);
    const corpus = await runCapabilityCorpus(repo, {
      corpusRunId: "CC-ROUTING-EVIDENCE",
      tools: ["codex-luna", "codex-terra"]
    });
    assert.equal(corpus.ok, true, corpus.ok ? undefined : corpus.reason);
    if (!corpus.ok) return;

    const unknownProvider = await ingestCapabilityCorpusEvidence(repo, corpus.value.corpus_run_id, ["missing-provider"]);
    assert.equal(unknownProvider.ok, false);
    const ingested = await ingestCapabilityCorpusEvidence(repo, corpus.value.corpus_run_id, ["codex-luna", "codex-terra"]);
    assert.equal(ingested.ok, true, ingested.ok ? undefined : ingested.reason);
    if (ingested.ok) {
      assert.deepEqual(ingested.value.included_providers, ["codex-luna", "codex-terra"]);
      assert.equal(ingested.value.attempt_count, 6);
    }
    const derived = await deriveLearnedRoutingPolicy(repo);
    assert.equal(derived.ok, true, derived.ok ? undefined : derived.reason);
    if (!derived.ok) return;
    assert.equal(derived.value.corpus_evidence.length, 1);
    assert.equal(derived.value.corpus_evidence[0].corpus_run_id, "CC-ROUTING-EVIDENCE");
    assert.equal(derived.value.source_event_count, 1);
    const documentation = derived.value.task_types.find((entry) => entry.routing_task_type === "documentation");
    assert.equal(documentation?.provenance.selected_source, "corpus_shadow");
    assert.equal(documentation?.provenance.production.sample_count, 0);
    assert.equal(documentation?.provenance.corpus_shadow.sample_count, 2);
    assert.equal(documentation?.providers[0].evidence_source, "corpus_shadow");
    assert.equal(documentation?.providers[0].integrated_count, 0);
    assert.equal((documentation?.providers[0].shadow_validated_diff_bytes ?? 0) > 0, true);
    assert.deepEqual(documentation?.providers[0].model_ids, ["gpt-5.6-luna"]);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.deepEqual(events.value.map((event) => event.type), ["routing.corpus_registered"]);
    }

    assert.equal((await appendRoutingObservation(repo, "T-PROD-LUNA", {
      version: 1,
      run_id: "production-luna",
      provider: "codex-luna",
      routing_task_type: "documentation",
      request_count: 1,
      wall_time_ms: 1_000,
      self_measured_tokens: 100,
      provider_reported_tokens: 1_000,
      effective_tokens: 1_000,
      cost_source: "provider_reported",
      diff_bytes: 100,
      exit_code: 1,
      timed_out: false,
      handoff_from: null
    })).ok, true);
    assert.equal((await appendEvent(repo, { type: "patch.rejected", task_id: "T-PROD-LUNA", data: { reason: "production failure" } })).ok, true);
    assert.equal((await appendEvent(repo, { type: "task.failed", task_id: "T-PROD-LUNA", data: { reason: "production failure" } })).ok, true);
    assert.equal((await appendRoutingObservation(repo, "T-PROD-TERRA", {
      version: 1,
      run_id: "production-terra",
      provider: "codex-terra",
      routing_task_type: "documentation",
      request_count: 1,
      wall_time_ms: 1_000,
      self_measured_tokens: 100,
      provider_reported_tokens: 1_000,
      effective_tokens: 1_000,
      cost_source: "provider_reported",
      diff_bytes: 100,
      exit_code: 0,
      timed_out: false,
      handoff_from: null
    })).ok, true);
    assert.equal((await appendEvent(repo, { type: "patch.accepted", task_id: "T-PROD-TERRA", data: { changed_files: ["README.md"] } })).ok, true);
    assert.equal((await appendEvent(repo, { type: "task.completed", task_id: "T-PROD-TERRA", data: {} })).ok, true);
    assert.equal((await appendEvent(repo, { type: "integration.passed", task_id: null, data: { applied: ["T-PROD-TERRA"] } })).ok, true);
    const compared = await deriveLearnedRoutingPolicy(repo);
    assert.equal(compared.ok, true, compared.ok ? undefined : compared.reason);
    if (!compared.ok) return;
    const comparedDocumentation = compared.value.task_types.find((entry) => entry.routing_task_type === "documentation");
    assert.equal(comparedDocumentation?.provenance.selected_source, "production");
    assert.equal(comparedDocumentation?.provenance.production.sample_count, 2);
    assert.equal(comparedDocumentation?.provenance.corpus_shadow.sample_count, 2);
    assert.equal(comparedDocumentation?.provenance.rankings_disagree, true);

    const unrelated = await proposeMemoryLesson(repo, {
      title: "Wrong corpus identity",
      lesson: "This policy must remain stale because its hash does not bind the cited corpus.",
      evidence: [`capability-corpus:${corpus.value.corpus_run_id}`],
      routing_policy: { ...compared.value, source_evidence_hash: "a".repeat(64) }
    });
    assert.equal(unrelated.ok, true, unrelated.ok ? undefined : unrelated.reason);
    if (!unrelated.ok) return;
    const refusedReview = await runInteractiveReview(repo, unrelated.value.proposal_id);
    assert.equal(refusedReview.ok, false);
    assert.match(refusedReview.ok ? "" : refusedReview.reason, /does not bind/u);
    const promoted = await readPromotedRoutingPolicy(repo);
    assert.equal(promoted.promoted, "absent");
    assert.equal(promoted.active_policy, null);
  });
});

test("tampering with a corpus report is refused by verification and routing derivation", async () => {
  await withHostRepo(async (repo) => {
    const { tracePath, command } = await installFakeCodex(repo);
    await installProfiles(repo, command);
    const corpus = await runCapabilityCorpus(repo, { corpusRunId: "CC-TAMPER", tools: ["codex-terra"] });
    assert.equal(corpus.ok, true, corpus.ok ? undefined : corpus.reason);
    if (!corpus.ok) return;
    assert.equal((await ingestCapabilityCorpusEvidence(repo, corpus.value.corpus_run_id)).ok, true);
    const reportPath = path.join(repo, corpus.value.artifact_path, "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.attempts[0].cost_usd += 1;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const verified = await readVerifiedCapabilityCorpusReport(repo, corpus.value.corpus_run_id);
    assert.equal(verified.ok, false);
    assert.match(verified.ok ? "" : verified.reason, /does not match its immutable result/u);
    const derived = await deriveLearnedRoutingPolicy(repo);
    assert.equal(derived.ok, false);
    assert.match(derived.ok ? "" : derived.reason, /does not match its immutable result/u);
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
    await installProfiles(repo, await fakeCodexCommand(fakeBin));
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

/**
 * A fake coding agent the corpus can actually run, on whichever OS is running
 * the suite.
 *
 * This used to write `codex.cmd` -- a batch shim -- and leave the profile's
 * `cmd.exe /d /s /c` prefix in place. That is unrunnable on Linux, so all four
 * corpus tests died on a missing trace file rather than on anything they were
 * testing. The shape of the fake has to match the platform, not the machine it
 * was first written on.
 */
async function installFakeCodex(repo: string): Promise<{ tracePath: string; command: string[] }> {
  const fakeBin = path.join(repo, "fake-bin");
  const tracePath = path.join(fakeBin, "calls.jsonl");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, "fake-codex.mjs"), fakeCodexSource(tracePath), "utf8");
  return { tracePath, command: await fakeCodexCommand(fakeBin) };
}

/**
 * The shim, and the argv that can actually start it. Split out because one
 * test writes its own `fake-codex.mjs` with different usage numbers and needs
 * the same platform decision without the default source.
 */
async function fakeCodexCommand(fakeBin: string): Promise<string[]> {
  if (process.platform === "win32") {
    const shim = path.join(fakeBin, "codex.cmd");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "utf8");
    /* Windows cannot spawn a .cmd directly, so the interpreter stays. */
    return ["cmd.exe", "/d", "/s", "/c", shim];
  }
  const shim = path.join(fakeBin, "codex");
  await writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.mjs" "$@"\n`,
    "utf8"
  );
  await chmod(shim, 0o755);
  return [shim];
}

/**
 * The profile ships a Windows invocation; the corpus needs the same profile
 * pointed at the fake agent with a command the running platform can spawn. The
 * whole leading command is replaced, not just the binary name, because the
 * `cmd.exe` prefix is part of what is platform-specific.
 */
async function installProfiles(repo: string, command: string[]): Promise<void> {
  for (const spec of describeCapabilityCorpus().profiles) {
    const built = corpusProfile(spec.tool, spec.model, spec.routing_tier, spec.cost_rank);
    /* Drop everything up to and including the codex entry point -- whatever
       this platform calls it -- and put the fake command in its place. */
    const entry = built.invoke.findIndex((arg) => arg === "codex.cmd" || arg === "codex");
    const source = { ...built, invoke: [...command, ...built.invoke.slice(entry + 1)] };
    await writeFile(
      path.join(repo, ".hivemind", "adapters", `${spec.tool}.profile.json`),
      `${JSON.stringify(source, null, 2)}
`,
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

function routeContract(file: string, routingTaskType: TaskContract["routing_task_type"] = "other"): TaskContract {
  return {
    task_id: "T-ROUTE",
    title: "Route fixture",
    agent_role: "builder",
    routing_task_type: routingTaskType,
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
