import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

interface VerifiedCorpusTask {
  task_id: string;
  case_id: "documentation" | "library" | "dependent_cli";
  expected_tier: "low" | "medium" | "high" | "critical";
  routing_task_type: RoutingTaskType;
}

interface VerifiedCorpusDescription {
  version: 1;
  execution: "sequential_per_profile";
  isolation: "project_namespaced_disposable_repositories";
  adoption: false;
  promotion: false;
  expected_provider_calls: number;
  profiles: Array<{ tool: string; model: string }>;
  tasks: VerifiedCorpusTask[];
  pricing_note: string;
}

export interface VerifiedCorpusAttempt {
  corpus_run_id: string;
  iteration: number;
  tool: string;
  model: string;
  task_id: string;
  case_id: VerifiedCorpusTask["case_id"];
  task_tier: VerifiedCorpusTask["expected_tier"];
  artifact_path: string;
  diff_sha256: string;
  success: boolean;
  gate: { verdict?: unknown } | null;
  exit_code: number | null;
  wall_time_ms: number;
  self_measured_tokens: number | null;
  provider_reported_usage: { total_tokens?: number } | null;
  revision_count: number;
  cost_usd: number | null;
}

interface VerifiedCorpusReport {
  corpus_run_id: string;
  started_at: string;
  completed_at: string;
  attempts: VerifiedCorpusAttempt[];
}

export interface VerifiedCapabilityCorpusReport {
  report: VerifiedCorpusReport;
  definition: VerifiedCorpusDescription;
  report_sha256: string;
  manifest_sha256: string;
  report_path: string;
  manifest_path: string;
}

export async function readVerifiedCapabilityCorpusReport(
  repoRoot: string,
  corpusRunId: string
): Promise<{ ok: true; value: VerifiedCapabilityCorpusReport } | { ok: false; reason: string }> {
  if (!/^CC-[A-Za-z0-9-]+$/u.test(corpusRunId)) {
    return { ok: false, reason: "corpus run id must start with CC- and contain only letters, numbers, and hyphens" };
  }
  const corpusRoot = path.resolve(repoRoot, ".hivemind", "resource", "capability-corpus", corpusRunId);
  const manifestPath = path.join(corpusRoot, "manifest.json");
  const reportPath = path.join(corpusRoot, "report.json");
  let manifestText: string;
  let reportText: string;
  let manifest: Record<string, unknown>;
  let rawReport: Record<string, unknown>;
  try {
    manifestText = await readFile(manifestPath, "utf8");
    reportText = await readFile(reportPath, "utf8");
    manifest = parseRecordJson(manifestText, "capability corpus manifest");
    rawReport = parseRecordJson(reportText, "capability corpus report");
  } catch (error: unknown) {
    return { ok: false, reason: errorMessage(error) };
  }
  const definition = manifest.definition;
  if (!isCapabilityCorpusDescription(definition)) {
    return { ok: false, reason: "capability corpus manifest has an invalid definition" };
  }
  const definitionHash = hashJson(definition);
  const gatedManifest = checkFormatVersion(manifest, formatVersions.capabilityCorpusManifest, "the capability corpus manifest");
  if (!gatedManifest.ok) {
    return { ok: false, reason: gatedManifest.reason };
  }
  if (
    manifest.corpus_run_id !== corpusRunId ||
    manifest.definition_sha256 !== definitionHash ||
    manifest.advisory_only !== true ||
    manifest.shadow_only !== true ||
    manifest.routing_authority !== false
  ) {
    return { ok: false, reason: "capability corpus manifest identity or safety fields do not verify" };
  }
  const gatedReport = checkFormatVersion(rawReport, formatVersions.capabilityCorpusReport, "the capability corpus report");
  if (!gatedReport.ok) {
    return { ok: false, reason: gatedReport.reason };
  }
  if (
    rawReport.corpus_run_id !== corpusRunId ||
    rawReport.corpus_definition_sha256 !== definitionHash ||
    rawReport.advisory_only !== true ||
    rawReport.shadow_only !== true ||
    rawReport.routing_authority !== false ||
    !Array.isArray(rawReport.attempts) ||
    typeof rawReport.started_at !== "string" ||
    typeof rawReport.completed_at !== "string"
  ) {
    return { ok: false, reason: "capability corpus report identity or safety fields do not verify" };
  }
  if (rawReport.attempts.length !== definition.expected_provider_calls) {
    return { ok: false, reason: "capability corpus report attempt count does not match its manifest" };
  }
  const tasks = new Map(definition.tasks.map((task) => [task.task_id, task]));
  const profiles = new Map(definition.profiles.map((profile) => [profile.tool, profile]));
  const normalizedAttempts: VerifiedCorpusAttempt[] = [];
  for (const [index, rawAttempt] of rawReport.attempts.entries()) {
    if (!isRecord(rawAttempt)) return { ok: false, reason: `capability corpus attempt ${index + 1} is not an object` };
    const iteration = rawAttempt.iteration === undefined ? 1 : rawAttempt.iteration;
    if (!Number.isSafeInteger(iteration) || Number(iteration) < 1) {
      return { ok: false, reason: `capability corpus attempt ${index + 1} has an invalid iteration` };
    }
    const task = typeof rawAttempt.task_id === "string" ? tasks.get(rawAttempt.task_id) : undefined;
    const profile = typeof rawAttempt.tool === "string" ? profiles.get(rawAttempt.tool) : undefined;
    if (
      task === undefined ||
      profile === undefined ||
      rawAttempt.corpus_run_id !== corpusRunId ||
      rawAttempt.case_id !== task.case_id ||
      rawAttempt.task_tier !== task.expected_tier ||
      rawAttempt.model !== profile.model ||
      typeof rawAttempt.artifact_path !== "string" ||
      typeof rawAttempt.diff_sha256 !== "string"
    ) {
      return { ok: false, reason: `capability corpus attempt ${index + 1} does not match the manifest` };
    }
    const attemptRoot = path.resolve(repoRoot, rawAttempt.artifact_path);
    if (!isWithin(attemptRoot, corpusRoot)) {
      return { ok: false, reason: `capability corpus attempt ${index + 1} artifact path escapes its run` };
    }
    try {
      const result = parseRecordJson(
        await readFile(path.join(attemptRoot, "result.json"), "utf8"),
        `capability corpus attempt ${index + 1} result`
      );
      if (hashJson(result) !== hashJson(rawAttempt)) {
        return { ok: false, reason: `capability corpus report attempt ${index + 1} does not match its immutable result` };
      }
      const diff = await readFile(path.join(attemptRoot, "diff.patch"), "utf8");
      if (hashText(diff) !== rawAttempt.diff_sha256) {
        return { ok: false, reason: `capability corpus attempt ${index + 1} patch hash does not verify` };
      }
    } catch (error: unknown) {
      return { ok: false, reason: errorMessage(error) };
    }
    normalizedAttempts.push({ ...rawAttempt, iteration: Number(iteration) } as unknown as VerifiedCorpusAttempt);
  }
  return {
    ok: true,
    value: {
      report: {
        corpus_run_id: corpusRunId,
        started_at: rawReport.started_at,
        completed_at: rawReport.completed_at,
        attempts: normalizedAttempts
      },
      definition,
      report_sha256: hashText(reportText),
      manifest_sha256: hashText(manifestText),
      report_path: artifactPath(repoRoot, reportPath),
      manifest_path: artifactPath(repoRoot, manifestPath)
    }
  };
}

function parseRecordJson(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

function isCapabilityCorpusDescription(value: unknown): value is VerifiedCorpusDescription {
  if (
    !isRecord(value) || value.version !== 1 || value.execution !== "sequential_per_profile" ||
    value.isolation !== "project_namespaced_disposable_repositories" || value.adoption !== false ||
    value.promotion !== false || !Number.isSafeInteger(value.expected_provider_calls) ||
    Number(value.expected_provider_calls) < 1 || !Array.isArray(value.profiles) || value.profiles.length === 0 ||
    !Array.isArray(value.tasks) || value.tasks.length === 0 || typeof value.pricing_note !== "string"
  ) return false;
  if (value.profiles.some((profile) =>
    !isRecord(profile) || typeof profile.tool !== "string" || typeof profile.model !== "string" ||
    (profile.routing_tier !== "cheap" && profile.routing_tier !== "standard" && profile.routing_tier !== "strong") ||
    !Number.isSafeInteger(profile.cost_rank) || !isRecord(profile.price)
  )) return false;
  return value.tasks.every((task) =>
    isRecord(task) && typeof task.task_id === "string" &&
    (task.case_id === "documentation" || task.case_id === "library" || task.case_id === "dependent_cli") &&
    typeof task.title === "string" &&
    (task.expected_tier === "low" || task.expected_tier === "medium" || task.expected_tier === "high" || task.expected_tier === "critical") &&
    isRoutingTaskType(task.routing_task_type) && Array.isArray(task.depends_on) &&
    typeof task.acceptance_criterion === "string" && typeof task.deterministic_validity_check === "string" &&
    Array.isArray(task.allowed_files) && isRecord(task.allowed_file_intents) &&
    Array.isArray(task.read_only_files) && Array.isArray(task.required_tests) && Array.isArray(task.patch_requirements)
  );
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifactPath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
