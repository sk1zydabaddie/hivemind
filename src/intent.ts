import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { canonicalizeConcreteFileScope } from "./file-scope.js";
import { readJsonFile } from "./json.js";
import { readActiveLeases } from "./lease.js";
import { findGitRoot } from "./repo.js";
import { validateRequestedTaskId, validateTaskId } from "./task-id.js";

export interface WriteIntent {
  task_id: string;
  intended_files: string[];
  intended_symbols: string[];
  possible_risks: string[];
  will_not_change: string[];
}

export interface WriteIntentPass {
  task_id: string;
  verdict: "pass";
  intended_files: string[];
}

export interface StoredWriteIntentPass extends WriteIntentPass {
  version: 1;
  approved_at: string;
}

type IntentResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function intentCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, intentPath, ...rest] = args;
  if (!taskId || !intentPath || rest.length > 0) {
    console.error("error: usage: hivemind intent <id> <intent.json>");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const loadResult = await loadIntentFile(cwd, intentPath);
  if (!loadResult.ok) {
    console.error(`error: ${loadResult.reason}`);
    return 1;
  }

  const result = await checkWriteIntent(repoRoot, taskId, loadResult.value);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function checkWriteIntent(repoRoot: string, taskId: string, rawIntent: unknown): Promise<IntentResult<WriteIntentPass>> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const validation = validateWriteIntent(rawIntent, taskId);
  if (!validation.ok) {
    return validation;
  }

  const pathsResult = await canonicalizeConcreteFileScope(repoRoot, validation.value.intended_files, "intended");
  if (!pathsResult.ok) {
    return pathsResult;
  }

  const storeResult = await readActiveLeases(repoRoot);
  if (!storeResult.ok) {
    return storeResult;
  }

  const conflicts = pathsResult.paths
    .map((filePath) => ({ filePath, holder: storeResult.store[filePath] }))
    .filter((entry) => entry.holder !== taskId);
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `write intent rejected: ${conflicts
        .map((entry) => `${entry.filePath} ${entry.holder === undefined ? "is not leased" : `held by ${entry.holder}`}`)
        .join("; ")}`
    };
  }

  const approved: StoredWriteIntentPass = {
    version: 1,
    task_id: taskId,
    verdict: "pass",
    intended_files: pathsResult.paths,
    approved_at: new Date().toISOString()
  };
  await writeJsonAtomic(passedIntentPath(repoRoot, taskId), approved);
  return { ok: true, value: { task_id: taskId, verdict: "pass", intended_files: pathsResult.paths } };
}

export async function requirePassedWriteIntent(repoRoot: string, taskId: string): Promise<IntentResult<StoredWriteIntentPass>> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  let raw: unknown;
  try {
    raw = await readJsonFile(passedIntentPath(repoRoot, taskId));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `passed write intent not found for ${taskId}; run hivemind intent ${taskId} <intent.json> before invoking a worker` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in .hivemind/intents/${taskId}.approved.json` };
    }
    throw error;
  }

  const parsed = validateStoredWriteIntent(raw, taskId);
  if (!parsed.ok) {
    return parsed;
  }

  const storeResult = await readActiveLeases(repoRoot);
  if (!storeResult.ok) {
    return storeResult;
  }
  const conflicts = parsed.value.intended_files
    .map((filePath) => ({ filePath, holder: storeResult.store[filePath] }))
    .filter((entry) => entry.holder !== taskId);
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `passed write intent is no longer covered by the active lease: ${conflicts
        .map((entry) => `${entry.filePath} ${entry.holder === undefined ? "is not leased" : `held by ${entry.holder}`}`)
        .join("; ")}`
    };
  }

  return parsed;
}

export function validateWriteIntent(raw: unknown, expectedTaskId: string): IntentResult<WriteIntent> {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, reason: "intent must be a JSON object" };
  }

  if (typeof raw.task_id !== "string" || raw.task_id.trim() === "") {
    problems.push("task_id is required");
  } else {
    const taskIdProblem = validateTaskId(raw.task_id);
    if (taskIdProblem) {
      problems.push(`task_id contains invalid task id: ${taskIdProblem}`);
    }
    if (raw.task_id !== expectedTaskId) {
      problems.push(`task_id "${raw.task_id}" must match requested task id "${expectedTaskId}"`);
    }
  }

  if (!Array.isArray(raw.intended_files) || raw.intended_files.length === 0) {
    problems.push("intended_files must be a non-empty array");
  } else if (!raw.intended_files.every((entry) => typeof entry === "string")) {
    problems.push("intended_files must be an array of strings");
  }

  for (const field of ["intended_symbols", "possible_risks", "will_not_change"] as const) {
    if (field in raw && !isStringArray(raw[field])) {
      problems.push(`${field} must be an array of strings`);
    }
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return {
    ok: true,
    value: {
      task_id: raw.task_id as string,
      intended_files: raw.intended_files as string[],
      intended_symbols: normalizeStringArray(raw.intended_symbols),
      possible_risks: normalizeStringArray(raw.possible_risks),
      will_not_change: normalizeStringArray(raw.will_not_change)
    }
  };
}

async function loadIntentFile(cwd: string, intentPath: string): Promise<IntentResult<unknown>> {
  const fullPath = path.isAbsolute(intentPath) ? intentPath : path.resolve(cwd, intentPath);
  try {
    return { ok: true, value: await readJsonFile(fullPath) };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `intent file not found: ${intentPath}` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in intent file: ${intentPath}` };
    }
    throw error;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}

function validateStoredWriteIntent(raw: unknown, expectedTaskId: string): IntentResult<StoredWriteIntentPass> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `passed write intent for ${expectedTaskId} must be a JSON object` };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: `passed write intent for ${expectedTaskId} must have version 1` };
  }
  if (raw.task_id !== expectedTaskId) {
    return { ok: false, reason: `passed write intent task_id must be ${expectedTaskId}` };
  }
  if (raw.verdict !== "pass") {
    return { ok: false, reason: `passed write intent for ${expectedTaskId} must have verdict pass` };
  }
  if (!Array.isArray(raw.intended_files) || raw.intended_files.length === 0 || !raw.intended_files.every((entry) => typeof entry === "string")) {
    return { ok: false, reason: `passed write intent for ${expectedTaskId} must include intended_files` };
  }
  if (typeof raw.approved_at !== "string" || Number.isNaN(Date.parse(raw.approved_at))) {
    return { ok: false, reason: `passed write intent for ${expectedTaskId} must include approved_at` };
  }
  return {
    ok: true,
    value: {
      version: 1,
      task_id: expectedTaskId,
      verdict: "pass",
      intended_files: raw.intended_files,
      approved_at: raw.approved_at
    }
  };
}

function passedIntentPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, ".hivemind", "intents", `${taskId}.approved.json`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
