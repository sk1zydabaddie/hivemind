import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  findDangerousAdapterArgs,
  findRefusedAdapterModes,
  loadAdapterProfile,
  normalizeProfileCostRank,
  normalizeProfileRoutingTier,
  runAdapterProcess,
  type AdapterProfile,
  type AdapterProcessFailure,
  type AdapterProcessResult,
  type AdapterBudgetOvershoot,
  type ProviderRoutingTier
} from "./adapter.js";
import { writeJsonAtomic } from "./atomic.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { runGate, type GateResult } from "./gate.js";
import { inferTaskTier, type TaskTier } from "./routing.js";
import { isRoutingTaskType } from "./routing-task-type.js";
import { findGitRoot } from "./repo.js";
import { withDetachedCheckout } from "./changeset.js";
import { withProjectTempDirectory } from "./project-temp.js";
import { assembleAgentPromptFromVerifiedCheckout } from "./prompt-cache.js";
import type { ProviderReportedUsage, ProviderUsageCapture } from "./resource-ledger.js";
import type { TaskContract } from "./contract.js";
import { validateContract } from "./contract.js";
import type { HivemindConfig } from "./config.js";
import { runShadowVerification, type VerificationRunResult } from "./integrate.js";

const execFileAsync = promisify(execFile);
const corpusVersion = 1;
const strongTool = "codex";
const maxCorpusIterations = 10;

interface CorpusProfileSpec {
  tool: string;
  model: string;
  routing_tier: ProviderRoutingTier;
  cost_rank: number;
  price: CorpusPrice;
}

interface CorpusPrice {
  input_usd_per_million: number;
  cached_input_usd_per_million: number;
  output_usd_per_million: number;
  basis: string;
}

export interface CorpusTaskDefinition {
  task_id: string;
  case_id: "documentation" | "library" | "dependent_cli";
  title: string;
  expected_tier: TaskTier;
  routing_task_type: "documentation" | "data_model" | "cli";
  depends_on: string[];
  acceptance_criterion: string;
  deterministic_validity_check: string;
  allowed_files: string[];
  allowed_file_intents: TaskContract["allowed_file_intents"];
  read_only_files: string[];
  required_tests: string[];
  patch_requirements: string[];
}

export interface CapabilityCorpusDescription {
  version: 1;
  execution: "sequential_per_profile";
  isolation: "project_namespaced_disposable_repositories";
  adoption: false;
  promotion: false;
  expected_provider_calls: number;
  profiles: Array<{
    tool: string;
    model: string;
    routing_tier: ProviderRoutingTier;
    cost_rank: number;
    price: CorpusPrice;
  }>;
  tasks: CorpusTaskDefinition[];
  pricing_note: string;
}

export type CorpusAttemptStatus =
  | "success"
  | "dependency_blocked"
  | "adapter_failed"
  | "empty_patch"
  | "gate_rejected"
  | "verification_failed"
  | "indeterminate";

export interface CapabilityCorpusAttempt {
  version: 1;
  corpus_run_id: string;
  iteration: number;
  tool: string;
  model: string;
  provider_tier: ProviderRoutingTier;
  task_id: string;
  case_id: CorpusTaskDefinition["case_id"];
  task_tier: TaskTier;
  depends_on: string[];
  dependency_base_commit: string;
  status: CorpusAttemptStatus;
  success: boolean;
  reason: string;
  changed_files: string[];
  diff_sha256: string;
  gate: GateResult | null;
  verification: VerificationRunResult | null;
  validity_check_passed: boolean;
  shadow_tests_passed: boolean;
  revision_count: number;
  exit_code: number | null;
  wall_time_ms: number;
  self_measured_tokens: number | null;
  provider_reported_usage: ProviderReportedUsage | null;
  provider_usage_status: ProviderUsageCapture["status"] | null;
  accounting_source: "provider_reported" | "self_measured" | null;
  cache_economics: CacheEconomics | null;
  budget_overshoot: AdapterBudgetOvershoot | null;
  cost_usd: number | null;
  artifact_path: string;
}

interface ProviderCorpusSummary {
  tool: string;
  model: string;
  attempted_count: number;
  success_count: number;
  blocked_count: number;
  revision_count: number;
  provider_reported_attempt_count: number;
  total_effective_tokens: number;
  cache_economics: CacheEconomics | null;
  total_cost_usd: number | null;
  direct_cost_per_successful_task_usd: number | null;
  sol_fallback: {
    retry_count: number;
    successful_task_count: number;
    total_cost_usd: number | null;
    cost_per_successful_task_usd: number | null;
    failed_task_retry_premiums: Array<{
      case_id: string;
      cheaper_attempt_cost_usd: number | null;
      sol_attempt_cost_usd: number | null;
      retry_total_cost_usd: number | null;
      premium_over_starting_sol_usd: number | null;
    }>;
  } | null;
}

interface CacheEconomics {
  input_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  cached_input_ratio: number;
}

export interface CapabilityCorpusReport {
  version: 1;
  corpus_run_id: string;
  started_at: string;
  completed_at: string;
  corpus_definition_sha256: string;
  advisory_only: true;
  shadow_only: true;
  routing_authority: false;
  session_id: string;
  selected_tools: string[];
  iterations: number;
  attempts: CapabilityCorpusAttempt[];
  providers: ProviderCorpusSummary[];
  artifact_path: string;
}

const profileSpecs: readonly CorpusProfileSpec[] = [
  {
    tool: "codex-luna",
    model: "gpt-5.6-luna",
    routing_tier: "cheap",
    cost_rank: 4,
    price: {
      input_usd_per_million: 0.1,
      cached_input_usd_per_million: 0.01,
      output_usd_per_million: 0.6,
      basis: "operator-supplied current Luna promotion with OpenAI's documented 90% GPT-5.6 cache-read discount, 2026-08-03"
    }
  },
  {
    tool: "codex-terra",
    model: "gpt-5.6-terra",
    routing_tier: "standard",
    cost_rank: 10,
    price: {
      input_usd_per_million: 2.5,
      cached_input_usd_per_million: 0.25,
      output_usd_per_million: 15,
      basis: "GPT-5.6 standard API-equivalent price snapshot, 2026-08-03"
    }
  },
  {
    tool: strongTool,
    model: "gpt-5.6-sol",
    routing_tier: "strong",
    cost_rank: 20,
    price: {
      input_usd_per_million: 5,
      cached_input_usd_per_million: 0.5,
      output_usd_per_million: 30,
      basis: "GPT-5.6 standard API-equivalent price snapshot, 2026-08-03"
    }
  }
] as const;

const corpusTasks: readonly CorpusTaskDefinition[] = [
  {
    task_id: "T-001",
    case_id: "documentation",
    title: "Document the accepted record file format",
    expected_tier: "low",
    routing_task_type: "documentation",
    depends_on: [],
    acceptance_criterion: "README.md documents the JSON record file format and states that each record requires string id and name fields.",
    deterministic_validity_check: "node corpus-check.mjs documentation",
    allowed_files: ["README.md"],
    allowed_file_intents: { "README.md": "modify" },
    read_only_files: ["corpus-check.mjs", "fixtures/records.json"],
    required_tests: ["node --test"],
    patch_requirements: ["Keep the existing heading and add one concise record-format section."]
  },
  {
    task_id: "T-002",
    case_id: "library",
    title: "Implement stable record sorting",
    expected_tier: "medium",
    routing_task_type: "data_model",
    depends_on: [],
    acceptance_criterion: "Export function sortRecords(records) from src/sort-records.mjs; return a new array sorted by name and then id without mutating the input.",
    deterministic_validity_check: "node corpus-check.mjs library",
    allowed_files: ["src/sort-records.mjs", "test/sort-records.test.mjs"],
    allowed_file_intents: { "src/sort-records.mjs": "create", "test/sort-records.test.mjs": "create" },
    read_only_files: ["corpus-check.mjs", "fixtures/records.json", "package.json"],
    required_tests: ["node --test"],
    patch_requirements: ["Use no dependencies.", "Add focused Node tests for stable name/id ordering and input immutability."]
  },
  {
    task_id: "T-003",
    case_id: "dependent_cli",
    title: "Expose sorted records through the command line",
    expected_tier: "high",
    routing_task_type: "cli",
    depends_on: ["T-002"],
    acceptance_criterion: "The command node src/cli.mjs accepts --input <path>, supports optional --json, and emits records sorted through the exported sortRecords(records) dependency.",
    deterministic_validity_check: "node corpus-check.mjs dependent_cli",
    allowed_files: ["src/cli.mjs", "test/cli.test.mjs"],
    allowed_file_intents: { "src/cli.mjs": "create", "test/cli.test.mjs": "create" },
    read_only_files: ["src/sort-records.mjs", "corpus-check.mjs", "fixtures/records.json", "package.json"],
    required_tests: ["node --test"],
    patch_requirements: ["Import and use src/sort-records.mjs rather than duplicating sorting logic.", "Reject a missing --input value with a non-zero exit."]
  }
] as const;

export function describeCapabilityCorpus(): CapabilityCorpusDescription {
  return {
    version: corpusVersion,
    execution: "sequential_per_profile",
    isolation: "project_namespaced_disposable_repositories",
    adoption: false,
    promotion: false,
    expected_provider_calls: profileSpecs.length * corpusTasks.length,
    profiles: profileSpecs.map((profile) => ({ ...profile, price: { ...profile.price } })),
    tasks: corpusTasks.map(cloneTask),
    pricing_note: "Dollar cost is emitted only for captured provider input/cached-input/output usage. GPT-5.6 cache reads use the documented 90% input discount; cache writes would require their separately reported rate. Missing or unparseable usage remains null rather than estimated."
  };
}

function describeCapabilityCorpusRun(
  selectedProfiles: readonly CorpusProfileSpec[],
  iterations: number
): CapabilityCorpusDescription {
  const description = describeCapabilityCorpus();
  return {
    ...description,
    expected_provider_calls: selectedProfiles.length * corpusTasks.length * iterations,
    profiles: selectedProfiles.map((profile) => ({ ...profile, price: { ...profile.price } }))
  };
}

export async function validateCapabilityCorpusProfiles(
  repoRoot: string,
  selectedTools: readonly string[] = profileSpecs.map((profile) => profile.tool)
): Promise<{ ok: true; value: Array<{ spec: CorpusProfileSpec; profile: AdapterProfile }> } | { ok: false; reason: string }> {
  const requested = new Set(selectedTools);
  const unknown = [...requested].filter((tool) => !profileSpecs.some((profile) => profile.tool === tool));
  if (requested.size === 0) return { ok: false, reason: "capability corpus requires at least one provider profile" };
  if (unknown.length > 0) return { ok: false, reason: `unknown capability corpus profile: ${unknown.join(", ")}` };
  const profiles: Array<{ spec: CorpusProfileSpec; profile: AdapterProfile }> = [];
  for (const spec of profileSpecs.filter((profile) => requested.has(profile.tool))) {
    const loaded = await loadAdapterProfile(repoRoot, spec.tool);
    if (!loaded.ok) return loaded;
    const problem = capabilityProfileProblem(loaded.profile, spec);
    if (problem !== null) return { ok: false, reason: `${spec.tool}: ${problem}` };
    profiles.push({ spec, profile: loaded.profile });
  }
  return { ok: true, value: profiles };
}

export async function runCapabilityCorpus(
  repoRoot: string,
  options: { corpusRunId?: string; tools?: string[]; iterations?: number } = {}
): Promise<{ ok: true; value: CapabilityCorpusReport } | { ok: false; reason: string }> {
  const iterations = options.iterations ?? 1;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > maxCorpusIterations) {
    return { ok: false, reason: `capability corpus iterations must be an integer from 1 to ${maxCorpusIterations}` };
  }
  const selectedTools = options.tools ?? profileSpecs.map((profile) => profile.tool);
  if (new Set(selectedTools).size !== selectedTools.length) {
    return { ok: false, reason: "capability corpus profile selection contains duplicates" };
  }
  const validatedProfiles = await validateCapabilityCorpusProfiles(repoRoot, selectedTools);
  if (!validatedProfiles.ok) return validatedProfiles;
  const corpusRunId = options.corpusRunId ?? `CC-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID()}`;
  if (!/^CC-[A-Za-z0-9-]+$/u.test(corpusRunId)) {
    return { ok: false, reason: "corpus run id must start with CC- and contain only letters, numbers, and hyphens" };
  }
  const corpusRoot = path.join(repoRoot, ".hivemind", "resource", "capability-corpus", corpusRunId);
  if (await exists(corpusRoot)) return { ok: false, reason: `capability corpus run already exists: ${corpusRunId}` };
  await mkdir(corpusRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  const description = describeCapabilityCorpusRun(validatedProfiles.value.map(({ spec }) => spec), iterations);
  await writeExclusiveJson(path.join(corpusRoot, "manifest.json"), {
    version: corpusVersion,
    corpus_run_id: corpusRunId,
    started_at: startedAt,
    definition: description,
    definition_sha256: hashJson(description),
    advisory_only: true,
    shadow_only: true,
    routing_authority: false
  });

  const attempts: CapabilityCorpusAttempt[] = [];
  try {
    for (const entry of validatedProfiles.value) {
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        const providerAttempts = await withProjectTempDirectory(repoRoot, "capability", async ({ path: tempRoot }) => {
          const sampleRepo = path.join(tempRoot, "repo");
          await initializeCorpusRepository(sampleRepo);
          return runProfileCorpus(repoRoot, sampleRepo, corpusRoot, corpusRunId, iteration, entry.spec, entry.profile);
        });
        attempts.push(...providerAttempts);
      }
    }
    const completedAt = new Date().toISOString();
    const report: CapabilityCorpusReport = {
      version: corpusVersion,
      corpus_run_id: corpusRunId,
      started_at: startedAt,
      completed_at: completedAt,
      corpus_definition_sha256: hashJson(description),
      advisory_only: true,
      shadow_only: true,
      routing_authority: false,
      session_id: corpusRunId,
      selected_tools: validatedProfiles.value.map(({ spec }) => spec.tool),
      iterations,
      attempts,
      providers: summarizeProviders(attempts),
      artifact_path: artifactPath(repoRoot, corpusRoot)
    };
    await writeExclusiveJson(path.join(corpusRoot, "report.json"), report);
    return { ok: true, value: report };
  } catch (error: unknown) {
    await writeExclusiveJson(path.join(corpusRoot, "failure.json"), {
      version: corpusVersion,
      corpus_run_id: corpusRunId,
      failed_at: new Date().toISOString(),
      reason: errorMessage(error),
      completed_attempts: attempts.length
    }).catch(() => undefined);
    return { ok: false, reason: `capability corpus failed: ${errorMessage(error)}` };
  }
}

export async function capabilityCorpusCommand(cwd: string, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "describe" && action !== "run") {
    console.error("error: usage: hivemind routing corpus describe | run [--tool <profile>] [--iterations <1-10>]");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }
  if (action === "describe") {
    if (rest.length > 0) {
      console.error("error: usage: hivemind routing corpus describe");
      return 1;
    }
    console.log(JSON.stringify(describeCapabilityCorpus(), null, 2));
    return 0;
  }
  const parsed = parseCorpusRunOptions(rest);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }
  const result = await runCapabilityCorpus(repoRoot, parsed.value);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function parseCorpusRunOptions(
  args: string[]
): { ok: true; value: { tools?: string[]; iterations?: number } } | { ok: false; reason: string } {
  const tools: string[] = [];
  let iterations: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--tool" && value !== undefined) {
      tools.push(value);
      index += 1;
      continue;
    }
    if (flag === "--iterations" && value !== undefined) {
      if (iterations !== undefined) return { ok: false, reason: "--iterations may be provided only once" };
      iterations = Number(value);
      index += 1;
      continue;
    }
    return { ok: false, reason: `usage: hivemind routing corpus run [--tool <profile>] [--iterations <1-${maxCorpusIterations}>]` };
  }
  return {
    ok: true,
    value: {
      ...(tools.length > 0 ? { tools } : {}),
      ...(iterations !== undefined ? { iterations } : {})
    }
  };
}

async function runProfileCorpus(
  ledgerRepo: string,
  sampleRepo: string,
  corpusRoot: string,
  corpusRunId: string,
  iteration: number,
  spec: CorpusProfileSpec,
  profile: AdapterProfile
): Promise<CapabilityCorpusAttempt[]> {
  const attempts: CapabilityCorpusAttempt[] = [];
  const successful = new Set<string>();
  for (const task of corpusTasks) {
    const baseCommit = await gitOutput(sampleRepo, ["rev-parse", "HEAD"]);
    const taskTier = inferTaskTier(buildContract(task, baseCommit), sampleConfig(sampleRepo));
    if (taskTier !== task.expected_tier) throw new Error(`${task.case_id} inferred ${taskTier}, expected ${task.expected_tier}`);
    if (task.depends_on.some((dependency) => !successful.has(dependency))) {
      const blocked = blockedAttempt(corpusRunId, iteration, spec, task, baseCommit, corpusRoot, ledgerRepo);
      await persistAttempt(corpusRoot, blocked, "");
      attempts.push(blocked);
      continue;
    }
    const attempt = await runCorpusAttempt(ledgerRepo, sampleRepo, corpusRoot, corpusRunId, iteration, spec, profile, task, baseCommit);
    attempts.push(attempt);
    if (attempt.success) {
      await applyAcceptedCorpusPatch(sampleRepo, path.join(ledgerRepo, attempt.artifact_path, "diff.patch"), task);
      successful.add(task.task_id);
    }
  }
  return attempts;
}

async function runCorpusAttempt(
  ledgerRepo: string,
  sampleRepo: string,
  corpusRoot: string,
  corpusRunId: string,
  iteration: number,
  spec: CorpusProfileSpec,
  profile: AdapterProfile,
  task: CorpusTaskDefinition,
  baseCommit: string
): Promise<CapabilityCorpusAttempt> {
  const contract = buildContract(task, baseCommit);
  const contractProblems = validateContract(contract, task.task_id);
  if (contractProblems.length > 0) throw new Error(`invalid corpus contract ${task.task_id}: ${contractProblems.join("; ")}`);
  await writeJsonAtomic(path.join(sampleRepo, ".hivemind", "tasks", `${task.task_id}.contract.json`), contract);
  const attemptTemp = path.join(corpusRoot, ".attempts", `${spec.tool}-${task.task_id}-${randomUUID()}`);
  await mkdir(attemptTemp, { recursive: true });
  const patchPath = path.join(attemptTemp, "diff.patch");
  const checkout = await withDetachedCheckout(sampleRepo, baseCommit, async (checkoutPath) => {
    const prompt = await assembleAgentPromptFromVerifiedCheckout(sampleRepo, contract, checkoutPath);
    if (!prompt.ok) throw new Error(prompt.reason);
    const processResult = await runAdapterProcess(ledgerRepo, profile, checkoutPath, prompt.value.full_prompt, {
      usageSessionId: corpusRunId,
      usageRunId: corpusRunId,
      usageTaskId: `${spec.tool}-iteration-${String(iteration).padStart(3, "0")}-${task.task_id}`,
      outputLogPath: path.join(attemptTemp, "adapter.log")
    });
    if (!processResult.ok) {
      return {
        process: null,
        process_failure: processResult,
        diff: "",
        changedFiles: [] as string[],
        gate: null,
        verification: null
      };
    }
    const captured = await captureWorktreeDiff(checkoutPath, baseCommit);
    if (!captured.ok) throw new Error(captured.reason);
    const changedFiles = await changedFileNames(checkoutPath, baseCommit);
    await writeFile(patchPath, captured.value.diff, { encoding: "utf8", flag: "wx" });
    const gate = captured.value.diff.trim() === "" ? null : await runGate(baseCommit, patchPath, contract, sampleConfig(sampleRepo));
    const verification = gate?.verdict === "accept"
      ? await runShadowVerification(sampleRepo, checkoutPath, sampleConfig(sampleRepo), [task.task_id], changedFiles)
      : null;
    return { process: processResult.value, process_failure: null, diff: captured.value.diff, changedFiles, gate, verification };
  });
  if (!checkout.ok) throw new Error(checkout.reason);
  const result = checkout.value;
  if (!(await exists(patchPath))) await writeFile(patchPath, result.diff, { encoding: "utf8", flag: "wx" });
  const classified = classifyAttempt(result);
  const metering = result.process === null
    ? result.process_failure?.metering ?? null
    : {
        providerUsageCapture: result.process.providerUsageCapture,
        quotaRequest: result.process.quotaRequest,
        budgetOvershoot: result.process.budgetOvershoot
      };
  const usage = metering?.providerUsageCapture.status === "captured" ? metering.providerUsageCapture.usage : null;
  const attempt: CapabilityCorpusAttempt = {
    version: corpusVersion,
    corpus_run_id: corpusRunId,
    iteration,
    tool: spec.tool,
    model: spec.model,
    provider_tier: spec.routing_tier,
    task_id: task.task_id,
    case_id: task.case_id,
    task_tier: task.expected_tier,
    depends_on: [...task.depends_on],
    dependency_base_commit: baseCommit,
    status: classified.status,
    success: classified.status === "success",
    reason: classified.reason,
    changed_files: result.changedFiles,
    diff_sha256: hashText(result.diff),
    gate: result.gate,
    verification: result.verification?.ok === true ? result.verification.value : null,
    validity_check_passed: validityCheckPassed(result.verification),
    shadow_tests_passed: result.verification?.ok === true && result.verification.value.tests === "pass",
    revision_count: 0,
    exit_code: result.process?.exitCode ?? result.process_failure?.exitCode ?? null,
    wall_time_ms: result.process?.wallTimeMs ?? result.process_failure?.wallTimeMs ?? 0,
    self_measured_tokens: metering?.quotaRequest.self_measured_tokens ?? null,
    provider_reported_usage: usage,
    provider_usage_status: metering?.providerUsageCapture.status ?? null,
    accounting_source: metering?.quotaRequest.accounting_source ?? null,
    cache_economics: usage === null ? null : cacheEconomics([usage]),
    budget_overshoot: metering?.budgetOvershoot ?? null,
    cost_usd: usage === null ? null : usageCost(usage, spec.price),
    artifact_path: artifactPath(ledgerRepo, finalAttemptPath(corpusRoot, spec.tool, iteration, task.task_id))
  };
  await writeJsonAtomic(path.join(attemptTemp, "result.json"), attempt);
  await finalizeAttemptDirectory(corpusRoot, attemptTemp, spec.tool, iteration, task.task_id);
  return attempt;
}

function classifyAttempt(result: {
  process: AdapterProcessResult | null;
  process_failure: AdapterProcessFailure | null;
  diff: string;
  gate: GateResult | null;
  verification: Awaited<ReturnType<typeof runShadowVerification>> | null;
}): { status: CorpusAttemptStatus; reason: string } {
  if (result.process_failure !== null) return { status: "adapter_failed", reason: result.process_failure.reason };
  if (result.process === null) return { status: "indeterminate", reason: "adapter result is unavailable" };
  if (result.process.exitCode !== 0) return { status: "adapter_failed", reason: `adapter exited ${result.process.exitCode}` };
  if (result.diff.trim() === "") return { status: "empty_patch", reason: "worker produced no patch" };
  if (result.gate === null) return { status: "indeterminate", reason: "scope gate did not run" };
  if (result.gate.verdict !== "accept") return { status: "gate_rejected", reason: `scope gate ${result.gate.verdict}: ${result.gate.reason}` };
  if (result.verification === null || !result.verification.ok) {
    return { status: "indeterminate", reason: result.verification?.reason ?? "shadow verifier did not run" };
  }
  if (result.verification.value.tests !== "pass") return { status: "verification_failed", reason: "contract validity or shadow checks failed" };
  return { status: "success", reason: "scope gate and independent contract/shadow checks passed" };
}

function blockedAttempt(
  corpusRunId: string,
  iteration: number,
  spec: CorpusProfileSpec,
  task: CorpusTaskDefinition,
  baseCommit: string,
  corpusRoot: string,
  repoRoot: string
): CapabilityCorpusAttempt {
  return {
    version: corpusVersion,
    corpus_run_id: corpusRunId,
    iteration,
    tool: spec.tool,
    model: spec.model,
    provider_tier: spec.routing_tier,
    task_id: task.task_id,
    case_id: task.case_id,
    task_tier: task.expected_tier,
    depends_on: [...task.depends_on],
    dependency_base_commit: baseCommit,
    status: "dependency_blocked",
    success: false,
    reason: `dependency did not pass: ${task.depends_on.join(", ")}`,
    changed_files: [],
    diff_sha256: hashText(""),
    gate: null,
    verification: null,
    validity_check_passed: false,
    shadow_tests_passed: false,
    revision_count: 0,
    exit_code: null,
    wall_time_ms: 0,
    self_measured_tokens: null,
    provider_reported_usage: null,
    provider_usage_status: null,
    accounting_source: null,
    cache_economics: null,
    budget_overshoot: null,
    cost_usd: 0,
    artifact_path: artifactPath(repoRoot, finalAttemptPath(corpusRoot, spec.tool, iteration, task.task_id))
  };
}

async function persistAttempt(corpusRoot: string, attempt: CapabilityCorpusAttempt, diff: string): Promise<void> {
  const temp = path.join(corpusRoot, ".attempts", `${attempt.tool}-${attempt.task_id}-${randomUUID()}`);
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(temp, "diff.patch"), diff, { encoding: "utf8", flag: "wx" });
  await writeJsonAtomic(path.join(temp, "result.json"), attempt);
  await finalizeAttemptDirectory(corpusRoot, temp, attempt.tool, attempt.iteration, attempt.task_id);
}

async function finalizeAttemptDirectory(corpusRoot: string, tempPath: string, tool: string, iteration: number, taskId: string): Promise<void> {
  const destination = finalAttemptPath(corpusRoot, tool, iteration, taskId);
  await mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) throw new Error(`capability attempt artifact already exists: ${tool}/iteration-${iteration}/${taskId}`);
  await rename(tempPath, destination);
}

function finalAttemptPath(corpusRoot: string, tool: string, iteration: number, taskId: string): string {
  return path.join(corpusRoot, "attempts", tool, `iteration-${String(iteration).padStart(3, "0")}`, taskId);
}

function summarizeProviders(attempts: CapabilityCorpusAttempt[]): ProviderCorpusSummary[] {
  const solByCase = new Map(attempts.filter((attempt) => attempt.tool === strongTool).map((attempt) => [attempt.case_id, attempt]));
  return profileSpecs.filter((profile) => attempts.some((attempt) => attempt.tool === profile.tool)).map((profile) => {
    const own = attempts.filter((attempt) => attempt.tool === profile.tool);
    const ownCost = completeCost(own);
    const successes = own.filter((attempt) => attempt.success).length;
    return {
      tool: profile.tool,
      model: profile.model,
      attempted_count: own.filter((attempt) => attempt.status !== "dependency_blocked").length,
      success_count: successes,
      blocked_count: own.filter((attempt) => attempt.status === "dependency_blocked").length,
      revision_count: own.reduce((total, attempt) => total + attempt.revision_count, 0),
      provider_reported_attempt_count: own.filter((attempt) => attempt.provider_reported_usage !== null).length,
      total_effective_tokens: own.reduce((total, attempt) => total + (attempt.provider_reported_usage?.total_tokens ?? attempt.self_measured_tokens ?? 0), 0),
      cache_economics: cacheEconomics(own.flatMap((attempt) => attempt.provider_reported_usage === null ? [] : [attempt.provider_reported_usage])),
      total_cost_usd: ownCost,
      direct_cost_per_successful_task_usd: ownCost === null || successes === 0 ? null : roundUsd(ownCost / successes),
      sol_fallback: profile.tool === strongTool ? null : buildSolFallback(own, solByCase)
    };
  });
}

function cacheEconomics(usages: ProviderReportedUsage[]): CacheEconomics | null {
  if (usages.length === 0 || usages.some((usage) => usage.input_tokens === null || usage.cached_input_tokens === null)) return null;
  const inputTokens = usages.reduce((total, usage) => total + (usage.input_tokens ?? 0), 0);
  const cachedInputTokens = usages.reduce(
    (total, usage) => total + Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens ?? 0),
    0
  );
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: inputTokens - cachedInputTokens,
    cached_input_ratio: inputTokens === 0 ? 0 : roundRatio(cachedInputTokens / inputTokens)
  };
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function buildSolFallback(
  attempts: CapabilityCorpusAttempt[],
  solByCase: Map<CapabilityCorpusAttempt["case_id"], CapabilityCorpusAttempt>
): NonNullable<ProviderCorpusSummary["sol_fallback"]> {
  const retryPremiums: NonNullable<ProviderCorpusSummary["sol_fallback"]>["failed_task_retry_premiums"] = [];
  let successfulTasks = 0;
  let totalCost = 0;
  let costKnown = true;
  let retries = 0;
  for (const attempt of attempts) {
    if (attempt.cost_usd === null) costKnown = false;
    else totalCost += attempt.cost_usd;
    if (attempt.success) {
      successfulTasks += 1;
      continue;
    }
    retries += 1;
    const sol = solByCase.get(attempt.case_id);
    if (sol?.success === true) successfulTasks += 1;
    if (sol?.cost_usd === null || sol === undefined) costKnown = false;
    else totalCost += sol.cost_usd;
    retryPremiums.push({
      case_id: attempt.case_id,
      cheaper_attempt_cost_usd: attempt.cost_usd,
      sol_attempt_cost_usd: sol?.cost_usd ?? null,
      retry_total_cost_usd: attempt.cost_usd === null || sol?.cost_usd == null ? null : roundUsd(attempt.cost_usd + sol.cost_usd),
      premium_over_starting_sol_usd: attempt.cost_usd === null || sol?.cost_usd == null ? null : roundUsd(attempt.cost_usd)
    });
  }
  return {
    retry_count: retries,
    successful_task_count: successfulTasks,
    total_cost_usd: costKnown ? roundUsd(totalCost) : null,
    cost_per_successful_task_usd: costKnown && successfulTasks > 0 ? roundUsd(totalCost / successfulTasks) : null,
    failed_task_retry_premiums: retryPremiums
  };
}

function completeCost(attempts: CapabilityCorpusAttempt[]): number | null {
  if (attempts.some((attempt) => attempt.cost_usd === null)) return null;
  return roundUsd(attempts.reduce((total, attempt) => total + (attempt.cost_usd ?? 0), 0));
}

function usageCost(usage: ProviderReportedUsage, price: CorpusPrice): number | null {
  if (usage.input_tokens === null || usage.output_tokens === null) return null;
  const cached = Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens);
  const uncached = usage.input_tokens - cached;
  return roundUsd((
    uncached * price.input_usd_per_million +
    cached * price.cached_input_usd_per_million +
    usage.output_tokens * price.output_usd_per_million
  ) / 1_000_000);
}

function validityCheckPassed(verification: Awaited<ReturnType<typeof runShadowVerification>> | null): boolean {
  if (verification === null || !verification.ok) return false;
  const validityIds = new Set(verification.value.audit.contract_validity_checks.map((check) => check.id));
  return validityIds.size > 0 && verification.value.checks.filter((check) => validityIds.has(check.id)).every((check) => check.exit_code === 0);
}

function capabilityProfileProblem(profile: AdapterProfile, spec: CorpusProfileSpec): string | null {
  if (normalizeProfileRoutingTier(profile) !== spec.routing_tier) return `routing tier must be ${spec.routing_tier}`;
  if (normalizeProfileCostRank(profile) !== spec.cost_rank) return `cost rank must be ${spec.cost_rank}`;
  if (findDangerousAdapterArgs(profile.invoke).length > 0) return "profile contains a dangerous bypass flag";
  if (findRefusedAdapterModes(profile, {}).length > 0) return "profile contains an ultra or dynamic-workflow setting";
  if (profile.invoke.includes("--ignore-user-config") || profile.invoke.includes("--ignore-rules")) return "profile must not discard user config or policy rules";
  if (argumentAfter(profile.invoke, "--model") !== spec.model) return `model must be explicitly pinned to ${spec.model}`;
  if (argumentAfter(profile.invoke, "--sandbox") !== "workspace-write") return "sandbox must be explicitly workspace-write";
  /* This line used to REQUIRE `-c model_reasoning_effort="high"`, on the
     belief that passing it pinned effort. Measured 2026-08-23: that override
     form is inert -- accepted by argv, reported as applied by `codex doctor`,
     echoed in the JSON stream, and without effect. So the requirement is
     inverted rather than dropped: a corpus profile may carry NO `-c` override
     at all, because a corpus that believes it measured "high effort" while
     running at the default measures something nobody can name. Every earlier
     corpus number, the 212K call included, was taken under the old line. */
  if (profile.invoke.includes("--config") || profile.invoke.includes("-c")) {
    return "profile must carry no -c config override: the form is measured inert, so it states a setting it does not apply";
  }
  if (!profile.invoke.includes("--ephemeral")) return "profile must be ephemeral";
  if (!profile.invoke.includes("--json") || profile.usage_parser !== "codex-jsonl") return "profile must expose Codex JSONL usage";
  const commandIndex = profile.invoke.findIndex((entry) => /(^|[\\/])codex(?:\.cmd|\.exe)?$/iu.test(entry));
  if (commandIndex < 0 || profile.invoke[commandIndex + 1] !== "exec") return "profile must invoke codex exec";
  return null;
}

function argumentAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] ?? null;
}

async function initializeCorpusRepository(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "--initial-branch=master"]);
  await git(repoRoot, ["config", "user.email", "hivemind-capability@example.invalid"]);
  await git(repoRoot, ["config", "user.name", "Hivemind Capability Corpus"]);
  await mkdir(path.join(repoRoot, "fixtures"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "hivemind-capability-corpus", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`, "utf8");
  await writeFile(path.join(repoRoot, "README.md"), "# Records utility\n\nA tiny repository used for repeatable capability measurement.\n", "utf8");
  await writeFile(path.join(repoRoot, "AGENTS.md"), [
    "# Capability corpus instructions",
    "",
    "Implement only the task contract in the prompt.",
    "Do not commit, alter repository configuration, or write outside the allowed files.",
    "Run the required tests and leave the working tree patch for Hivemind to inspect.",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(repoRoot, "fixtures", "records.json"), `${JSON.stringify([
    { id: "3", name: "Beta" },
    { id: "2", name: "Alpha" },
    { id: "1", name: "Alpha" }
  ], null, 2)}\n`, "utf8");
  await writeFile(path.join(repoRoot, "corpus-check.mjs"), corpusCheckSource, "utf8");
  await git(repoRoot, ["add", "--all"]);
  await git(repoRoot, ["commit", "-m", "seed capability corpus"]);
  await initializeCorpusControlState(repoRoot);
}

async function initializeCorpusControlState(repoRoot: string): Promise<void> {
  for (const relative of ["tasks", "log", "patches", "worktrees", "adapters", "canon", "resource"]) {
    await mkdir(path.join(repoRoot, ".hivemind", relative), { recursive: true });
  }
  await writeFile(path.join(repoRoot, ".hivemind", "log", "events.jsonl"), "", { encoding: "utf8", flag: "wx" });
  await writeJsonAtomic(path.join(repoRoot, ".hivemind", "config.json"), sampleConfig(repoRoot));
}

function sampleConfig(repoRoot: string): HivemindConfig {
  return {
    version: 1,
    stack: "typescript-node",
    repo_root: repoRoot,
    base_branch: "master",
    test_command: "node --test",
    allowed_globs: [],
    forbidden_globs: ["package.json", "AGENTS.md", "corpus-check.mjs", "fixtures/**", ".hivemind/**"],
    low_globs: ["README.md"],
    medium_globs: ["src/sort-records.mjs", "test/**"],
    high_globs: ["src/cli.mjs"],
    critical_globs: [],
    resource_policy: { run_ceiling: { tokens: 150_000 }, session_ceiling: { tokens: 500_000 } },
    verification: { graph_enabled: false, checks: [] }
  };
}

function buildContract(task: CorpusTaskDefinition, baseCommit: string): TaskContract {
  return {
    task_id: task.task_id,
    title: task.title,
    agent_role: "builder",
    routing_task_type: task.routing_task_type,
    base_commit: baseCommit,
    acceptance_criterion: task.acceptance_criterion,
    deterministic_validity_check: task.deterministic_validity_check,
    allowed_files: [...task.allowed_files],
    allowed_file_intents: { ...task.allowed_file_intents },
    read_only_files: [...task.read_only_files],
    forbidden_files: ["package.json", "AGENTS.md", "corpus-check.mjs", "fixtures/**", ".hivemind/**"],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: ["The independent corpus-check.mjs conformance oracle.", "The disposable repository configuration."],
    required_tests: [...task.required_tests],
    patch_requirements: [...task.patch_requirements]
  };
}

async function applyAcceptedCorpusPatch(repoRoot: string, patchPath: string, task: CorpusTaskDefinition): Promise<void> {
  await git(repoRoot, ["apply", "--check", "--index", patchPath]);
  await git(repoRoot, ["apply", "--index", patchPath]);
  await git(repoRoot, ["commit", "-m", `accept corpus ${task.case_id}`]);
}

async function changedFileNames(repoRoot: string, baseCommit: string): Promise<string[]> {
  const output = await gitOutput(repoRoot, ["diff", "--name-only", "-z", baseCommit]);
  return output.split("\0").filter(Boolean).map((entry) => entry.replaceAll("\\", "/")).sort();
}

async function writeExclusiveJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function git(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } catch (error: unknown) {
    throw new Error(`git ${args.join(" ")} failed: ${commandError(error)}`);
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error: unknown) {
    throw new Error(`git ${args.join(" ")} failed: ${commandError(error)}`);
  }
}

function cloneTask(task: CorpusTaskDefinition): CorpusTaskDefinition {
  return {
    ...task,
    depends_on: [...task.depends_on],
    allowed_files: [...task.allowed_files],
    allowed_file_intents: { ...task.allowed_file_intents },
    read_only_files: [...task.read_only_files],
    required_tests: [...task.required_tests],
    patch_requirements: [...task.patch_requirements]
  };
}

function artifactPath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function commandError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = "stdout" in error ? String(error.stdout).trim() : "";
    if (stderr || stdout) return stderr || stdout;
  }
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorMessage).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const corpusCheckSource = String.raw`import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const check = process.argv[2];
if (check === "documentation") {
  const readme = await readFile("README.md", "utf8");
  if (!/JSON record file format/iu.test(readme) || !/string[^\n]*id/iu.test(readme) || !/string[^\n]*name/iu.test(readme)) {
    throw new Error("README does not state the required JSON record fields");
  }
} else if (check === "library") {
  const { sortRecords } = await import("./src/sort-records.mjs");
  const input = [{ id: "3", name: "Beta" }, { id: "2", name: "Alpha" }, { id: "1", name: "Alpha" }];
  const before = JSON.stringify(input);
  const output = sortRecords(input);
  notStrictEqual(output, input);
  strictEqual(JSON.stringify(input), before);
  deepStrictEqual(output.map(({ id }) => id), ["1", "2", "3"]);
} else if (check === "dependent_cli") {
  const json = spawnSync(process.execPath, ["src/cli.mjs", "--input", "fixtures/records.json", "--json"], { encoding: "utf8" });
  strictEqual(json.status, 0, json.stderr);
  deepStrictEqual(JSON.parse(json.stdout).map(({ id }) => id), ["1", "2", "3"]);
  const text = spawnSync(process.execPath, ["src/cli.mjs", "--input", "fixtures/records.json"], { encoding: "utf8" });
  strictEqual(text.status, 0, text.stderr);
  strictEqual(text.stdout.trim(), "Alpha [1]\nAlpha [2]\nBeta [3]");
  const missing = spawnSync(process.execPath, ["src/cli.mjs", "--input"], { encoding: "utf8" });
  if (missing.status === 0) throw new Error("missing --input value was accepted");
} else {
  throw new Error("unknown corpus check");
}
`;
