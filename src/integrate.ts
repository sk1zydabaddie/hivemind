import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeTask } from "./analyze.js";
import { writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents } from "./events.js";
import {
  loadIntegrationQueue,
  type IntegrationQueueEntry,
  type IntegrationStatus
} from "./integration-state.js";
import { requireTaskDependenciesIntegrated } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified } from "./spec.js";
import { validateRequestedTaskId } from "./task-id.js";
import { runVerification, type VerificationRunResult } from "./verification.js";

export type { IntegrationQueueEntry, IntegrationStatus } from "./integration-state.js";

const execFileAsync = promisify(execFile);

export interface EnqueueIntegrationPatchResult {
  task_id: string;
  queue_path: string;
  queue: string[];
}

interface GateSummary {
  taskId: string;
  verdict: "accept" | "reject" | "escalate";
  reason: string;
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
  repoRoot: string
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
  if (configResult.config.test_command.trim() === "") {
    return { ok: false, reason: "config.test_command must not be empty for shadow integration" };
  }

  const mainResult = await git(repoRoot, ["rev-parse", "--verify", "main"]);
  if (!mainResult.ok) {
    return { ok: false, reason: "base branch main not found" };
  }

  const gateResult = await gateQueue(repoRoot, queueResult.value);
  if (!gateResult.ok) {
    return gateResult;
  }

  const accepted = gateResult.value.filter((summary) => summary.verdict === "accept").map((summary) => summary.taskId);
  if (accepted.length === 0) {
    return { ok: false, reason: "no accepted patches to integrate" };
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
    const worktreeResult = await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "main"]);
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
          const verification = await runVerification(
            repoRoot,
            worktreePath,
            configResult.config,
            accepted,
            changedFilesResult.stdout.split("\0").filter(Boolean)
          );
          if (!verification.ok) {
            outcome = verification;
          } else {
            status = {
              branch,
              applied: accepted,
              tests: verification.value.tests,
              report: buildReport(gateResult.value, verification.value, null)
            };
            await writeIntegrationStatus(repoRoot, status);
            const eventResult = await appendIntegrationEvent(repoRoot, status);
            outcome = eventResult.ok ? { ok: true, value: status } : eventResult;
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

  const queueResult = await loadQueueOrEmpty(repoRoot);
  if (!queueResult.ok) {
    return queueResult;
  }
  if (queueResult.value.some((entry) => entry.task_id === taskId)) {
    return { ok: false, reason: `integration queue already contains ${taskId}` };
  }

  const nextQueue = [...queueResult.value, { task_id: taskId }];
  const queuePath = path.join(repoRoot, ".hivemind", "integration", "queue.json");
  await writeJsonAtomic(queuePath, nextQueue);
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
  applyError: string | null
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
    lines.push(`selected checks: ${verification.audit.selected_checks.map((check) => check.id).join(", ")}`);
    lines.push(`skipped checks: ${verification.audit.skipped_checks.map((check) => check.id).join(", ") || "(none)"}`);
    for (const check of verification.checks) {
      lines.push(`check ${check.id}: ${check.command}`);
      lines.push(`check ${check.id} exit code: ${check.exit_code}`);
      lines.push(`stdout:\n${trimReportOutput(check.stdout)}`);
      lines.push(`stderr:\n${trimReportOutput(check.stderr)}`);
    }
  }

  return `${lines.join("\n")}\n`;
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
      report: status.report
    }
  });
  return eventResult.ok ? { ok: true } : { ok: false, reason: `failed to append ${eventType} event: ${eventResult.reason}` };
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
