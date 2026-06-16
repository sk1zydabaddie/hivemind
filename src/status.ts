import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeTask } from "./analyze.js";
import { loadAndValidateContract } from "./contract.js";
import type { IntegrationStatus } from "./integrate.js";
import { loadIntegrationQueue } from "./integrate.js";
import { readJsonFile } from "./json.js";
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
  | { bundle: "missing"; verdict: "not_submitted"; reason: string }
  | { bundle: "present"; verdict: "accept" | "reject" | "escalate" | "error"; reason: string };

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

  const queueResult = await readStatusQueue(repoRoot);
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

  const taskIds = await listTaskIds(repoRoot);
  const tasks: StatusTask[] = [];
  for (const taskId of taskIds) {
    const taskResult = await buildTaskStatus(
      repoRoot,
      taskId,
      leaseResult.store,
      new Set(queueResult.value),
      new Set(integrationStatusResult.value?.applied ?? [])
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
  integrated: Set<string>
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
      patch: await readPatchStatus(repoRoot, taskId),
      queued: queued.has(taskId),
      integrated: integrated.has(taskId)
    }
  };
}

async function readPatchStatus(repoRoot: string, taskId: string): Promise<StatusPatch> {
  const diffPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
  if (!(await exists(diffPath))) {
    return { bundle: "missing", verdict: "not_submitted", reason: "patch not submitted" };
  }

  const result = await analyzeTask(repoRoot, taskId, { emitEvent: false });
  if (!result.ok) {
    return { bundle: "present", verdict: "error", reason: result.reason };
  }

  return { bundle: "present", verdict: result.value.verdict, reason: result.value.reason };
}

async function readStatusQueue(repoRoot: string): Promise<{ ok: true; value: string[] } | { ok: false; reason: string }> {
  const result = await loadIntegrationQueue(repoRoot);
  if (!result.ok) {
    return result.reason.includes("integration queue not found") ? { ok: true, value: [] } : result;
  }

  return { ok: true, value: result.value.map((entry) => entry.task_id) };
}

async function readIntegrationStatus(repoRoot: string): Promise<{ ok: true; value: IntegrationStatus | null } | { ok: false; reason: string }> {
  try {
    const raw = await readJsonFile(path.join(repoRoot, ".hivemind", "integration", "status.json"));
    if (!isIntegrationStatus(raw)) {
      return { ok: false, reason: "integration status must contain branch, applied, tests, and report" };
    }
    return { ok: true, value: raw };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: null };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/integration/status.json" };
    }
    throw error;
  }
}

async function listTaskIds(repoRoot: string): Promise<string[]> {
  const tasksDir = path.join(repoRoot, ".hivemind", "tasks");
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".contract.json"))
      .map((entry) => entry.name.slice(0, -".contract.json".length))
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
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

function isIntegrationStatus(value: unknown): value is IntegrationStatus {
  return (
    isRecord(value) &&
    typeof value.branch === "string" &&
    Array.isArray(value.applied) &&
    value.applied.every((entry) => typeof entry === "string") &&
    (value.tests === "pass" || value.tests === "fail") &&
    typeof value.report === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
