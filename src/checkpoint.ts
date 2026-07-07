import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "./atomic.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { contextPackRelativePath, loadContextPackForContract, taskKnowledgeRelativePath } from "./context-pack.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { appendEvent } from "./events.js";
import { readJsonFile } from "./json.js";
import { verifyLeaseCoverage } from "./lease.js";
import { loadTentativePlan } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { getStatus, type StatusTask } from "./status.js";
import { requirePassedWriteIntent } from "./intent.js";
import { requireActiveSpecRatified } from "./spec.js";
import { validateRequestedTaskId } from "./task-id.js";

const execFileAsync = promisify(execFile);
const snapshotVersion = 1;
const agentLogPath = "agent.log";

export interface TaskCheckpointSnapshot {
  version: 1;
  kind: "task";
  task_id: string;
  created_at: string;
  authoritative_refs: {
    contract_ref: { path: string };
    plan_ref: { path: string; task_id: string };
    context_pack_ref: { path: string } | null;
    task_knowledge_ref: { path: string; present: boolean };
  };
  partial_diff: {
    source: "worktree";
    worktree_ref: string;
    base_commit: string;
    changed_files: number;
    diff: string;
    diff_hash: string;
  };
}

export interface TaskCheckpointResult {
  task_id: string;
  snapshot_path: string;
  context_pack_ref: string | null;
  task_knowledge_ref: string;
  changed_files: number;
}

export interface TaskCheckpointResumeState {
  snapshot: TaskCheckpointSnapshot;
  contract: TaskContract;
  task_status: StatusTask;
  lease_files: string[];
  context_pack: {
    path: string;
    present: boolean;
    created_at: string | null;
  };
  task_knowledge: {
    path: string;
    present: boolean;
    bytes: number;
  };
}

type CheckpointResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function checkpointCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, ...rest] = args;
  if (!taskId || rest.length > 0) {
    console.error("error: usage: hivemind checkpoint <id>");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<TaskCheckpointResult>(repoRoot, "/checkpoint/task", { task_id: taskId });
  const result = daemonResult.routed ? daemonResult : await checkpointTask(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function checkpointTask(repoRoot: string, taskId: string): Promise<CheckpointResult<TaskCheckpointResult>> {
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
  const contract = contractResult.contract;
  const planResult = await requirePlanTaskRef(repoRoot, specResult.value.spec_id, taskId);
  if (!planResult.ok) {
    return planResult;
  }

  const leaseResult = await verifyLeaseCoverage(repoRoot, taskId, contract.allowed_files, {
    baseCommit: contract.base_commit,
    allowedFileIntents: contract.allowed_file_intents
  });
  if (!leaseResult.ok) {
    return leaseResult;
  }

  const intentResult = await requirePassedWriteIntent(repoRoot, taskId);
  if (!intentResult.ok) {
    return intentResult;
  }

  const worktreePath = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  const headResult = await gitStdout(worktreePath, ["rev-parse", "HEAD"]);
  if (!headResult.ok) {
    return { ok: false, reason: `task worktree not ready: .hivemind/worktrees/${taskId} (${headResult.reason})` };
  }
  const baseResult = await gitStdout(repoRoot, ["rev-parse", contract.base_commit]);
  if (!baseResult.ok) {
    return baseResult;
  }
  if (headResult.stdout !== baseResult.stdout) {
    return {
      ok: false,
      reason: `task worktree .hivemind/worktrees/${taskId} is at ${headResult.stdout}, expected contract base ${baseResult.stdout}`
    };
  }

  const diffResult = await captureWorktreeDiff(worktreePath, contract.base_commit, { excludeUntracked: [agentLogPath] });
  if (!diffResult.ok) {
    return diffResult;
  }

  const contextPackResult = await loadContextPackForContract(repoRoot, contract);
  if (!contextPackResult.ok) {
    return contextPackResult;
  }

  const knowledgeRef = await currentKnowledgeRef(repoRoot, taskId);
  const snapshot: TaskCheckpointSnapshot = {
    version: snapshotVersion,
    kind: "task",
    task_id: taskId,
    created_at: new Date().toISOString(),
    authoritative_refs: {
      contract_ref: { path: contractRelativePath(taskId) },
      plan_ref: planResult.value,
      context_pack_ref: contextPackResult.value === null ? null : { path: contextPackRelativePath(taskId) },
      task_knowledge_ref: knowledgeRef
    },
    partial_diff: {
      source: "worktree",
      worktree_ref: worktreeRelativePath(taskId),
      base_commit: contract.base_commit,
      changed_files: diffResult.value.changedFiles,
      diff: diffResult.value.diff,
      diff_hash: sha256(diffResult.value.diff)
    }
  };

  const snapshotPath = taskCheckpointPath(repoRoot, taskId);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeJsonAtomic(snapshotPath, snapshot);

  const event = await appendEvent(repoRoot, {
    type: "task.checkpointed",
    task_id: taskId,
    data: {
      snapshot_path: taskCheckpointRelativePath(taskId),
      changed_files: diffResult.value.changedFiles,
      context_pack_ref: snapshot.authoritative_refs.context_pack_ref?.path ?? null,
      task_knowledge_ref: snapshot.authoritative_refs.task_knowledge_ref.path,
      source: "checkpoint.task"
    }
  });
  if (!event.ok) {
    return { ok: false, reason: `failed to append task.checkpointed event: ${event.reason}` };
  }

  return {
    ok: true,
    value: {
      task_id: taskId,
      snapshot_path: taskCheckpointRelativePath(taskId),
      context_pack_ref: snapshot.authoritative_refs.context_pack_ref?.path ?? null,
      task_knowledge_ref: snapshot.authoritative_refs.task_knowledge_ref.path,
      changed_files: diffResult.value.changedFiles
    }
  };
}

export async function loadTaskCheckpointResumeState(repoRoot: string, taskId: string): Promise<CheckpointResult<TaskCheckpointResumeState>> {
  const snapshotResult = await loadTaskCheckpointSnapshot(repoRoot, taskId);
  if (!snapshotResult.ok) {
    return snapshotResult;
  }
  const snapshot = snapshotResult.value;

  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }
  const contract = contractResult.contract;
  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }
  const planResult = await requirePlanTaskRef(repoRoot, specResult.value.spec_id, taskId);
  if (!planResult.ok) {
    return planResult;
  }
  if (snapshot.authoritative_refs.plan_ref.path !== planResult.value.path) {
    return {
      ok: false,
      reason: `checkpoint plan_ref ${snapshot.authoritative_refs.plan_ref.path} does not match active plan ${planResult.value.path}`
    };
  }
  if (snapshot.partial_diff.base_commit !== contract.base_commit) {
    return {
      ok: false,
      reason: `checkpoint partial_diff base ${snapshot.partial_diff.base_commit} does not match contract base ${contract.base_commit}`
    };
  }

  const leaseResult = await verifyLeaseCoverage(repoRoot, taskId, contract.allowed_files, {
    baseCommit: contract.base_commit,
    allowedFileIntents: contract.allowed_file_intents
  });
  if (!leaseResult.ok) {
    return leaseResult;
  }

  const statusResult = await getStatus(repoRoot);
  if (!statusResult.ok) {
    return statusResult;
  }
  const taskStatus = statusResult.value.tasks.find((task) => task.task_id === taskId);
  if (taskStatus === undefined) {
    return { ok: false, reason: `task ${taskId} is missing from authoritative status` };
  }

  const contextPackResult = await loadContextPackForContract(repoRoot, contract);
  if (!contextPackResult.ok) {
    return contextPackResult;
  }
  const knowledge = await currentKnowledgeState(repoRoot, taskId);

  return {
    ok: true,
    value: {
      snapshot,
      contract,
      task_status: taskStatus,
      lease_files: leaseResult.files,
      context_pack: {
        path: contextPackRelativePath(taskId),
        present: contextPackResult.value !== null,
        created_at: contextPackResult.value?.created_at ?? null
      },
      task_knowledge: knowledge
    }
  };
}

async function requirePlanTaskRef(repoRoot: string, specId: string, taskId: string): Promise<CheckpointResult<{ path: string; task_id: string }>> {
  const plan = await loadTentativePlan(repoRoot, specId);
  if (!plan.ok) {
    return plan;
  }
  if (!plan.value.tasks.some((task) => task.task_id === taskId)) {
    return { ok: false, reason: `task ${taskId} is not present in authoritative plan ${planRelativePath(specId)}` };
  }
  return { ok: true, value: { path: planRelativePath(specId), task_id: taskId } };
}

export async function loadTaskCheckpointSnapshot(repoRoot: string, taskId: string): Promise<CheckpointResult<TaskCheckpointSnapshot>> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }
  let raw: unknown;
  try {
    raw = await readJsonFile(taskCheckpointPath(repoRoot, taskId));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `checkpoint not found: ${taskCheckpointRelativePath(taskId)}` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${taskCheckpointRelativePath(taskId)}` };
    }
    throw error;
  }
  const validation = validateTaskCheckpointSnapshot(raw, taskId);
  return validation.ok ? { ok: true, value: validation.value } : validation;
}

export function taskCheckpointRelativePath(taskId: string): string {
  return `.hivemind/resource/checkpoints/${taskId}.snapshot.json`;
}

function taskCheckpointPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, taskCheckpointRelativePath(taskId));
}

function contractRelativePath(taskId: string): string {
  return `.hivemind/tasks/${taskId}.contract.json`;
}

function planRelativePath(specId: string): string {
  return `.hivemind/plans/${specId}.tentative.json`;
}

function worktreeRelativePath(taskId: string): string {
  return `.hivemind/worktrees/${taskId}`;
}

async function currentKnowledgeRef(repoRoot: string, taskId: string): Promise<{ path: string; present: boolean }> {
  return {
    path: taskKnowledgeRelativePath(taskId),
    present: await exists(path.join(repoRoot, taskKnowledgeRelativePath(taskId)))
  };
}

async function currentKnowledgeState(repoRoot: string, taskId: string): Promise<{ path: string; present: boolean; bytes: number }> {
  const knowledgePath = path.join(repoRoot, taskKnowledgeRelativePath(taskId));
  try {
    const info = await stat(knowledgePath);
    return { path: taskKnowledgeRelativePath(taskId), present: true, bytes: info.size };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { path: taskKnowledgeRelativePath(taskId), present: false, bytes: 0 };
    }
    throw error;
  }
}

function validateTaskCheckpointSnapshot(raw: unknown, expectedTaskId: string): CheckpointResult<TaskCheckpointSnapshot> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "checkpoint snapshot must be a JSON object" };
  }
  const topKeys = new Set(["version", "kind", "task_id", "created_at", "authoritative_refs", "partial_diff"]);
  const extraTop = Object.keys(raw).filter((key) => !topKeys.has(key));
  if (extraTop.length > 0) {
    return { ok: false, reason: `checkpoint snapshot contains unsupported field: ${extraTop[0]}` };
  }
  if (raw.version !== snapshotVersion) {
    return { ok: false, reason: "checkpoint snapshot version must be 1" };
  }
  if (raw.kind !== "task") {
    return { ok: false, reason: "checkpoint snapshot kind must be task" };
  }
  if (raw.task_id !== expectedTaskId) {
    return { ok: false, reason: `checkpoint snapshot task_id must be ${expectedTaskId}` };
  }
  if (typeof raw.created_at !== "string" || Number.isNaN(Date.parse(raw.created_at))) {
    return { ok: false, reason: "checkpoint snapshot created_at must be an ISO timestamp string" };
  }
  const refs = validateAuthoritativeRefs(raw.authoritative_refs, expectedTaskId);
  if (!refs.ok) {
    return refs;
  }
  const diff = validatePartialDiff(raw.partial_diff, expectedTaskId);
  if (!diff.ok) {
    return diff;
  }
  return {
    ok: true,
    value: {
      version: 1,
      kind: "task",
      task_id: expectedTaskId,
      created_at: raw.created_at,
      authoritative_refs: refs.value,
      partial_diff: diff.value
    }
  };
}

function validateAuthoritativeRefs(raw: unknown, taskId: string): CheckpointResult<TaskCheckpointSnapshot["authoritative_refs"]> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "checkpoint authoritative_refs must be a JSON object" };
  }
  const keys = new Set(["contract_ref", "plan_ref", "context_pack_ref", "task_knowledge_ref"]);
  const extra = Object.keys(raw).filter((key) => !keys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `checkpoint authoritative_refs contains unsupported field: ${extra[0]}` };
  }
  const contractRef = validatePathRef(raw.contract_ref, contractRelativePath(taskId), "contract_ref");
  if (!contractRef.ok) {
    return contractRef;
  }
  const planRef = validatePlanRef(raw.plan_ref, taskId);
  if (!planRef.ok) {
    return planRef;
  }
  const contextPackRef = raw.context_pack_ref === null ? { ok: true as const, value: null } : validatePathRef(raw.context_pack_ref, contextPackRelativePath(taskId), "context_pack_ref");
  if (!contextPackRef.ok) {
    return contextPackRef;
  }
  const knowledgeRef = validateKnowledgeRef(raw.task_knowledge_ref, taskId);
  if (!knowledgeRef.ok) {
    return knowledgeRef;
  }
  return {
    ok: true,
    value: {
      contract_ref: contractRef.value,
      plan_ref: planRef.value,
      context_pack_ref: contextPackRef.value,
      task_knowledge_ref: knowledgeRef.value
    }
  };
}

function validatePathRef(raw: unknown, expectedPath: string, label: string): CheckpointResult<{ path: string }> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `checkpoint ${label} must be a JSON object` };
  }
  const keys = new Set(["path"]);
  const extra = Object.keys(raw).filter((key) => !keys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `checkpoint ${label} contains unsupported field: ${extra[0]}` };
  }
  if (raw.path !== expectedPath) {
    return { ok: false, reason: `checkpoint ${label}.path must be ${expectedPath}` };
  }
  return { ok: true, value: { path: expectedPath } };
}

function validatePlanRef(raw: unknown, taskId: string): CheckpointResult<{ path: string; task_id: string }> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "checkpoint plan_ref must be a JSON object" };
  }
  const keys = new Set(["path", "task_id"]);
  const extra = Object.keys(raw).filter((key) => !keys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `checkpoint plan_ref contains unsupported field: ${extra[0]}` };
  }
  if (typeof raw.path !== "string" || !/^\.hivemind\/plans\/[^/]+\.tentative\.json$/u.test(raw.path)) {
    return { ok: false, reason: "checkpoint plan_ref.path must point at a tentative plan" };
  }
  if (raw.task_id !== taskId) {
    return { ok: false, reason: `checkpoint plan_ref.task_id must be ${taskId}` };
  }
  return { ok: true, value: { path: raw.path, task_id: taskId } };
}

function validateKnowledgeRef(raw: unknown, taskId: string): CheckpointResult<{ path: string; present: boolean }> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "checkpoint task_knowledge_ref must be a JSON object" };
  }
  const keys = new Set(["path", "present"]);
  const extra = Object.keys(raw).filter((key) => !keys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `checkpoint task_knowledge_ref contains unsupported field: ${extra[0]}` };
  }
  if (raw.path !== taskKnowledgeRelativePath(taskId)) {
    return { ok: false, reason: `checkpoint task_knowledge_ref.path must be ${taskKnowledgeRelativePath(taskId)}` };
  }
  if (typeof raw.present !== "boolean") {
    return { ok: false, reason: "checkpoint task_knowledge_ref.present must be a boolean" };
  }
  return { ok: true, value: { path: taskKnowledgeRelativePath(taskId), present: raw.present } };
}

function validatePartialDiff(raw: unknown, taskId: string): CheckpointResult<TaskCheckpointSnapshot["partial_diff"]> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "checkpoint partial_diff must be a JSON object" };
  }
  const keys = new Set(["source", "worktree_ref", "base_commit", "changed_files", "diff", "diff_hash"]);
  const extra = Object.keys(raw).filter((key) => !keys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `checkpoint partial_diff contains unsupported field: ${extra[0]}` };
  }
  if (raw.source !== "worktree") {
    return { ok: false, reason: "checkpoint partial_diff.source must be worktree" };
  }
  if (raw.worktree_ref !== worktreeRelativePath(taskId)) {
    return { ok: false, reason: `checkpoint partial_diff.worktree_ref must be ${worktreeRelativePath(taskId)}` };
  }
  if (typeof raw.base_commit !== "string" || raw.base_commit.trim() === "") {
    return { ok: false, reason: "checkpoint partial_diff.base_commit must be a non-empty string" };
  }
  if (!isSafeCount(raw.changed_files)) {
    return { ok: false, reason: "checkpoint partial_diff.changed_files must be a non-negative safe integer" };
  }
  if (typeof raw.diff !== "string") {
    return { ok: false, reason: "checkpoint partial_diff.diff must be a string" };
  }
  if (raw.diff_hash !== sha256(raw.diff)) {
    return { ok: false, reason: "checkpoint partial_diff.diff_hash does not match diff" };
  }
  return {
    ok: true,
    value: {
      source: "worktree",
      worktree_ref: worktreeRelativePath(taskId),
      base_commit: raw.base_commit,
      changed_files: raw.changed_files,
      diff: raw.diff,
      diff_hash: raw.diff_hash
    }
  };
}

async function gitStdout(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
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
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
