import { stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified } from "./spec.js";
import { validateRequestedTaskId, validateTaskId } from "./task-id.js";

export type AgentRole = "coordinator" | "scout" | "builder" | "reviewer";

export interface TaskContract {
  task_id: string;
  title: string;
  agent_role: AgentRole;
  base_commit: string;
  allowed_files: string[];
  read_only_files: string[];
  forbidden_files: string[];
  allowed_symbols: string[];
  forbidden_symbols: string[];
  must_not_change: string[];
  required_tests: string[];
  patch_requirements: string[];
}

export interface CreateTaskContractResult {
  task_id: string;
  contract_path: string;
  contract: TaskContract;
}

const arrayFields = [
  "allowed_files",
  "read_only_files",
  "forbidden_files",
  "allowed_symbols",
  "forbidden_symbols",
  "must_not_change",
  "required_tests",
  "patch_requirements"
] as const;

const pathArrayFields = ["allowed_files", "read_only_files", "forbidden_files"] as const;

export async function validateContractCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, flag, ...rest] = args;
  if (!taskId || flag !== "--validate" || rest.length > 0) {
    console.error("error: usage: hivemind contract <id> --validate");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await loadContract(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  const problems = validateContract(result.raw, taskId);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`error: ${problem}`);
    }
    return 1;
  }

  console.log(`${JSON.stringify(normalizeContract(result.raw), null, 2)}\n`);
  return 0;
}

export async function loadContract(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; raw: unknown } | { ok: false; reason: string }> {
  const taskIdResult = validateRequestedTaskId(taskId);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const contractPath = path.join(repoRoot, ".hivemind", "tasks", `${taskId}.contract.json`);
  try {
    return { ok: true, raw: await readJsonFile(contractPath) };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `contract not found: .hivemind/tasks/${taskId}.contract.json` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in .hivemind/tasks/${taskId}.contract.json` };
    }
    throw error;
  }
}

export async function loadAndValidateContract(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; contract: TaskContract } | { ok: false; reason: string }> {
  const loaded = await loadContract(repoRoot, taskId);
  if (!loaded.ok) {
    return loaded;
  }

  const problems = validateContract(loaded.raw, taskId);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, contract: normalizeContract(loaded.raw) };
}

export async function createTaskContract(
  repoRoot: string,
  rawContract: unknown
): Promise<{ ok: true; value: CreateTaskContractResult } | { ok: false; reason: string }> {
  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }

  const problems = validateContract(rawContract);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  const contract = normalizeContract(rawContract);
  const taskIdResult = validateRequestedTaskId(contract.task_id);
  if (!taskIdResult.ok) {
    return taskIdResult;
  }

  const relativeContractPath = `.hivemind/tasks/${contract.task_id}.contract.json`;
  const contractPath = path.join(repoRoot, ".hivemind", "tasks", `${contract.task_id}.contract.json`);
  if (await exists(contractPath)) {
    return { ok: false, reason: `contract already exists: ${relativeContractPath}` };
  }

  await writeJsonAtomic(contractPath, contract);
  return {
    ok: true,
    value: {
      task_id: contract.task_id,
      contract_path: relativeContractPath,
      contract
    }
  };
}

export function validateContract(raw: unknown, expectedTaskId?: string): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return ["contract must be a JSON object"];
  }

  requireString(raw, "task_id", problems);
  requireString(raw, "base_commit", problems);

  if (typeof raw.task_id === "string" && raw.task_id.trim() !== "") {
    const taskIdProblem = validateTaskId(raw.task_id);
    if (taskIdProblem) {
      problems.push(`task_id contains invalid task id: ${taskIdProblem}`);
    }
    if (expectedTaskId !== undefined && raw.task_id !== expectedTaskId) {
      problems.push(`task_id "${raw.task_id}" must match requested task id "${expectedTaskId}"`);
    }
  }

  if (!Array.isArray(raw.allowed_files) || raw.allowed_files.length === 0) {
    problems.push("allowed_files must be a non-empty array");
  }

  for (const field of arrayFields) {
    const value = raw[field];
    if (value !== undefined && !isStringArray(value)) {
      problems.push(`${field} must be an array of strings`);
    }
  }

  for (const field of pathArrayFields) {
    const value = raw[field];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== "string") {
          continue;
        }
        const pathProblem = validateRepoRelativePathOrGlob(entry);
        if (pathProblem) {
          problems.push(`${field} contains invalid path "${entry}": ${pathProblem}`);
        }
      }
    }
  }

  if (Array.isArray(raw.allowed_files) && Array.isArray(raw.forbidden_files)) {
    const forbidden = new Set(raw.forbidden_files.filter((entry): entry is string => typeof entry === "string"));
    for (const entry of raw.allowed_files) {
      if (typeof entry === "string" && forbidden.has(entry)) {
        problems.push(`path "${entry}" may not appear in both allowed_files and forbidden_files`);
      }
    }
  }

  if (raw.agent_role !== undefined && !isAgentRole(raw.agent_role)) {
    problems.push("agent_role must be one of coordinator, scout, builder, reviewer");
  }

  return problems;
}

export function normalizeContract(raw: unknown): TaskContract {
  if (!isRecord(raw)) {
    throw new Error("cannot normalize invalid contract");
  }

  return {
    task_id: String(raw.task_id),
    title: typeof raw.title === "string" ? raw.title : "",
    agent_role: isAgentRole(raw.agent_role) ? raw.agent_role : "builder",
    base_commit: String(raw.base_commit),
    allowed_files: normalizeStringArray(raw.allowed_files),
    read_only_files: normalizeStringArray(raw.read_only_files),
    forbidden_files: normalizeStringArray(raw.forbidden_files),
    allowed_symbols: normalizeStringArray(raw.allowed_symbols),
    forbidden_symbols: normalizeStringArray(raw.forbidden_symbols),
    must_not_change: normalizeStringArray(raw.must_not_change),
    required_tests: normalizeStringArray(raw.required_tests),
    patch_requirements: normalizeStringArray(raw.patch_requirements)
  };
}

function requireString(raw: Record<string, unknown>, field: string, problems: string[]): void {
  if (typeof raw[field] !== "string" || raw[field].trim() === "") {
    problems.push(`${field} is required`);
  }
}

function validateRepoRelativePathOrGlob(value: string): string | null {
  if (value.trim() === "") {
    return "entry must not be empty";
  }
  if (path.isAbsolute(value)) {
    return "absolute paths are not allowed";
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.includes("..")) {
    return ".. traversal is not allowed";
  }
  if (parts.includes(".git")) {
    return ".git paths are not allowed";
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === "coordinator" || value === "scout" || value === "builder" || value === "reviewer";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
