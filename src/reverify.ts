import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { integrateShadow } from "./integrate.js";
import { loadIntegrationQueue } from "./integration-state.js";
import { verifyLeaseCoverage } from "./lease.js";

const execFileAsync = promisify(execFile);

export interface ReverificationResult {
  verification_id: string;
  manifest_path: string;
  manifest_sha256: string;
  task_ids: string[];
  superseded: { event_type: string; event_at: string; verification_id: string | null } | null;
}

type ReverificationOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function reverifyQueuedPatchSet(repoRoot: string): Promise<ReverificationOutcome<ReverificationResult>> {
  const queue = await loadIntegrationQueue(repoRoot);
  if (!queue.ok) return queue;
  if (queue.value.length === 0) return { ok: false, reason: "cannot re-run checks because the integration queue is empty" };
  const taskIds = queue.value.map((entry) => entry.task_id);
  if (new Set(taskIds).size !== taskIds.length) return { ok: false, reason: "cannot re-run checks for a queue containing duplicate tasks" };

  const config = await loadConfig(repoRoot);
  if (!config.ok) return config;
  const baseBranch = config.config.base_branch?.trim();
  if (!baseBranch) return { ok: false, reason: "cannot re-run checks because the project base branch is not configured" };
  const liveBase = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${baseBranch}`]);
  if (!liveBase.ok) return { ok: false, reason: `cannot re-run checks because the project base branch cannot be resolved: ${liveBase.reason}` };

  for (const taskId of taskIds) {
    const contract = await loadAndValidateContract(repoRoot, taskId);
    if (!contract.ok) return contract;
    if (contract.contract.base_commit !== liveBase.value) {
      return {
        ok: false,
        reason: `cannot re-run checks for ${taskId}: the project base moved since its immutable contract; re-plan the task against ${liveBase.value}`
      };
    }
    const lease = await verifyLeaseCoverage(repoRoot, taskId, contract.contract.allowed_files, {
      baseCommit: contract.contract.base_commit,
      allowedFileIntents: contract.contract.allowed_file_intents
    });
    if (!lease.ok) return { ok: false, reason: `cannot re-run checks because ${taskId}'s edit ownership is no longer valid: ${lease.reason}` };
  }

  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const previous = latestVerificationTerminal(events.value);
  const superseded = previous === undefined ? null : {
    event_type: previous.type,
    event_at: previous.ts,
    verification_id: typeof previous.data.verification_id === "string" ? previous.data.verification_id : null
  };
  const started = await appendEvent(repoRoot, {
    type: "verification.rerun_started",
    task_id: null,
    data: { task_ids: taskIds, base_branch: baseBranch, base_commit: liveBase.value, superseded }
  });
  if (!started.ok) return { ok: false, reason: `failed to record fresh-check start: ${started.reason}` };

  const verified = await integrateShadow(repoRoot);
  if (!verified.ok) return recordFailure(repoRoot, taskIds, superseded, verified.reason);
  if (
    verified.value.tests !== "pass" ||
    typeof verified.value.verification_id !== "string" ||
    typeof verified.value.verification_manifest_path !== "string" ||
    typeof verified.value.verification_manifest_sha256 !== "string"
  ) {
    return recordFailure(repoRoot, taskIds, superseded, "fresh checks did not produce an adoptable verification-time manifest");
  }

  const value: ReverificationResult = {
    verification_id: verified.value.verification_id,
    manifest_path: verified.value.verification_manifest_path,
    manifest_sha256: verified.value.verification_manifest_sha256,
    task_ids: taskIds,
    superseded
  };
  const completed = await appendEvent(repoRoot, {
    type: "verification.rerun_completed",
    task_id: null,
    data: { ...value }
  });
  return completed.ok ? { ok: true, value } : { ok: false, reason: `fresh checks passed but completion audit failed: ${completed.reason}` };
}

async function recordFailure<T>(
  repoRoot: string,
  taskIds: string[],
  superseded: ReverificationResult["superseded"],
  reason: string
): Promise<ReverificationOutcome<T>> {
  const event = await appendEvent(repoRoot, {
    type: "verification.rerun_failed",
    task_id: null,
    data: { task_ids: taskIds, superseded, reason }
  });
  return event.ok ? { ok: false, reason } : { ok: false, reason: `${reason}; failed to record fresh-check failure: ${event.reason}` };
}

function latestVerificationTerminal(events: HivemindEvent[]): HivemindEvent | undefined {
  return [...events].reverse().find((event) => ["integration.passed", "integration.failed", "integration.blocked"].includes(event.type));
}

async function git(repoRoot: string, args: string[]): Promise<ReverificationOutcome<string>> {
  try {
    const result = await execFileAsync("git", args, { cwd: repoRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, value: result.stdout.trim() };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}
