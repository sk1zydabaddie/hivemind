import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { canonicalizeIntentPath } from "./canonicalize.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent } from "./events.js";
import { canonicalizeConcreteFileScope } from "./file-scope.js";
import { buildLeaseIndex, findLeaseStoreCollisions, type LeaseStore } from "./lease-index.js";
import { withLeaseLock } from "./lease-lock.js";
import { pathCaseBehaviour } from "./path-identity.js";
import { requireTaskDependenciesIntegrated, resolveContractFilesAtBase } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified } from "./spec.js";
import { validateRequestedTaskId } from "./task-id.js";
import { workerProtectedPathReason } from "./worker-protected-paths.js";

export interface LeaseGrantResult {
  task_id: string;
  granted: string[];
}

export interface LeaseReleaseResult {
  task_id: string;
  released: string[];
}

export interface TaskLeaseRequirement {
  task_id: string;
  files: string[];
}

export type { LeaseStore } from "./lease-index.js";
type LeaseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function leaseCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, flag, ...rest] = args;
  if (!taskId || (flag !== undefined && flag !== "--release") || rest.length > 0) {
    console.error("error: usage: hivemind lease <id> [--release]");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<LeaseGrantResult | LeaseReleaseResult>(
    repoRoot,
    flag === "--release" ? "/lease/release" : "/lease/request-contract",
    { task_id: taskId }
  );
  const result = daemonResult.routed
    ? daemonResult
    : flag === "--release"
      ? await releaseLease(repoRoot, taskId)
      : await requestLeaseForContract(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function requestLeaseForContract(repoRoot: string, taskId: string): Promise<LeaseResult<LeaseGrantResult>> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }
  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }
  // requireTaskDependenciesIntegrated already handles a project with no plan:
  // it falls through to manual-task authorization. It never propagates the
  // "tentative plan not found" reason, so the string check that used to sit
  // here was a fail-open that could not fire -- verified by instrumenting the
  // callee to throw if it ever returned that reason, across the whole suite.
  // Removing it also fails closed rather than open, so it is safe even if some
  // uncovered path could reach it.
  const dependencyResult = await requireTaskDependenciesIntegrated(repoRoot, specResult.value.spec_id, taskId);
  if (!dependencyResult.ok) {
    return dependencyResult;
  }

  const baseScope = await resolveContractFilesAtBase(
    repoRoot,
    taskId,
    contractResult.contract.base_commit,
    contractResult.contract.allowed_files,
    "allowed_files",
    contractResult.contract.allowed_file_intents
  );
  if (!baseScope.ok) {
    const eventResult = await appendEvent(repoRoot, {
      type: "lease.rejected",
      task_id: taskId,
      data: { requested_files: contractResult.contract.allowed_files, reason: baseScope.reason }
    });
    if (!eventResult.ok) {
      return { ok: false, reason: `failed to append lease.rejected event: ${eventResult.reason}` };
    }
    return { ok: false, reason: baseScope.reason };
  }

  return requestLease(repoRoot, taskId, baseScope.value);
}

export async function verifyLeaseCoverage(
  repoRoot: string,
  taskId: string,
  files: string[],
  options: { baseCommit?: string; allowedFileIntents?: Record<string, "create" | "modify"> } = {}
): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  let paths: string[];
  if (options.baseCommit !== undefined) {
    const resolved = await resolveContractFilesAtBase(repoRoot, taskId, options.baseCommit, files, "allowed_files", options.allowedFileIntents);
    if (!resolved.ok) {
      return resolved;
    }
    paths = resolved.value;
  } else {
    const pathsResult = await canonicalizeConcreteFileScope(repoRoot, files, "lease coverage");
    if (!pathsResult.ok) {
      return pathsResult;
    }
    paths = pathsResult.paths;
  }

  const protectedProblem = protectedLeaseProblem(paths);
  if (protectedProblem !== null) {
    return { ok: false, reason: protectedProblem };
  }

  const storeResult = await readActiveLeases(repoRoot);
  if (!storeResult.ok) {
    return storeResult;
  }

  const index = buildLeaseIndex(storeResult.store, await pathCaseBehaviour(repoRoot));
  const missing = paths
    .map((filePath) => ({ filePath, holder: index.holderOf(filePath) }))
    .filter((entry) => entry.holder !== taskId);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `active lease does not cover task allowed_files: ${missing
        .map((entry) => `${entry.filePath} ${entry.holder === undefined ? "is not leased" : `held by ${entry.holder}`}`)
        .join("; ")}`
    };
  }

  return { ok: true, files: paths };
}

export async function requestLease(repoRoot: string, taskId: string, files: string[]): Promise<LeaseResult<LeaseGrantResult>> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }

  const result = await requestLeaseValidated(repoRoot, taskId, files);
  const eventResult = await appendEvent(repoRoot, {
    type: result.ok ? "lease.approved" : "lease.rejected",
    task_id: taskId,
    data: result.ok
      ? { requested_files: files, granted: result.value.granted }
      : { requested_files: files, reason: result.reason }
  });
  if (!eventResult.ok) {
    return { ok: false, reason: `failed to append ${result.ok ? "lease.approved" : "lease.rejected"} event: ${eventResult.reason}` };
  }

  return result;
}

async function requestLeaseValidated(repoRoot: string, taskId: string, files: string[]): Promise<LeaseResult<LeaseGrantResult>> {
  if (files.length === 0) {
    return { ok: false, reason: "lease request must include at least one file" };
  }

  const pathsResult = await canonicalizeConcreteFileScope(repoRoot, files, "lease");
  if (!pathsResult.ok) {
    return pathsResult;
  }
  const protectedProblem = protectedLeaseProblem(pathsResult.paths);
  if (protectedProblem !== null) {
    return { ok: false, reason: protectedProblem };
  }

  const behaviour = await pathCaseBehaviour(repoRoot);
  return withLeaseLock(repoRoot, async () => {
    const storeResult = await readActiveLeases(repoRoot);
    if (!storeResult.ok) {
      return storeResult;
    }

    const index = buildLeaseIndex(storeResult.store, behaviour);
    const conflicts = pathsResult.paths
      .map((filePath) => ({ filePath, holder: index.holderOf(filePath) }))
      .filter((entry): entry is { filePath: string; holder: string } => entry.holder !== undefined && entry.holder !== taskId);
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `lease conflict: ${conflicts.map((entry) => `${entry.filePath} held by ${entry.holder}`).join("; ")}`
      };
    }

    const nextStore = { ...storeResult.store };
    for (const filePath of pathsResult.paths) {
      /* Re-request under a different spelling writes through to the key already
         there rather than adding a second one -- otherwise the same task would
         quietly create the two-keys-one-file state this index exists to
         prevent. */
      nextStore[index.keyOf(filePath) ?? filePath] = taskId;
    }
    await writeActiveLeases(repoRoot, nextStore);
    return { ok: true, value: { task_id: taskId, granted: pathsResult.paths } };
  });
}

function protectedLeaseProblem(paths: string[]): string | null {
  for (const filePath of paths) {
    const reason = workerProtectedPathReason(filePath);
    if (reason !== null) {
      return `lease refused for protected path "${filePath}": ${reason}`;
    }
  }
  return null;
}

export async function releaseLease(repoRoot: string, taskId: string): Promise<LeaseResult<LeaseReleaseResult>> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const result = await withLeaseLock(repoRoot, async () => {
    const storeResult = await readActiveLeases(repoRoot);
    if (!storeResult.ok) {
      return storeResult;
    }

    const nextStore: LeaseStore = {};
    const released: string[] = [];
    for (const [filePath, holder] of Object.entries(storeResult.store)) {
      if (holder === taskId) {
        released.push(filePath);
      } else {
        nextStore[filePath] = holder;
      }
    }

    if (released.length > 0) {
      await writeActiveLeases(repoRoot, nextStore);
    }
    return { ok: true, value: { task_id: taskId, released } };
  });

  if (!result.ok) {
    return result;
  }

  const eventResult = await appendEvent(repoRoot, {
    type: "lease.released",
    task_id: taskId,
    data: { released: result.value.released }
  });
  if (!eventResult.ok) {
    return { ok: false, reason: `failed to append lease.released event: ${eventResult.reason}` };
  }

  return result;
}

export async function runWithHeldTaskLeases<T>(
  repoRoot: string,
  requirements: TaskLeaseRequirement[],
  action: () => Promise<LeaseResult<T>>
): Promise<LeaseResult<T>> {
  const taskIds = [...new Set(requirements.map((requirement) => requirement.task_id))].sort();
  const releasedByTask = new Map(taskIds.map((taskId) => [taskId, [] as string[]]));
  const behaviour = await pathCaseBehaviour(repoRoot);
  const result = await withLeaseLock(repoRoot, async () => {
    const storeResult = await readActiveLeases(repoRoot);
    if (!storeResult.ok) return storeResult;
    const index = buildLeaseIndex(storeResult.store, behaviour);
    for (const requirement of requirements) {
      for (const file of requirement.files) {
        const holder = index.holderOf(file);
        if (holder !== requirement.task_id) {
          return {
            ok: false,
            reason: `adoption lease changed before transition: ${file} ${holder === undefined ? "is not leased" : `held by ${holder}`}`
          };
        }
      }
    }
    const actionResult = await action();
    if (!actionResult.ok) return actionResult;
    const holders = new Set(taskIds);
    const nextStore: LeaseStore = {};
    for (const [filePath, holder] of Object.entries(storeResult.store)) {
      if (holders.has(holder)) releasedByTask.get(holder)!.push(filePath);
      else nextStore[filePath] = holder;
    }
    await writeActiveLeases(repoRoot, nextStore);
    return actionResult;
  });
  if (!result.ok) return result;
  for (const taskId of taskIds) {
    const eventResult = await appendEvent(repoRoot, {
      type: "lease.released",
      task_id: taskId,
      data: { released: releasedByTask.get(taskId)!.sort(), reason: "verified set adopted" }
    });
    if (!eventResult.ok) return { ok: false, reason: `failed to append lease.released event: ${eventResult.reason}` };
  }
  return result;
}

export async function readActiveLeases(repoRoot: string): Promise<{ ok: true; store: LeaseStore } | { ok: false; reason: string }> {
  const activePath = activeLeasePath(repoRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(activePath, "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, store: {} };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/leases/active.json" };
    }
    throw error;
  }

  const validation = await validateLeaseStore(repoRoot, raw);
  if (!validation.ok) {
    return validation;
  }
  return { ok: true, store: raw as LeaseStore };
}

async function validateLeaseStore(repoRoot: string, raw: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "lease store must be a JSON object" };
  }

  for (const [filePath, taskId] of Object.entries(raw)) {
    if (typeof taskId !== "string") {
      return { ok: false, reason: `lease holder for ${filePath} must be a string` };
    }
    const taskIdProblem = validateRequestedTaskId(taskId);
    if (!taskIdProblem.ok) {
      return { ok: false, reason: `lease holder for ${filePath} is invalid: ${taskIdProblem.reason}` };
    }
    const canonical = await canonicalizeIntentPath(repoRoot, filePath);
    if (!canonical.ok || canonical.resolved !== filePath) {
      return { ok: false, reason: `lease path ${filePath} is invalid` };
    }
  }

  /* Unreachable once grants go through the index, so reaching it means the file
     predates this build or was edited by hand. Refusing to read it is the point:
     two keys naming one file is precisely the state where two tasks hold write
     scope over the same bytes and every surface reports normal. */
  const collision = findLeaseStoreCollisions(raw, await pathCaseBehaviour(repoRoot));
  if (collision !== null) {
    return {
      ok: false,
      reason:
        `lease store holds ${collision.left} and ${collision.right}, which are the same file on this ` +
        `filesystem; release the leases for this project and request them again`
    };
  }

  return { ok: true };
}

async function writeActiveLeases(repoRoot: string, store: LeaseStore): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(store).sort(([left], [right]) => left.localeCompare(right)));
  await writeJsonAtomic(activeLeasePath(repoRoot), sorted);
}

function activeLeasePath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "leases", "active.json");
}

function isRecord(value: unknown): value is LeaseStore {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
