import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeTask } from "./analyze.js";
import { writeJsonAtomic } from "./atomic.js";
import { loadConfig, type HivemindConfig } from "./config.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents } from "./events.js";
import {
  loadIntegrationQueue,
  type IntegrationQueueEntry,
  type IntegrationStatus
} from "./integration-state.js";
import { withLeaseLock } from "./lease-lock.js";
import { requireTaskDependenciesIntegrated } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified } from "./spec.js";
import { validateRequestedTaskId } from "./task-id.js";
import { type TaskTier } from "./routing.js";
import {
  resolveMaximumTaskTier,
  runVerification,
  type QualityDraftVerificationContext,
  type VerificationRunResult
} from "./verification.js";
import {
  captureVerificationInputs,
  verificationInputsStillMatch,
  writeVerificationSet,
  type StoredVerificationSet,
  type VerificationSetOracleAssessment
} from "./verification-set.js";

export type { IntegrationQueueEntry, IntegrationStatus } from "./integration-state.js";
export type { VerificationRunResult } from "./verification.js";

const execFileAsync = promisify(execFile);

export interface EnqueueIntegrationPatchResult {
  task_id: string;
  queue_path: string;
  queue: string[];
}

export interface IntegrationQueueExpectation {
  expected_task_ids: string[];
  expected_queue_sha256: string;
}

export async function captureIntegrationQueueExpectation(
  repoRoot: string,
  expectedTaskIds: string[]
): Promise<{ ok: true; value: IntegrationQueueExpectation } | { ok: false; reason: string }> {
  const queue = await loadIntegrationQueue(repoRoot);
  if (!queue.ok) return queue;
  const actualTaskIds = queue.value.map((entry) => entry.task_id);
  if (!sameTaskIds(actualTaskIds, expectedTaskIds)) {
    return {
      ok: false,
      reason: `integration queue identity mismatch: expected [${expectedTaskIds.join(", ")}], found [${actualTaskIds.join(", ")}]`
    };
  }
  return {
    ok: true,
    value: {
      expected_task_ids: [...actualTaskIds],
      expected_queue_sha256: hashIntegrationQueue(actualTaskIds)
    }
  };
}

export async function runShadowVerification(
  repoRoot: string,
  worktreeRoot: string,
  config: HivemindConfig,
  taskIds: string[],
  changedFiles: string[],
  qualityDraft?: QualityDraftVerificationContext
) {
  return runVerification(repoRoot, worktreeRoot, config, taskIds, changedFiles, qualityDraft);
}

interface GateSummary {
  taskId: string;
  verdict: "accept" | "reject" | "escalate";
  reason: string;
}

export interface OracleFloorAssessment extends VerificationSetOracleAssessment {
  coverage_configured: boolean;
  binding: boolean;
  task_tier: TaskTier;
  status: "unconfigured" | "strong" | "weak" | "unknown";
  decision: "proceed" | "proceed_low_confidence" | "block";
  diagnostic: string;
  uncovered_changed_lines: string[];
  uncovered_impact_files: string[];
  unknown_files: string[];
  unknown_reasons: string[];
  recommendation: string | null;
  automatic_generation_launched: false;
}

export async function integrateCommand(cwd: string, args: string[]): Promise<number> {
  const [flag, ...rest] = args;
  if (flag !== "--shadow" || rest.length > 0) {
    console.error("error: usage: hivemind integrate --shadow");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<IntegrationStatus>(repoRoot, "/integrate/shadow", {});
  const result = daemonResult.routed ? daemonResult : await integrateShadow(repoRoot);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return result.value.tests === "pass" ? 0 : 1;
}

export async function integrateShadow(
  repoRoot: string,
  expectation?: IntegrationQueueExpectation
): Promise<{ ok: true; value: IntegrationStatus } | { ok: false; reason: string }> {
  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const queueResult = await loadIntegrationQueue(repoRoot);
  if (!queueResult.ok) {
    return queueResult;
  }
  if (queueResult.value.length === 0) {
    return { ok: false, reason: "integration queue is empty" };
  }
  if (expectation !== undefined) {
    const expected = validateIntegrationQueueExpectation(expectation);
    if (!expected.ok) return expected;
    const actualTaskIds = queueResult.value.map((entry) => entry.task_id);
    if (
      !sameTaskIds(actualTaskIds, expected.value.expected_task_ids) ||
      hashIntegrationQueue(actualTaskIds) !== expected.value.expected_queue_sha256
    ) {
      return {
        ok: false,
        reason: `integration queue changed after survivor authorization: expected [${expected.value.expected_task_ids.join(", ")}], found [${actualTaskIds.join(", ")}]`
      };
    }
  }
  if (configResult.config.test_command.trim() === "") {
    return { ok: false, reason: "config.test_command must not be empty for shadow integration" };
  }

  const baseBranch = configResult.config.base_branch?.trim();
  if (!baseBranch) {
    return {
      ok: false,
      reason: "config.base_branch is not recorded; check out the intended base branch and run hivemind init again"
    };
  }
  const branchFormat = await git(repoRoot, ["check-ref-format", "--branch", baseBranch]);
  if (!branchFormat.ok) {
    return { ok: false, reason: `configured base branch ${baseBranch} is invalid` };
  }
  const baseRef = `refs/heads/${baseBranch}`;
  const baseResult = await git(repoRoot, ["rev-parse", "--verify", baseRef]);
  if (!baseResult.ok) {
    return { ok: false, reason: `configured base branch ${baseBranch} not found` };
  }

  const gateResult = await gateQueue(repoRoot, queueResult.value);
  if (!gateResult.ok) {
    return gateResult;
  }

  const accepted = gateResult.value.filter((summary) => summary.verdict === "accept").map((summary) => summary.taskId);
  if (accepted.length === 0) {
    return { ok: false, reason: "no accepted patches to integrate" };
  }
  const verificationInputs = await captureVerificationInputs(repoRoot, accepted);
  if (!verificationInputs.ok) {
    return verificationInputs;
  }

  const timestamp = integrationTimestamp();
  const branch = `integration/${timestamp}`;
  const worktreePath = path.join(repoRoot, ".hivemind", "integration", "worktrees", timestamp);
  let worktreeCreated = false;
  let status: IntegrationStatus | null = null;
  let outcome: { ok: true; value: IntegrationStatus } | { ok: false; reason: string } | null = null;
  let cleanupErrors: string[] = [];

  try {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const worktreeResult = await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
    if (!worktreeResult.ok) {
      outcome = { ok: false, reason: worktreeResult.reason };
    } else {
      worktreeCreated = true;

      for (const taskId of accepted) {
        const applyResult = await git(worktreePath, ["apply", "--index", patchPath(repoRoot, taskId)]);
        if (!applyResult.ok) {
          const applyError = `failed to apply ${taskId}: ${applyResult.reason}`;
          status = {
            branch,
            applied: accepted.slice(0, accepted.indexOf(taskId)),
            tests: "fail",
            report: buildReport(gateResult.value, null, applyError)
          };
          await writeIntegrationStatus(repoRoot, status);
          const eventResult = await appendIntegrationEvent(repoRoot, status);
          outcome = eventResult.ok ? { ok: true, value: status } : eventResult;
          break;
        }
      }

      if (outcome === null) {
        const changedFilesResult = await git(worktreePath, ["diff", "--cached", "--name-only", "-z"]);
        if (!changedFilesResult.ok) {
          outcome = { ok: false, reason: `failed to identify shadow changes: ${changedFilesResult.reason}` };
        } else {
          const verification = await runShadowVerification(
            repoRoot,
            worktreePath,
            configResult.config,
            accepted,
            changedFilesResult.stdout.split("\0").filter(Boolean)
          );
          if (!verification.ok) {
            outcome = verification;
          } else {
            const tierResult = await resolveMaximumTaskTier(repoRoot, accepted, configResult.config);
            if (!tierResult.ok) {
              outcome = { ok: false, reason: `oracle floor could not determine task tier: ${tierResult.reason}` };
            } else {
              const oracleFloor = assessOracleFloor(verification.value, tierResult.value);
              const report = buildReport(gateResult.value, verification.value, null, oracleFloor);
              if (verification.value.tests === "pass" && oracleFloor.decision === "block") {
                status = {
                  branch,
                  applied: accepted,
                  tests: "blocked",
                  report
                };
                const eventResult = await appendOracleFloorEvent(repoRoot, "integration.blocked", status, oracleFloor);
                if (!eventResult.ok) {
                  outcome = eventResult;
                } else {
                  await writeIntegrationStatus(repoRoot, status);
                  outcome = { ok: false, reason: oracleBlockReason(oracleFloor) };
                }
              } else {
                if (verification.value.tests === "pass" && oracleFloor.decision === "proceed_low_confidence") {
                  const confidenceEvent = await appendOracleFloorEvent(
                    repoRoot,
                    "integration.low_confidence",
                    {
                      branch,
                      applied: accepted,
                      tests: "pass",
                      report
                    },
                    oracleFloor
                  );
                  if (!confidenceEvent.ok) {
                    outcome = confidenceEvent;
                  }
                }
                if (outcome === null) {
                  let storedVerification: StoredVerificationSet | null = null;
                  if (verification.value.tests === "pass") {
                    const unchanged = await verificationInputsStillMatch(repoRoot, verificationInputs.value);
                    if (!unchanged.ok) {
                      outcome = unchanged;
                    } else {
                      const treeResult = await git(worktreePath, ["write-tree"]);
                      if (!treeResult.ok) {
                        outcome = { ok: false, reason: `failed to bind verified tree: ${treeResult.reason}` };
                      } else {
                        const stored = await writeVerificationSet(repoRoot, {
                          base_branch: baseBranch,
                          base_commit: baseResult.stdout.trim(),
                          task_ids: accepted,
                          inputs: verificationInputs.value.inputs,
                          changed_files: changedFilesResult.stdout.split("\0").filter(Boolean).sort(),
                          result_tree: treeResult.stdout.trim(),
                          config_path: ".hivemind/config.json",
                          config_sha256: verificationInputs.value.config_sha256,
                          verification: { ...verification.value, tests: "pass" },
                          oracle: oracleFloor
                        });
                        if (!stored.ok) outcome = stored;
                        else storedVerification = stored.value;
                      }
                    }
                  }
                  if (outcome === null) {
                    status = {
                      branch,
                      applied: accepted,
                      tests: verification.value.tests,
                      report,
                      ...(storedVerification === null
                        ? {}
                        : {
                            verification_id: storedVerification.manifest.verification_id,
                            verification_manifest_path: storedVerification.manifest_path,
                            verification_manifest_sha256: storedVerification.manifest_sha256
                          })
                    };
                    await writeIntegrationStatus(repoRoot, status);
                    const eventResult = await appendIntegrationEvent(repoRoot, status);
                    outcome = eventResult.ok ? { ok: true, value: status } : eventResult;
                  }
                }
              }
            }
          }
        }
      }
    }
  } finally {
    cleanupErrors = await cleanupShadow(repoRoot, worktreePath, branch, worktreeCreated);
  }

  if (cleanupErrors.length > 0) {
    return { ok: false, reason: `shadow cleanup failed: ${cleanupErrors.join("; ")}` };
  }

  return outcome ?? { ok: false, reason: "shadow integration did not produce a result" };
}

function validateIntegrationQueueExpectation(
  value: IntegrationQueueExpectation
): { ok: true; value: IntegrationQueueExpectation } | { ok: false; reason: string } {
  if (!Array.isArray(value.expected_task_ids) || value.expected_task_ids.length === 0) {
    return { ok: false, reason: "integration queue expectation requires at least one expected task id" };
  }
  const unique = new Set<string>();
  for (const taskId of value.expected_task_ids) {
    const valid = validateRequestedTaskId(taskId);
    if (!valid.ok || unique.has(taskId)) {
      return { ok: false, reason: `integration queue expectation has invalid or duplicate task id: ${taskId}` };
    }
    unique.add(taskId);
  }
  if (!/^[a-f0-9]{64}$/u.test(value.expected_queue_sha256)) {
    return { ok: false, reason: "integration queue expectation requires a SHA-256 queue identity" };
  }
  return { ok: true, value: { expected_task_ids: [...value.expected_task_ids], expected_queue_sha256: value.expected_queue_sha256 } };
}

function hashIntegrationQueue(taskIds: string[]): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, task_ids: taskIds })).digest("hex");
}

function sameTaskIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((taskId, index) => taskId === right[index]);
}

export async function enqueueIntegrationPatch(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: EnqueueIntegrationPatchResult } | { ok: false; reason: string }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const patchResult = await statPatchBundle(repoRoot, taskId);
  if (!patchResult.ok) {
    return patchResult;
  }

  const dependencyResult = await requireDependenciesIfPlanBacked(repoRoot, taskId);
  if (!dependencyResult.ok) {
    return dependencyResult;
  }

  const acceptedResult = await requireAcceptedPatchEvidence(repoRoot, taskId);
  if (!acceptedResult.ok) {
    return acceptedResult;
  }

  // Load, duplicate-check and write are one read-modify-write on a shared file,
  // so they hold the same lock lease.ts uses for the identical pattern.
  // Reentrancy is not a concern here: adoption is the only caller that runs
  // inside the lease lock, and it never enqueues.
  //
  // loadIntegrationQueue already dropped entries the trail shows as adopted, so
  // writing the loaded list back is also what physically compacts the file.
  const queuePath = path.join(repoRoot, ".hivemind", "integration", "queue.json");
  const guarded = await withLeaseLock<IntegrationQueueEntry[]>(repoRoot, async () => {
    const queueResult = await loadQueueOrEmpty(repoRoot);
    if (!queueResult.ok) {
      return queueResult;
    }
    if (queueResult.value.some((entry) => entry.task_id === taskId)) {
      return { ok: false, reason: `integration queue already contains ${taskId}` };
    }
    const next = [...queueResult.value, { task_id: taskId }];
    await writeJsonAtomic(queuePath, next);
    return { ok: true, value: next };
  });
  if (!guarded.ok) {
    return guarded;
  }
  const nextQueue = guarded.value;
  const eventResult = await appendEvent(repoRoot, {
    type: "integration.queued",
    task_id: taskId,
    data: {
      queue_path: ".hivemind/integration/queue.json",
      position: nextQueue.length,
      queue: nextQueue.map((entry) => entry.task_id)
    }
  });
  if (!eventResult.ok) {
    return { ok: false, reason: `failed to append integration.queued event: ${eventResult.reason}` };
  }
  return {
    ok: true,
    value: {
      task_id: taskId,
      queue_path: ".hivemind/integration/queue.json",
      queue: nextQueue.map((entry) => entry.task_id)
    }
  };
}

async function loadQueueOrEmpty(repoRoot: string): Promise<{ ok: true; value: IntegrationQueueEntry[] } | { ok: false; reason: string }> {
  const queueResult = await loadIntegrationQueue(repoRoot);
  if (queueResult.ok) {
    return queueResult;
  }
  return queueResult.reason.includes("integration queue not found") ? { ok: true, value: [] } : queueResult;
}

async function gateQueue(repoRoot: string, queue: IntegrationQueueEntry[]): Promise<{ ok: true; value: GateSummary[] } | { ok: false; reason: string }> {
  const summaries: GateSummary[] = [];
  for (const entry of queue) {
    const result = await analyzeTask(repoRoot, entry.task_id);
    if (!result.ok) {
      return { ok: false, reason: `failed to analyze ${entry.task_id}: ${result.reason}` };
    }
    summaries.push({
      taskId: entry.task_id,
      verdict: result.value.verdict,
      reason: result.value.reason
    });
  }
  return { ok: true, value: summaries };
}

function buildReport(
  gateSummaries: GateSummary[],
  verification: VerificationRunResult | null,
  applyError: string | null,
  oracleFloor: OracleFloorAssessment | null = null
): string {
  const lines = [
    "gate results:",
    ...gateSummaries.map((summary) => `- ${summary.taskId}: ${summary.verdict} (${summary.reason})`)
  ];

  if (applyError !== null) {
    lines.push(`apply: fail (${applyError})`);
  }
  if (verification !== null) {
    lines.push(`verification mode: ${verification.audit.mode}`);
    lines.push(`verification reason: ${verification.audit.reason}`);
    lines.push(
      `structural oracle: ${verification.audit.structural_oracle.status} (advisory; structural evidence is not runtime coverage)`
    );
    lines.push(`structurally covered impact files: ${verification.audit.structural_oracle.covered_impact_files.join(", ") || "(none)"}`);
    lines.push(`structurally uncovered impact files: ${verification.audit.structural_oracle.uncovered_impact_files.join(", ") || "(none)"}`);
    lines.push(`structurally unknown impact files: ${verification.audit.structural_oracle.unknown_impact_files.join(", ") || "(none)"}`);
    lines.push(`structural oracle unknown reasons: ${verification.audit.structural_oracle.unknown_reasons.join("; ") || "(none)"}`);
    lines.push(`runtime changed-line coverage: ${verification.runtime_coverage.status}`);
    lines.push(`runtime coverage coordinate space: ${verification.runtime_coverage.coordinate_space}`);
    lines.push(`runtime coverage applied tree: ${verification.runtime_coverage.applied_tree ?? "(none)"}`);
    lines.push(
      `runtime coverage ratio: ${verification.runtime_coverage.hit_changed_lines}/${verification.runtime_coverage.executable_changed_lines}`
    );
    lines.push(`runtime coverage unknown files: ${verification.runtime_coverage.unknown_files.join(", ") || "(none)"}`);
    lines.push(`runtime coverage unknown reasons: ${verification.runtime_coverage.unknown_reasons.join("; ") || "(none)"}`);
    lines.push(`selected checks: ${verification.audit.selected_checks.map((check) => check.id).join(", ")}`);
    lines.push(`contract validity checks: ${verification.audit.contract_validity_checks.map((check) => check.id).join(", ") || "(none)"}`);
    lines.push(`skipped checks: ${verification.audit.skipped_checks.map((check) => check.id).join(", ") || "(none)"}`);
    for (const check of verification.checks) {
      lines.push(`check ${check.id}: ${check.command}`);
      lines.push(`check ${check.id} exit code: ${check.exit_code}`);
      lines.push(`stdout:\n${trimReportOutput(check.stdout)}`);
      lines.push(`stderr:\n${trimReportOutput(check.stderr)}`);
    }
  }
  if (oracleFloor !== null) {
    lines.push(`oracle floor task tier: ${oracleFloor.task_tier}`);
    lines.push(`oracle floor coverage configured: ${oracleFloor.coverage_configured}`);
    lines.push(`oracle floor binding: ${oracleFloor.binding}`);
    lines.push(`oracle floor status: ${oracleFloor.status}`);
    lines.push(`oracle floor decision: ${oracleFloor.decision}`);
    lines.push(`oracle floor diagnostic: ${oracleFloor.diagnostic}`);
    lines.push(`oracle floor uncovered changed lines: ${oracleFloor.uncovered_changed_lines.join(", ") || "(none)"}`);
    lines.push(`oracle floor uncovered impact files: ${oracleFloor.uncovered_impact_files.join(", ") || "(none)"}`);
    lines.push(`oracle floor unknown files: ${oracleFloor.unknown_files.join(", ") || "(none)"}`);
    lines.push(`oracle floor unknown reasons: ${oracleFloor.unknown_reasons.join("; ") || "(none)"}`);
    lines.push(`oracle floor remediation: ${oracleFloor.recommendation ?? "(none)"}`);
    lines.push("oracle floor automatic characterization launched: false");
  }

  return `${lines.join("\n")}\n`;
}

function assessOracleFloor(verification: VerificationRunResult, taskTier: TaskTier): OracleFloorAssessment {
  const runtime = verification.runtime_coverage;
  const structural = verification.audit.structural_oracle;
  const highRisk = taskTier === "high" || taskTier === "critical";
  const uncoveredChangedLines = runtime.uncovered_lines.map((line) => `${line.file}:${line.line}`);
  const unknownFiles = [...new Set([...runtime.unknown_files, ...structural.unknown_impact_files])].sort();
  const unknownReasons = [...new Set([...runtime.unknown_reasons, ...structural.unknown_reasons])];

  if (!runtime.configured || runtime.status === "unconfigured") {
    return {
      coverage_configured: false,
      binding: false,
      task_tier: taskTier,
      status: "unconfigured",
      decision: "proceed",
      diagnostic: "coverage is not configured; the structural oracle remains advisory and the M7.6d floor does not bind",
      uncovered_changed_lines: [],
      uncovered_impact_files: structural.uncovered_impact_files,
      unknown_files: unknownFiles,
      unknown_reasons: unknownReasons,
      recommendation: null,
      automatic_generation_launched: false
    };
  }

  const status =
    runtime.status === "weak" || structural.status === "uncovered"
      ? "weak"
      : runtime.status === "unknown" || structural.status === "unknown"
        ? "unknown"
        : "strong";
  const diagnostic =
    status === "weak"
      ? "configured oracle evidence was measured, but coverage is thin"
      : status === "unknown"
        ? "configured oracle evidence could not be measured with confidence"
        : "configured runtime changed-line coverage is complete and every graph-resolved impact file has an exercising check";
  return {
    coverage_configured: true,
    binding: highRisk,
    task_tier: taskTier,
    status,
    decision: status === "strong" ? "proceed" : highRisk ? "block" : "proceed_low_confidence",
    diagnostic,
    uncovered_changed_lines: uncoveredChangedLines,
    uncovered_impact_files: structural.uncovered_impact_files,
    unknown_files: unknownFiles,
    unknown_reasons: unknownReasons,
    recommendation: status === "strong" ? null : "hivemind verify characterize ...",
    automatic_generation_launched: false
  };
}

function oracleBlockReason(assessment: OracleFloorAssessment): string {
  const details = [
    `oracle floor blocked shadow integration: configured coverage is ${assessment.status} for ${assessment.task_tier} tier`,
    assessment.diagnostic,
    `uncovered changed lines: ${assessment.uncovered_changed_lines.join(", ") || "(none)"}`,
    `uncovered impact files: ${assessment.uncovered_impact_files.join(", ") || "(none)"}`,
    `unknown files: ${assessment.unknown_files.join(", ") || "(none)"}`,
    `unknown reasons: ${assessment.unknown_reasons.join("; ") || "(none)"}`,
    `recommended remediation: ${assessment.recommendation}`
  ];
  return details.join("; ");
}

function trimReportOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 8000 ? `${trimmed.slice(0, 8000)}\n[truncated]` : trimmed;
}

async function writeIntegrationStatus(repoRoot: string, status: IntegrationStatus): Promise<void> {
  await writeJsonAtomic(path.join(repoRoot, ".hivemind", "integration", "status.json"), status);
}

async function appendIntegrationEvent(repoRoot: string, status: IntegrationStatus): Promise<{ ok: true } | { ok: false; reason: string }> {
  const eventType = status.tests === "pass" ? "integration.passed" : "integration.failed";
  const eventResult = await appendEvent(repoRoot, {
    type: eventType,
    task_id: null,
    data: {
      branch: status.branch,
      applied: status.applied,
      tests: status.tests,
      report: status.report,
      ...(status.verification_id === undefined ? {} : {
        verification_id: status.verification_id,
        verification_manifest_path: status.verification_manifest_path,
        verification_manifest_sha256: status.verification_manifest_sha256
      })
    }
  });
  return eventResult.ok ? { ok: true } : { ok: false, reason: `failed to append ${eventType} event: ${eventResult.reason}` };
}

async function appendOracleFloorEvent(
  repoRoot: string,
  type: "integration.blocked" | "integration.low_confidence",
  status: IntegrationStatus,
  oracleFloor: OracleFloorAssessment
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const eventResult = await appendEvent(repoRoot, {
    type,
    task_id: null,
    data: {
      branch: status.branch,
      applied: status.applied,
      tests: status.tests,
      report: status.report,
      oracle_floor: oracleFloor
    }
  });
  return eventResult.ok ? { ok: true } : { ok: false, reason: `failed to append ${type} event: ${eventResult.reason}` };
}

async function cleanupShadow(repoRoot: string, worktreePath: string, branch: string, worktreeCreated: boolean): Promise<string[]> {
  const errors: string[] = [];
  if (worktreeCreated) {
    const removeResult = await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (!removeResult.ok) {
      errors.push(removeResult.reason);
    }
  } else {
    await rm(worktreePath, { recursive: true, force: true });
  }

  const branchResult = await git(repoRoot, ["branch", "-D", branch]);
  if (!branchResult.ok && !branchResult.reason.includes("not found")) {
    errors.push(branchResult.reason);
  }

  return errors;
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
    return { ok: true, stdout: result.stdout };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

function patchPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
}

async function statPatchBundle(repoRoot: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const filePath = patchPath(repoRoot, taskId);
  try {
    const file = await stat(filePath);
    if (!file.isFile()) {
      return { ok: false, reason: `.hivemind/patches/${taskId}/diff.patch is not a file` };
    }
    const patch = await readFile(filePath, "utf8");
    if (patch.trim() === "") {
      return { ok: false, reason: `patch bundle is empty: .hivemind/patches/${taskId}/diff.patch` };
    }
    return { ok: true };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `patch bundle not found: .hivemind/patches/${taskId}/diff.patch` };
    }
    throw error;
  }
}

async function requireAcceptedPatchEvidence(repoRoot: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const eventsResult = await readEvents(repoRoot);
  if (!eventsResult.ok) {
    return eventsResult;
  }

  let latestSubmitIndex = -1;
  let latestAcceptedIndex = -1;
  let latestRejectedIndex = -1;
  for (const [index, event] of eventsResult.value.entries()) {
    if (event.task_id !== taskId) {
      continue;
    }
    if (event.type === "patch.submitted") {
      latestSubmitIndex = index;
      latestAcceptedIndex = -1;
      latestRejectedIndex = -1;
      continue;
    }
    if (latestSubmitIndex === -1 || index <= latestSubmitIndex) {
      continue;
    }
    if (event.type === "patch.accepted" && event.data.verdict === "accept") {
      latestAcceptedIndex = index;
    }
    if (event.type === "patch.rejected") {
      latestRejectedIndex = index;
    }
  }

  if (latestSubmitIndex === -1) {
    return { ok: false, reason: `patch ${taskId} has no patch.submitted event` };
  }
  if (latestAcceptedIndex === -1) {
    return { ok: false, reason: `patch ${taskId} has no patch.accepted event after latest patch.submitted` };
  }
  if (latestRejectedIndex > latestAcceptedIndex) {
    return { ok: false, reason: `latest analysis for patch ${taskId} is patch.rejected` };
  }

  return { ok: true };
}

async function requireDependenciesIfPlanBacked(repoRoot: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult.reason.startsWith("no active spec") ? { ok: true } : specResult;
  }
  const dependencyResult = await requireTaskDependenciesIntegrated(repoRoot, specResult.value.spec_id, taskId);
  if (!dependencyResult.ok && dependencyResult.reason.includes("tentative plan not found")) {
    return { ok: true };
  }
  return dependencyResult;
}

function integrationTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
