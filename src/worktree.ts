import { execFile } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskContract } from "./contract.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, appendTaskCreatedIfMissing, readEvents } from "./events.js";
import { canonicalizeConcreteFileScope } from "./file-scope.js";
import { readActiveLeases } from "./lease.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified } from "./spec.js";
import { resolveTaskAuthoringBase, type TaskAuthoringBase } from "./task-authoring-base.js";
import { validateRequestedTaskId } from "./task-id.js";
import { codedFailure, type CodedFailure } from "./failure-code.js";
import { isBusyErrno, isBusyStderr, isMissingBranchStderr } from "./git-stderr.js";

const execFileAsync = promisify(execFile);

export interface WorktreeResult {
  worktree: string;
  branch: string;
}

export async function worktreeCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, flag, ...rest] = args;
  if (!taskId || (flag !== undefined && flag !== "--remove") || rest.length > 0) {
    console.error("error: usage: hivemind worktree <id> [--remove]");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<WorktreeResult>(
    repoRoot,
    flag === "--remove" ? "/worktree/remove" : "/worktree/create",
    { task_id: taskId }
  );
  const result = daemonResult.routed ? daemonResult : flag === "--remove" ? await removeTaskWorktree(repoRoot, taskId) : await createTaskWorktree(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function createTaskWorktree(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: WorktreeResult } | { ok: false; reason: string }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }

  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const authoringBase = await resolveTaskAuthoringBase(repoRoot, contractResult.contract);
  if (!authoringBase.ok) {
    return authoringBase;
  }
  const value = getWorktreeResult(repoRoot, taskId);
  if (await exists(value.worktree)) {
    const reuseResult = await verifyExistingWorktree(repoRoot, taskId, value, authoringBase.value.commit);
    if (!reuseResult.ok) {
      return reuseResult;
    }
    const prepResult = await prepareReadonlyWorktree(repoRoot, value.worktree, taskId);
    if (!prepResult.ok) {
      return prepResult;
    }
    const eventResult = await appendTaskCreatedEvent(repoRoot, taskId, contractResult.contract, value, true);
    if (!eventResult.ok) {
      return eventResult;
    }
    const authoringEvent = await appendAuthoringBaseEvent(repoRoot, taskId, authoringBase.value);
    return authoringEvent.ok ? { ok: true, value } : authoringEvent;
  }

  await mkdir(path.dirname(value.worktree), { recursive: true });
  const gitResult = await git(repoRoot, [
    "worktree",
    "add",
    path.join(".hivemind", "worktrees", taskId),
    "-b",
    value.branch,
    authoringBase.value.commit
  ]);
  if (!gitResult.ok) {
    return { ok: false, reason: gitResult.reason };
  }

  const prepResult = await prepareReadonlyWorktree(repoRoot, value.worktree, taskId);
  if (!prepResult.ok) {
    return prepResult;
  }

  const eventResult = await appendTaskCreatedEvent(repoRoot, taskId, contractResult.contract, value, false);
  if (!eventResult.ok) {
    return eventResult;
  }

  const authoringEvent = await appendAuthoringBaseEvent(repoRoot, taskId, authoringBase.value);
  return authoringEvent.ok ? { ok: true, value } : authoringEvent;
}

export async function removeTaskWorktree(
  repoRoot: string,
  taskId: string,
  options: { discardChanges?: boolean } = {}
): Promise<{ ok: true; value: WorktreeResult } | CodedFailure> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const value = getWorktreeResult(repoRoot, taskId);
  if (await exists(value.worktree)) {
    const restoreResult = await restoreTrackedFileWrites(value.worktree);
    if (!restoreResult.ok) {
      return restoreResult;
    }
    const removeResult = await git(repoRoot, [
      "worktree",
      "remove",
      ...(options.discardChanges === true ? ["--force"] : []),
      path.join(".hivemind", "worktrees", taskId)
    ]);
    if (!removeResult.ok) {
      // git is a separate program, so its stderr is the only evidence here.
      // The classification is isolated and fails closed: unrecognised means no
      // code, which means the caller does not retry.
      return isBusyStderr(removeResult.reason)
        ? codedFailure("worktree_busy", removeResult.reason)
        : { ok: false, reason: removeResult.reason };
    }
  }

  const branchResult = await git(repoRoot, ["branch", "-D", value.branch]);
  // Only a branch git positively reports as absent counts as already-deleted.
  // Anything else propagates rather than being assumed done.
  if (!branchResult.ok && !isMissingBranchStderr(branchResult.reason)) {
    return isBusyStderr(branchResult.reason)
      ? codedFailure("worktree_busy", branchResult.reason)
      : { ok: false, reason: branchResult.reason };
  }

  return { ok: true, value };
}

export async function prepareReadonlyWorktree(
  repoRoot: string,
  worktreePath: string,
  taskId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const leaseFilesResult = await readLeaseFilesForTask(repoRoot, taskId);
  if (!leaseFilesResult.ok) {
    return leaseFilesResult;
  }

  const writableResult = await canonicalizeConcreteFileScope(worktreePath, leaseFilesResult.files, "leased");
  if (!writableResult.ok) {
    return writableResult;
  }

  const trackedResult = await gitStdout(worktreePath, ["ls-files", "-z"]);
  if (!trackedResult.ok) {
    return { ok: false, reason: trackedResult.reason };
  }

  const writable = new Set(writableResult.paths);
  for (const repoPath of parseNullSeparated(trackedResult.stdout)) {
    const fullPath = path.join(worktreePath, repoPath);
    const fileStat = await stat(fullPath);
    if (fileStat.isDirectory()) {
      continue;
    }
    const nextMode = writable.has(normalizeGitPath(repoPath)) ? fileStat.mode | 0o200 : fileStat.mode & ~0o222;
    await chmod(fullPath, nextMode);
  }

  return { ok: true };
}

async function readLeaseFilesForTask(repoRoot: string, taskId: string): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }> {
  const storeResult = await readActiveLeases(repoRoot);
  if (!storeResult.ok) {
    return storeResult;
  }

  return {
    ok: true,
    files: Object.entries(storeResult.store)
      .filter(([, holder]) => holder === taskId)
      .map(([filePath]) => filePath)
      .sort((left, right) => left.localeCompare(right))
  };
}

async function restoreTrackedFileWrites(worktreePath: string): Promise<{ ok: true } | CodedFailure> {
  const trackedResult = await gitStdout(worktreePath, ["ls-files", "-z"]);
  if (!trackedResult.ok) {
    return { ok: false, reason: trackedResult.reason };
  }

  // stat and chmod throw a real Node error carrying a real errno. Catching it
  // HERE is the whole point: left to propagate, it escaped to a caller that
  // rendered it with error.message and then regexed EPERM back out of that
  // prose to decide whether cleanup was retryable. The typed value is read
  // while it is still a value.
  for (const repoPath of parseNullSeparated(trackedResult.stdout)) {
    const fullPath = path.join(worktreePath, repoPath);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isDirectory()) {
        await chmod(fullPath, fileStat.mode | 0o200);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return isBusyErrno(error)
        ? codedFailure("worktree_busy", `could not restore write access to ${repoPath}: ${message}`)
        : { ok: false, reason: `could not restore write access to ${repoPath}: ${message}` };
    }
  }

  return { ok: true };
}

function getWorktreeResult(repoRoot: string, taskId: string): WorktreeResult {
  return {
    worktree: path.join(repoRoot, ".hivemind", "worktrees", taskId),
    branch: `hivemind/${taskId}`
  };
}

async function appendTaskCreatedEvent(
  repoRoot: string,
  taskId: string,
  contract: TaskContract,
  value: WorktreeResult,
  reused: boolean
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const eventResult = await appendTaskCreatedIfMissing(repoRoot, taskId, {
    title: contract.title,
    agent_role: contract.agent_role,
    base_commit: contract.base_commit,
    allowed_files: contract.allowed_files,
    worktree: path.relative(repoRoot, value.worktree).replaceAll("\\", "/"),
    branch: value.branch,
    reused,
    source: "worktree.create"
  });
  return eventResult.ok ? { ok: true } : { ok: false, reason: `failed to append task.created event: ${eventResult.reason}` };
}

async function appendAuthoringBaseEvent(
  repoRoot: string,
  taskId: string,
  authoringBase: TaskAuthoringBase
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const alreadyRecorded = events.value.some((event) =>
    event.type === "task.authoring_base_prepared" &&
    event.task_id === taskId &&
    event.data.authoring_base_commit === authoringBase.commit &&
    event.data.dependency_verification_id === authoringBase.verification_id
  );
  if (alreadyRecorded) return { ok: true };
  const appended = await appendEvent(repoRoot, {
    type: "task.authoring_base_prepared",
    task_id: taskId,
    data: {
      contract_base_commit: authoringBase.contract_base_commit,
      authoring_base_commit: authoringBase.commit,
      authoring_base_tree: authoringBase.tree,
      dependency_task_ids: authoringBase.dependency_task_ids,
      dependency_verification_id: authoringBase.verification_id
    }
  });
  return appended.ok ? { ok: true } : { ok: false, reason: `failed to append task.authoring_base_prepared event: ${appended.reason}` };
}

function parseNullSeparated(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function verifyExistingWorktree(
  repoRoot: string,
  taskId: string,
  value: WorktreeResult,
  authoringBaseCommit: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const branchResult = await gitStdout(value.worktree, ["branch", "--show-current"]);
  if (!branchResult.ok) {
    return { ok: false, reason: `existing worktree .hivemind/worktrees/${taskId} could not be inspected: ${branchResult.reason}` };
  }
  if (branchResult.stdout !== value.branch) {
    return {
      ok: false,
      reason: `existing worktree .hivemind/worktrees/${taskId} is on branch "${branchResult.stdout}", expected "${value.branch}"; remove it and retry`
    };
  }

  const headResult = await gitStdout(value.worktree, ["rev-parse", "HEAD"]);
  if (!headResult.ok) {
    return { ok: false, reason: `existing worktree .hivemind/worktrees/${taskId} HEAD could not be inspected: ${headResult.reason}` };
  }

  const baseResult = await gitStdout(repoRoot, ["rev-parse", authoringBaseCommit]);
  if (!baseResult.ok) {
    return { ok: false, reason: baseResult.reason };
  }

  if (headResult.stdout !== baseResult.stdout) {
    return {
      ok: false,
      reason: `existing worktree .hivemind/worktrees/${taskId} is at ${headResult.stdout}, expected verified authoring base ${baseResult.stdout}; remove it and retry`
    };
  }

  return { ok: true };
}

async function git(cwd: string, args: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await execFileAsync("git", args, { cwd, windowsHide: true });
    return { ok: true };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

async function gitStdout(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
