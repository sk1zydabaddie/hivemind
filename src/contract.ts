import { stat } from "node:fs/promises";
import path from "node:path";
import { observableInterfaceKind, observableValidityCheckProblem } from "./acceptance-conformance.js";
import { writeJsonAtomic } from "./atomic.js";
import { appendTaskCreatedIfMissing } from "./events.js";
import { readJsonFile } from "./json.js";
import { normalizeRepoPathPattern, validateRepoRelativePathOrGlob } from "./path-pattern.js";
import { requireContractFromLintedPlan } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { requireActiveSpecRatified } from "./spec.js";
import { validateRequestedTaskId, validateTaskId } from "./task-id.js";
import { isRoutingTaskType, type RoutingTaskType, routingTaskTypeExpectation } from "./routing-task-type.js";
import { CONTRACT_FORMAT_VERSION, upcastContract } from "./contract-version.js";

export type AgentRole = "coordinator" | "scout" | "builder" | "reviewer";
export type AllowedFileIntent = "create" | "modify";

export interface TaskContract {
  /**
   * The on-disk format this contract came from, stamped by normalization and
   * written back out. Optional because it describes the *record*, not the
   * task: a contract built in memory is current by construction, so internal
   * synthesis and fixtures do not supply it. Absent on disk means the shape
   * that predates the field. See src/contract-version.ts.
   */
  contract_version?: number;
  task_id: string;
  title: string;
  agent_role: AgentRole;
  routing_task_type: RoutingTaskType;
  base_commit: string;
  acceptance_criterion: string;
  deterministic_validity_check?: string;
  allowed_files: string[];
  allowed_file_intents: Record<string, AllowedFileIntent>;
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
const allowedContractFields = new Set([
  "contract_version",
  "task_id",
  "title",
  "agent_role",
  "routing_task_type",
  "base_commit",
  "acceptance_criterion",
  "deterministic_validity_check",
  "allowed_files",
  "allowed_file_intents",
  "read_only_files",
  "forbidden_files",
  "allowed_symbols",
  "forbidden_symbols",
  "must_not_change",
  "required_tests",
  "patch_requirements"
]);

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

  // Same order as the load path, so validating an older contract by hand
  // reports what the run would actually do rather than a stale schema error.
  const upcast = upcastContract(result.raw, `.hivemind/tasks/${taskId}.contract.json`);
  if (!upcast.ok) {
    console.error(`error: ${upcast.reason}`);
    return 1;
  }
  for (const applied of upcast.value.applied) {
    console.error(`note: read as contract format ${CONTRACT_FORMAT_VERSION}, supplying ${applied}`);
  }

  const problems = validateContract(upcast.value.contract, taskId);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`error: ${problem}`);
    }
    return 1;
  }

  console.log(`${JSON.stringify(normalizeContract(upcast.value.contract), null, 2)}\n`);
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

  // Version first, schema second. A contract from a newer build otherwise
  // fails the closed-world field check with "unsupported contract field",
  // which reads as corruption rather than as a version it cannot read.
  // The bytes on disk are never touched: the upcast is in memory only,
  // because adoption re-hashes contract files and a rewrite would report
  // verified-then-stale on work that was already verified.
  const upcast = upcastContract(loaded.raw, `.hivemind/tasks/${taskId}.contract.json`);
  if (!upcast.ok) {
    return upcast;
  }

  const problems = validateContract(upcast.value.contract, taskId);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, contract: normalizeContract(upcast.value.contract) };
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

  const planResult = await requireContractFromLintedPlan(repoRoot, specResult.value.spec_id, contract);
  if (!planResult.ok) {
    return planResult;
  }

  const relativeContractPath = `.hivemind/tasks/${contract.task_id}.contract.json`;
  const contractPath = path.join(repoRoot, ".hivemind", "tasks", `${contract.task_id}.contract.json`);
  if (await exists(contractPath)) {
    return { ok: false, reason: `contract already exists: ${relativeContractPath}` };
  }

  await writeJsonAtomic(contractPath, contract);
  const eventResult = await appendTaskCreatedIfMissing(repoRoot, contract.task_id, {
    title: contract.title,
    agent_role: contract.agent_role,
    routing_task_type: contract.routing_task_type,
    base_commit: contract.base_commit,
    acceptance_criterion: contract.acceptance_criterion,
    allowed_files: contract.allowed_files,
    contract_path: relativeContractPath,
    source: "contract.create"
  });
  if (!eventResult.ok) {
    return { ok: false, reason: `failed to append task.created event: ${eventResult.reason}` };
  }
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
  requireString(raw, "acceptance_criterion", problems);
  if ("deterministic_validity_check" in raw && (typeof raw.deterministic_validity_check !== "string" || raw.deterministic_validity_check.trim() === "")) {
    problems.push("deterministic_validity_check must be a non-empty command when provided");
  }
  if (
    typeof raw.acceptance_criterion === "string" &&
    observableInterfaceKind(raw.acceptance_criterion) !== null &&
    !(typeof raw.deterministic_validity_check === "string" && raw.deterministic_validity_check.trim() !== "")
  ) {
    problems.push("SKELETON_TRAP_ACCEPTANCE: observable interface requires deterministic_validity_check");
  }
  if (
    typeof raw.acceptance_criterion === "string" &&
    observableInterfaceKind(raw.acceptance_criterion) !== null &&
    typeof raw.deterministic_validity_check === "string" &&
    Array.isArray(raw.required_tests)
  ) {
    const validityProblem = observableValidityCheckProblem(
      raw.deterministic_validity_check,
      raw.required_tests.filter((entry): entry is string => typeof entry === "string")
    );
    if (validityProblem !== null) problems.push(`SKELETON_TRAP_ACCEPTANCE: ${validityProblem}`);
  }
  if (!isRoutingTaskType(raw.routing_task_type)) {
    problems.push(`routing_task_type must be one of: ${routingTaskTypeExpectation()}`);
  }

  for (const key of Object.keys(raw)) {
    if (!allowedContractFields.has(key)) {
      problems.push(`unsupported contract field: ${key}`);
    }
  }

  if (typeof raw.task_id === "string" && raw.task_id.trim() !== "") {
    const taskIdProblem = validateTaskId(raw.task_id);
    if (taskIdProblem) {
      problems.push(`task_id contains invalid task id: ${taskIdProblem}`);
    }
    if (expectedTaskId !== undefined && raw.task_id !== expectedTaskId) {
      problems.push(`task_id "${raw.task_id}" must match requested task id "${expectedTaskId}"`);
    }
  }

  if (!Array.isArray(raw.allowed_files) || (raw.allowed_files.length === 0 && !isReadOnlyContractShape(raw))) {
    problems.push("allowed_files must be a non-empty array");
  }
  if (!Array.isArray(raw.required_tests) || raw.required_tests.filter((entry) => typeof entry === "string" && entry.trim() !== "").length === 0) {
    problems.push("required_tests must include at least one non-empty command backing acceptance_criterion");
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

  const intentProblem = validateAllowedFileIntentKeys(raw.allowed_files, raw.allowed_file_intents);
  if (intentProblem !== null) {
    problems.push(intentProblem);
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

  const allowedFiles = normalizeStringArray(raw.allowed_files);
  return {
    // Normalization runs after the upcast, so an unversioned contract has
    // already been stamped. A direct caller that skipped it is writing a
    // contract in this build's format by definition.
    contract_version: typeof raw.contract_version === "number"
      ? raw.contract_version
      : CONTRACT_FORMAT_VERSION,
    task_id: String(raw.task_id),
    title: typeof raw.title === "string" ? raw.title : "",
    agent_role: isAgentRole(raw.agent_role) ? raw.agent_role : "builder",
    routing_task_type: raw.routing_task_type as RoutingTaskType,
    base_commit: String(raw.base_commit),
    acceptance_criterion: typeof raw.acceptance_criterion === "string" ? raw.acceptance_criterion.trim() : "",
    ...(typeof raw.deterministic_validity_check === "string" ? { deterministic_validity_check: raw.deterministic_validity_check.trim() } : {}),
    allowed_files: allowedFiles,
    allowed_file_intents: normalizeAllowedFileIntents(allowedFiles, raw.allowed_file_intents),
    read_only_files: normalizeStringArray(raw.read_only_files),
    forbidden_files: normalizeStringArray(raw.forbidden_files),
    allowed_symbols: normalizeStringArray(raw.allowed_symbols),
    forbidden_symbols: normalizeStringArray(raw.forbidden_symbols),
    must_not_change: normalizeStringArray(raw.must_not_change),
    required_tests: normalizeStringArray(raw.required_tests),
    patch_requirements: normalizeStringArray(raw.patch_requirements)
  };
}

export function normalizeAllowedFileIntents(
  allowedFiles: string[],
  raw: unknown
): Record<string, AllowedFileIntent> {
  if (!isRecord(raw)) {
    return Object.fromEntries(allowedFiles.map((entry) => [normalizePathKey(entry), "modify" as const]));
  }
  const intents: Record<string, AllowedFileIntent> = {};
  for (const entry of allowedFiles) {
    const normalized = normalizePathKey(entry);
    const rawValues = [raw[entry], raw[normalized]];
    const validValues = rawValues.filter((value): value is AllowedFileIntent => value === "create" || value === "modify");
    intents[normalized] = validValues.length > 0 && validValues.every((value) => value === "create") ? "create" : "modify";
  }
  return intents;
}

function requireString(raw: Record<string, unknown>, field: string, problems: string[]): void {
  if (typeof raw[field] !== "string" || raw[field].trim() === "") {
    problems.push(`${field} is required`);
  }
}

function validateAllowedFileIntentKeys(allowedFiles: unknown, rawIntents: unknown): string | null {
  if (rawIntents === undefined || !isRecord(rawIntents) || !Array.isArray(allowedFiles)) {
    return null;
  }
  const allowedLookup = new Set(
    allowedFiles
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => [entry, normalizePathKey(entry)])
  );
  for (const key of Object.keys(rawIntents)) {
    if (!allowedLookup.has(key)) {
      return `allowed_file_intents contains unknown allowed_files entry: ${key}`;
    }
  }
  return null;
}

function normalizePathKey(value: string): string {
  return normalizeRepoPathPattern(value);
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

function isReadOnlyContractShape(raw: Record<string, unknown>): boolean {
  return (raw.agent_role === "reviewer" || raw.agent_role === "scout") &&
    Array.isArray(raw.allowed_files) && raw.allowed_files.length === 0 &&
    Array.isArray(raw.read_only_files) && raw.read_only_files.length > 0 &&
    isRecord(raw.allowed_file_intents) && Object.keys(raw.allowed_file_intents).length === 0;
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
