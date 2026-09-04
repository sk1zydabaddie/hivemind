import { isNodeError } from "./error-detail.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { listTaskIds, loadAndValidateContract } from "./contract.js";
import { readEvents, type HivemindEvent } from "./events.js";
import {
  integratedTaskIdsFromEvents,
  readIntegrationTaskIds,
  readIntegrationStatus,
  type IntegrationStatus
} from "./integration-state.js";
import { readActiveLeases, type LeaseStore } from "./lease.js";
import { listReplanStatuses, type ReplanStatus } from "./replan.js";
import { findGitRoot } from "./repo.js";

export interface HivemindStatus {
  tasks: StatusTask[];
  leases: LeaseStore;
  integration: {
    queue: string[];
    status: IntegrationStatus | null;
  };
  replans: ReplanStatus[];
}

export interface StatusTask {
  task_id: string;
  title: string;
  allowed_files: string[];
  lease: {
    held: boolean;
    files: string[];
  };
  worktree: "present" | "missing";
  patch: StatusPatch;
  queued: boolean;
  integrated: boolean;
}

export type StatusPatch =
  | {
      bundle: "absent";
      submitted: false;
      analyzed: false;
      accepted: false;
      verdict: null;
      reason: string;
      submitted_at: null;
      analyzed_at: null;
    }
  | {
      bundle: "present";
      submitted: boolean;
      analyzed: boolean;
      accepted: boolean;
      verdict: "accept" | "reject" | "escalate" | null;
      reason: string;
      submitted_at: string | null;
      analyzed_at: string | null;
    };

export async function statusCommand(cwd: string, args: string[]): Promise<number> {
  if (args.length > 0) {
    console.error("error: usage: hivemind status");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await getStatus(repoRoot);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function getStatus(repoRoot: string): Promise<{ ok: true; value: HivemindStatus } | { ok: false; reason: string }> {
  const leaseResult = await readActiveLeases(repoRoot);
  if (!leaseResult.ok) {
    return leaseResult;
  }

  const queueResult = await readIntegrationTaskIds(repoRoot);
  if (!queueResult.ok) {
    return queueResult;
  }

  const integrationStatusResult = await readIntegrationStatus(repoRoot);
  if (!integrationStatusResult.ok) {
    return integrationStatusResult;
  }
  const replanResult = await listReplanStatuses(repoRoot);
  if (!replanResult.ok) {
    return replanResult;
  }
  const eventsResult = await readEvents(repoRoot);
  if (!eventsResult.ok) {
    return eventsResult;
  }

  const taskIds = await listTaskIds(repoRoot);
  const tasks: StatusTask[] = [];
  for (const taskId of taskIds) {
    const taskResult = await buildTaskStatus(
      repoRoot,
      taskId,
      leaseResult.store,
      new Set(queueResult.value),
      integratedTaskIdsFromEvents(eventsResult.value),
      eventsResult.value
    );
    if (!taskResult.ok) {
      return taskResult;
    }
    tasks.push(taskResult.value);
  }

  return {
    ok: true,
    value: {
      tasks,
      leases: leaseResult.store,
      integration: {
        queue: queueResult.value,
        status: integrationStatusResult.value
      },
      replans: replanResult.value
    }
  };
}

async function buildTaskStatus(
  repoRoot: string,
  taskId: string,
  leases: LeaseStore,
  queued: Set<string>,
  integrated: Set<string>,
  events: HivemindEvent[]
): Promise<{ ok: true; value: StatusTask } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return { ok: false, reason: `failed to load ${taskId}: ${contractResult.reason}` };
  }

  const leaseFiles = Object.entries(leases)
    .filter(([, holder]) => holder === taskId)
    .map(([filePath]) => filePath)
    .sort((left, right) => left.localeCompare(right));

  return {
    ok: true,
    value: {
      task_id: taskId,
      title: contractResult.contract.title,
      allowed_files: contractResult.contract.allowed_files,
      lease: {
        held: leaseFiles.length > 0,
        files: leaseFiles
      },
      worktree: (await exists(path.join(repoRoot, ".hivemind", "worktrees", taskId))) ? "present" : "missing",
      patch: await readPatchStatus(repoRoot, taskId, events),
      queued: queued.has(taskId),
      integrated: integrated.has(taskId)
    }
  };
}

async function readPatchStatus(repoRoot: string, taskId: string, events: HivemindEvent[]): Promise<StatusPatch> {
  const diffPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
  if (!(await exists(diffPath))) {
    return {
      bundle: "absent",
      submitted: false,
      analyzed: false,
      accepted: false,
      verdict: null,
      reason: "patch bundle not found",
      submitted_at: null,
      analyzed_at: null
    };
  }

  const eventState = latestPatchEventState(events, taskId);
  if (eventState.submitted === null) {
    return {
      bundle: "present",
      submitted: false,
      analyzed: false,
      accepted: false,
      verdict: null,
      reason: "patch bundle present but no patch.submitted event",
      submitted_at: null,
      analyzed_at: null
    };
  }

  if (eventState.analysis === null) {
    return {
      bundle: "present",
      submitted: true,
      analyzed: false,
      accepted: false,
      verdict: null,
      reason: "patch submitted but not analyzed",
      submitted_at: eventState.submitted.ts,
      analyzed_at: null
    };
  }

  const verdict = patchEventVerdict(eventState.analysis);
  return {
    bundle: "present",
    submitted: true,
    analyzed: true,
    accepted: verdict === "accept",
    verdict,
    reason: patchEventReason(eventState.analysis),
    submitted_at: eventState.submitted.ts,
    analyzed_at: eventState.analysis.ts
  };
}

function latestPatchEventState(events: HivemindEvent[], taskId: string): { submitted: HivemindEvent | null; analysis: HivemindEvent | null } {
  let submitted: HivemindEvent | null = null;
  let analysis: HivemindEvent | null = null;
  for (const event of events) {
    if (event.task_id !== taskId) {
      continue;
    }
    if (event.type === "patch.submitted") {
      submitted = event;
      analysis = null;
      continue;
    }
    if (submitted !== null && (event.type === "patch.accepted" || event.type === "patch.rejected")) {
      analysis = event;
    }
  }
  return { submitted, analysis };
}

function patchEventVerdict(event: HivemindEvent): "accept" | "reject" | "escalate" | null {
  const verdict = event.data.verdict;
  if (verdict === "accept" || verdict === "reject" || verdict === "escalate") {
    return verdict;
  }
  return event.type === "patch.accepted" ? "accept" : null;
}

function patchEventReason(event: HivemindEvent): string {
  return typeof event.data.reason === "string" ? event.data.reason : `${event.type} event did not include a reason`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}
