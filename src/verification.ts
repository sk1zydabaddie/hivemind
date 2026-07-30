import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
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

const execAsync = promisify(exec);
const supportedExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const structuralOracleLimitation =
  "verification inventory entry_files are operator-declared; Hivemind does not prove that each command executes them";

export interface VerificationCheckResult {
  id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface VerificationAudit {
  mode: "full" | "subset";
  reason: string;
  changed_files: string[];
  impact_set: string[];
  selected_checks: Array<{ id: string; command: string; sources: string[] }>;
  skipped_checks: Array<{ id: string; reason: string }>;
  graph_fingerprint: string | null;
  canon_ids: string[];
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
}

export type VerificationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function runVerification(
  repoRoot: string,
  worktreeRoot: string,
  config: HivemindConfig,
  taskIds: string[],
  changedFiles: string[]
): Promise<VerificationResult<VerificationRunResult>> {
  const audit = await selectVerificationChecks(repoRoot, config, taskIds, changedFiles);
  const checks: VerificationCheckResult[] = [];
  for (const check of audit.selected_checks) {
    checks.push(await runCheck(worktreeRoot, check.id, check.command));
  }
  const runtimeCoverage = await measureRuntimeCoverage(
    worktreeRoot,
    changedFiles,
    config.verification?.coverage,
    (command) => runCheck(worktreeRoot, "coverage", command)
  );
  const result: VerificationRunResult = {
    audit,
    checks,
    runtime_coverage: runtimeCoverage,
    tests: checks.every((check) => check.exit_code === 0) ? "pass" : "fail"
  };
  const eventResult = await appendEvent(repoRoot, {
    type: "verification.completed",
    task_id: null,
    data: {
      ...audit,
      runtime_coverage: runtimeCoverage,
      results: checks.map((check) => ({
        id: check.id,
        command: check.command,
        exit_code: check.exit_code
      })),
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

  const tierResult = await maximumTaskTier(repoRoot, taskIds, config);
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
    structural_oracle: structuralOracle
  };
}

function fullSuiteAudit(
  config: HivemindConfig,
  changedFiles: string[],
  reason: string,
  structuralOracle: StructuralOracleMeasurement
): VerificationAudit {
  return {
    mode: "full",
    reason,
    changed_files: changedFiles,
    impact_set: changedFiles,
    selected_checks: [{ id: "full-suite", command: config.test_command, sources: ["fail-safe"] }],
    skipped_checks: [],
    graph_fingerprint: null,
    canon_ids: [],
    structural_oracle: structuralOracle
  };
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

async function maximumTaskTier(
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

async function runCheck(cwd: string, id: string, command: string): Promise<VerificationCheckResult> {
  try {
    const result = await execAsync(command, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
    return { id, command, exit_code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    return {
      id,
      command,
      exit_code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "",
      stderr: typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
    };
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
