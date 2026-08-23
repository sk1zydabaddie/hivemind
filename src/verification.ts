import path from "node:path";
import { newChecksRunId, storeCheckOutput } from "./check-output.js";
import {
  buildVerificationProvenance,
  type CheckScope,
  type VerificationProvenance
} from "./verification-provenance.js";
import { runNamedCheck, type NamedCheckResult } from "./check-runner.js";
import type { HivemindConfig, VerificationCheckConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { appendEvent } from "./events.js";
import { matchesPattern } from "./glob.js";
import { readCanonMemory } from "./memory-canon.js";
import { inferTaskTier, type TaskTier } from "./routing.js";
import type { RepoGraphArtifact, RepoGraphFile } from "./repo-graph.js";
import {
  measureRuntimeCoverage,
  type RuntimeCoverageMeasurement
} from "./runtime-coverage.js";

const supportedExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const structuralOracleLimitation =
  "verification inventory entry_files are operator-declared; Hivemind does not prove that each command executes them";

export type VerificationCheckResult = NamedCheckResult;

export interface VerificationAudit {
  mode: "full" | "subset";
  reason: string;
  changed_files: string[];
  impact_set: string[];
  selected_checks: Array<{ id: string; command: string; sources: string[] }>;
  skipped_checks: Array<{ id: string; reason: string }>;
  graph_fingerprint: string | null;
  canon_ids: string[];
  contract_validity_checks: Array<{ task_id: string; id: string; command: string }>;
  structural_oracle: StructuralOracleMeasurement;
}

export interface StructuralOracleMeasurement {
  kind: "structural";
  status: "covered" | "uncovered" | "unknown";
  advisory_only: true;
  runtime_coverage: "not_measured";
  graph_fingerprint: string | null;
  impact_files: string[];
  covered_impact_files: string[];
  uncovered_impact_files: string[];
  unknown_impact_files: string[];
  check_associations: Array<{ impact_file: string; check_ids: string[] }>;
  unknown_reasons: string[];
  limitations: string[];
}

export interface VerificationRunResult {
  audit: VerificationAudit;
  checks: VerificationCheckResult[];
  runtime_coverage: RuntimeCoverageMeasurement;
  tests: "pass" | "fail";
  /**
   * What this result was standing on, assembled HERE rather than reconstructed
   * later. Reconstruction would have to re-derive the adapter, the check
   * authors and the build from a trail that has since moved on; binding it at
   * verification time is the same reason M8.7 binds the base commit and the
   * patch hashes at review time. Advisory: nothing gates on it.
   */
  provenance: VerificationProvenance;
}

export interface QualityDraftVerificationContext {
  quality_run_id: string;
  draft_id: string;
  task_id: string;
}

export type VerificationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function runVerification(
  repoRoot: string,
  worktreeRoot: string,
  config: HivemindConfig,
  taskIds: string[],
  changedFiles: string[],
  qualityDraft?: QualityDraftVerificationContext,
  /* Where these checks ran. Passed rather than inferred: the caller is the
     only thing that knows whether `worktreeRoot` is the shadow-integrated set
     or one task's own checkout, and guessing from the path would be wrong the
     first time a layout changed. Defaults to the narrower claim. */
  scope: CheckScope = "single_worktree"
): Promise<VerificationResult<VerificationRunResult>> {
  const selectedAudit = await selectVerificationChecks(repoRoot, config, taskIds, changedFiles);
  const contractChecks = await loadContractValidityChecks(repoRoot, taskIds);
  if (!contractChecks.ok) return contractChecks;
  const audit: VerificationAudit = {
    ...selectedAudit,
    contract_validity_checks: contractChecks.value
  };
  const checks: VerificationCheckResult[] = [];
  for (const check of audit.contract_validity_checks) {
    checks.push(await runNamedCheck(worktreeRoot, check.id, check.command));
  }
  for (const check of audit.selected_checks) {
    checks.push(await runNamedCheck(worktreeRoot, check.id, check.command));
  }
  const runtimeCoverage = await measureRuntimeCoverage(
    worktreeRoot,
    changedFiles,
    config.verification?.coverage,
    (command) => runNamedCheck(worktreeRoot, "coverage", command)
  );
  const provenance = await buildVerificationProvenance(
    repoRoot,
    taskIds,
    [
      ...audit.contract_validity_checks.map((check) => ({ id: check.id })),
      ...audit.selected_checks.map((check) => ({ id: check.id, sources: check.sources }))
    ],
    scope
  );
  const result: VerificationRunResult = {
    audit,
    checks,
    runtime_coverage: runtimeCoverage,
    tests: checks.every((check) => check.exit_code === 0) ? "pass" : "fail",
    provenance
  };
  /* Keep what the checks printed, beside the trail rather than in it. Until
     this existed the event recorded that `npm test` exited 1 and nothing about
     what it said, which is the whole of "seeing why the checks failed" -- the
     real need under the embedded-terminal ask. A failure to store is not a
     failure to verify: the run stands, and the pane says the output is
     missing rather than the verification being thrown away over a log. */
  const checksRunId = newChecksRunId();
  const stored = await storeCheckOutput(repoRoot, checksRunId, checks);
  const eventResult = await appendEvent(repoRoot, {
    type: qualityDraft === undefined ? "verification.completed" : "quality.draft_verified",
    task_id: qualityDraft?.task_id ?? null,
    data: {
      ...(qualityDraft === undefined
        ? {}
        : {
            quality_run_id: qualityDraft.quality_run_id,
            draft_id: qualityDraft.draft_id,
            advisory_only: true
          }),
      task_ids: [...taskIds],
      ...audit,
      runtime_coverage: runtimeCoverage,
      results: checks.map((check) => ({
        id: check.id,
        command: check.command,
        exit_code: check.exit_code
      })),
      /* Null when the output could not be kept, so a reader can tell "no output
         was recorded" apart from "the output was empty". */
      checks_run_id: stored.ok ? checksRunId : null,
      provenance,
      tests: result.tests
    }
  });
  return eventResult.ok
    ? { ok: true, value: result }
    : { ok: false, reason: `failed to append verification.completed event: ${eventResult.reason}` };
}

export async function selectVerificationChecks(
  repoRoot: string,
  config: HivemindConfig,
  taskIds: string[],
  changedFiles: string[]
): Promise<VerificationAudit> {
  if (changedFiles.some((file) => normalizeRepoPath(file) === null)) {
    const reason = "change set contains an invalid or unconfined path";
    return fullSuiteAudit(config, [], reason, unknownStructuralOracle([], reason));
  }
  const normalizedChanges = normalizePaths(changedFiles);
  const unknownFull = (reason: string): VerificationAudit =>
    fullSuiteAudit(config, normalizedChanges, reason, unknownStructuralOracle(normalizedChanges, reason));
  if (normalizedChanges.length === 0) {
    return unknownFull("change set is empty or unavailable");
  }
  if (normalizedChanges.some((file) => !isSupportedSource(file))) {
    return unknownFull("change set includes a non-JS/TS file that the repo graph cannot resolve");
  }
  if (config.verification?.graph_enabled === false) {
    return unknownFull("repo graph is disabled for verification");
  }
  const inventory = config.verification?.checks ?? [];
  if (inventory.length === 0) {
    return unknownFull("structured verification inventory is missing");
  }

  const tierResult = await resolveMaximumTaskTier(repoRoot, taskIds, config);
  const tierFullReason = !tierResult.ok
    ? `task tier is uncertain: ${tierResult.reason}`
    : tierResult.value === "high" || tierResult.value === "critical"
      ? `${tierResult.value} tier always requires the full suite`
      : null;

  const graphResult = await loadGraphFailSafe(repoRoot);
  if (!graphResult.ok) {
    const measurementReason = `repo graph unavailable: ${graphResult.reason}`;
    return fullSuiteAudit(
      config,
      normalizedChanges,
      tierFullReason ?? measurementReason,
      unknownStructuralOracle(normalizedChanges, measurementReason)
    );
  }
  const filesByPath = new Map(graphResult.value.files.map((file) => [file.path, file]));
  const graphProblem = graphUncertaintyReason(graphResult.value);
  if (graphProblem !== null) {
    return fullSuiteAudit(
      config,
      normalizedChanges,
      tierFullReason ?? graphProblem,
      unknownStructuralOracle(normalizedChanges, graphProblem, graphResult.value.source_fingerprint)
    );
  }
  for (const changedFile of normalizedChanges) {
    if (!filesByPath.has(changedFile)) {
      const reason = `repo graph cannot resolve changed file "${changedFile}"`;
      return fullSuiteAudit(
        config,
        normalizedChanges,
        tierFullReason ?? reason,
        unknownStructuralOracle(normalizedChanges, reason, graphResult.value.source_fingerprint)
      );
    }
  }

  const impactSet = reverseImpactSet(normalizedChanges, graphResult.value);
  const checkClosures = new Map<string, Set<string>>();
  for (const check of inventory) {
    const checkCoverage = checkCoverageFromGraph(check, filesByPath);
    if (!checkCoverage.ok) {
      return fullSuiteAudit(
        config,
        normalizedChanges,
        tierFullReason ?? checkCoverage.reason,
        unknownStructuralOracle([...impactSet], checkCoverage.reason, graphResult.value.source_fingerprint)
      );
    }
    checkClosures.set(check.id, checkCoverage.value);
  }
  const structuralOracle = measureStructuralOracle(
    impactSet,
    inventory,
    checkClosures,
    graphResult.value.source_fingerprint
  );
  const full = (reason: string): VerificationAudit =>
    fullSuiteAudit(config, normalizedChanges, reason, structuralOracle);
  if (tierFullReason !== null) {
    return full(tierFullReason);
  }

  const graphSelections = new Map<string, Set<string>>();
  for (const check of inventory) {
    for (const file of checkClosures.get(check.id) ?? []) {
      if (normalizedChanges.includes(file)) {
        addSelection(graphSelections, check.id, `graph:${file}`);
      }
    }
  }
  for (const changedFile of normalizedChanges) {
    if (![...graphSelections.values()].some((sources) => sources.has(`graph:${changedFile}`))) {
      return full(`no inventoried check is proven to exercise changed file "${changedFile}"`);
    }
  }

  const canon = await readCanonMemory(repoRoot);
  if (!canon.ok) {
    return full(`Tier-2 canon is unreadable: ${canon.reason}`);
  }
  const inventoryIds = new Set(inventory.map((check) => check.id));
  const canonIds: string[] = [];
  for (const entry of canon.value) {
    if (entry.verification_policy === null) {
      continue;
    }
    canonIds.push(entry.canon_id);
    for (const mapping of entry.verification_policy.mappings) {
      if (!inventoryIds.has(mapping.check_id)) {
        return full(`Tier-2 canon references unknown verification check "${mapping.check_id}"`);
      }
      for (const changedFile of normalizedChanges) {
        if (mapping.paths.some((pattern) => matchesPattern(changedFile, pattern))) {
          addSelection(graphSelections, mapping.check_id, `canon:${entry.canon_id}`);
        }
      }
    }
  }

  const selected = inventory
    .filter((check) => graphSelections.has(check.id))
    .map((check) => ({
      id: check.id,
      command: check.command,
      sources: [...(graphSelections.get(check.id) ?? [])].sort(compareText)
    }));
  if (selected.length === 0 || selected.length >= inventory.length) {
    return full(selected.length === 0 ? "impact selection produced no checks" : "impact selection would not run fewer checks");
  }
  const selectedIds = new Set(selected.map((check) => check.id));
  return {
    mode: "subset",
    reason: "Low/Medium JS/TS impact is fully resolved; Tier-2 canon may only add checks",
    changed_files: normalizedChanges,
    impact_set: [...impactSet].sort(compareText),
    selected_checks: selected,
    skipped_checks: inventory
      .filter((check) => !selectedIds.has(check.id))
      .map((check) => ({ id: check.id, reason: "outside the resolved impact set" })),
    graph_fingerprint: graphResult.value.source_fingerprint,
    canon_ids: canonIds.sort(compareText),
    contract_validity_checks: [],
    structural_oracle: structuralOracle
  };
}

function fullSuiteAudit(
  config: HivemindConfig,
  changedFiles: string[],
  reason: string,
  structuralOracle: StructuralOracleMeasurement
): VerificationAudit {
  /* A declared-no-tests project (A-03) runs zero checks, and the audit says
     so in its reason rather than carrying an empty command a runner would
     choke on. The pass this produces is vacuous BY THE USER'S OWN RECORDED
     DECISION -- the declaration lives in config, the reason names it here,
     and the provenance surface already renders what the audit recorded. */
  if (config.test_command.trim() === "" && config.no_tests_declared === true) {
    return {
      mode: "full",
      reason: `${reason}; the user declared this project has no tests, so no suite exists to run`,
      changed_files: changedFiles,
      impact_set: changedFiles,
      selected_checks: [],
      skipped_checks: [],
      graph_fingerprint: null,
      canon_ids: [],
      contract_validity_checks: [],
      structural_oracle: structuralOracle
    };
  }
  return {
    mode: "full",
    reason,
    changed_files: changedFiles,
    impact_set: changedFiles,
    selected_checks: [{ id: "full-suite", command: config.test_command, sources: ["fail-safe"] }],
    skipped_checks: [],
    graph_fingerprint: null,
    canon_ids: [],
    contract_validity_checks: [],
    structural_oracle: structuralOracle
  };
}

async function loadContractValidityChecks(
  repoRoot: string,
  taskIds: string[]
): Promise<VerificationResult<Array<{ task_id: string; id: string; command: string }>>> {
  const checks: Array<{ task_id: string; id: string; command: string }> = [];
  for (const taskId of taskIds) {
    const loaded = await loadAndValidateContract(repoRoot, taskId);
    if (!loaded.ok) return { ok: false, reason: `contract validity check unavailable for ${taskId}: ${loaded.reason}` };
    if (loaded.contract.deterministic_validity_check !== undefined) {
      checks.push({
        task_id: taskId,
        id: `contract-validity:${taskId}`,
        command: loaded.contract.deterministic_validity_check
      });
    }
  }
  return { ok: true, value: checks };
}

function measureStructuralOracle(
  impactSet: Set<string>,
  inventory: VerificationCheckConfig[],
  checkClosures: Map<string, Set<string>>,
  graphFingerprint: string
): StructuralOracleMeasurement {
  const impactFiles = [...impactSet].sort(compareText);
  const associations = impactFiles.map((impactFile) => ({
    impact_file: impactFile,
    check_ids: inventory
      .filter((check) => checkClosures.get(check.id)?.has(impactFile) === true)
      .map((check) => check.id)
      .sort(compareText)
  }));
  const covered = associations.filter((entry) => entry.check_ids.length > 0).map((entry) => entry.impact_file);
  const uncovered = associations.filter((entry) => entry.check_ids.length === 0).map((entry) => entry.impact_file);
  return {
    kind: "structural",
    status: uncovered.length === 0 ? "covered" : "uncovered",
    advisory_only: true,
    runtime_coverage: "not_measured",
    graph_fingerprint: graphFingerprint,
    impact_files: impactFiles,
    covered_impact_files: covered,
    uncovered_impact_files: uncovered,
    unknown_impact_files: [],
    check_associations: associations,
    unknown_reasons: [],
    limitations: [structuralOracleLimitation]
  };
}

function unknownStructuralOracle(
  impactFiles: string[],
  reason: string,
  graphFingerprint: string | null = null
): StructuralOracleMeasurement {
  const normalizedImpactFiles = normalizePaths(impactFiles);
  return {
    kind: "structural",
    status: "unknown",
    advisory_only: true,
    runtime_coverage: "not_measured",
    graph_fingerprint: graphFingerprint,
    impact_files: normalizedImpactFiles,
    covered_impact_files: [],
    uncovered_impact_files: [],
    unknown_impact_files: normalizedImpactFiles,
    check_associations: [],
    unknown_reasons: [reason],
    limitations: [structuralOracleLimitation]
  };
}

function checkCoverageFromGraph(
  check: VerificationCheckConfig,
  filesByPath: Map<string, RepoGraphFile>
): VerificationResult<Set<string>> {
  const covered = new Set<string>();
  const pending = normalizePaths(check.entry_files);
  if (pending.length !== check.entry_files.length) {
    return { ok: false, reason: `verification check "${check.id}" has an invalid entry file` };
  }
  for (const entryFile of pending) {
    if (!filesByPath.has(entryFile)) {
      return {
        ok: false,
        reason: `verification check "${check.id}" declares missing or unresolvable entry file "${entryFile}"`
      };
    }
  }
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const file = filesByPath.get(current);
    if (file === undefined) {
      return { ok: false, reason: `repo graph cannot resolve entry/dependency "${current}" for check "${check.id}"` };
    }
    covered.add(current);
    for (const dependency of file.dependencies) {
      if (dependency.kind === "dynamic_import") {
        return { ok: false, reason: `check "${check.id}" contains a dynamic import in "${current}"` };
      }
      if (dependency.target === null) {
        if (dependency.specifier.startsWith("node:")) {
          continue;
        }
        return { ok: false, reason: `check "${check.id}" has an unresolved import "${dependency.specifier}" in "${current}"` };
      }
      pending.push(dependency.target);
    }
  }
  return { ok: true, value: covered };
}

function graphUncertaintyReason(graph: RepoGraphArtifact): string | null {
  for (const file of graph.files) {
    for (const dependency of file.dependencies) {
      if (dependency.kind === "dynamic_import") {
        return `repo graph contains a dynamic import in "${file.path}"`;
      }
      if (dependency.target === null && !dependency.specifier.startsWith("node:")) {
        return `repo graph contains an unresolved import "${dependency.specifier}" in "${file.path}"`;
      }
    }
  }
  return null;
}

function reverseImpactSet(changedFiles: string[], graph: RepoGraphArtifact): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const file of graph.files) {
    for (const dependency of file.dependencies) {
      if (dependency.target === null) {
        continue;
      }
      const dependents = reverse.get(dependency.target) ?? new Set<string>();
      dependents.add(file.path);
      reverse.set(dependency.target, dependents);
    }
  }
  const impact = new Set(changedFiles);
  const pending = [...changedFiles];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const dependent of reverse.get(current) ?? []) {
      if (!impact.has(dependent)) {
        impact.add(dependent);
        pending.push(dependent);
      }
    }
  }
  return impact;
}

export async function resolveMaximumTaskTier(
  repoRoot: string,
  taskIds: string[],
  config: HivemindConfig
): Promise<VerificationResult<TaskTier>> {
  if (taskIds.length === 0) {
    return { ok: false, reason: "no accepted task ids were supplied" };
  }
  const tiers: TaskTier[] = [];
  for (const taskId of taskIds) {
    const contract = await loadAndValidateContract(repoRoot, taskId);
    if (!contract.ok) {
      return { ok: false, reason: contract.reason };
    }
    tiers.push(inferTaskTier(contract.contract, config));
  }
  return { ok: true, value: tiers.sort((left, right) => tierRank(right) - tierRank(left))[0] };
}

async function loadGraphFailSafe(repoRoot: string): Promise<VerificationResult<RepoGraphArtifact>> {
  try {
    const graph = await import("./repo-graph.js");
    return graph.loadVerifiedRepoGraph(repoRoot);
  } catch (error: unknown) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function addSelection(selections: Map<string, Set<string>>, checkId: string, source: string): void {
  const sources = selections.get(checkId) ?? new Set<string>();
  sources.add(source);
  selections.set(checkId, sources);
}

function normalizePaths(paths: string[]): string[] {
  const normalized = paths.map(normalizeRepoPath).filter((file): file is string => file !== null);
  return [...new Set(normalized)].sort(compareText);
}

function normalizeRepoPath(file: string): string | null {
  const normalized = file.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized)
    ? null
    : normalized;
}

function isSupportedSource(file: string): boolean {
  return supportedExtensions.has(path.posix.extname(file).toLowerCase());
}

function tierRank(tier: TaskTier): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[tier];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
