import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "./atomic.js";
import { type AgentRole } from "./contract.js";
import { findGitRoot } from "./repo.js";
import { checkPlanningAllowed } from "./spec.js";
import { type SpecResult, validateRequestedSpecId } from "./spec-format.js";
import { validateRequestedTaskId } from "./task-id.js";

const execFileAsync = promisify(execFile);

export type TentativeTaskMode = "read_only" | "write" | "integration";
export type ExecutionGroupMode = "parallel" | "sequence";

export interface DraftScope {
  allowed_files: string[];
  read_only_files: string[];
  forbidden_files: string[];
  must_not_change: string[];
}

export interface TentativePlanTask {
  task_id: string;
  title: string;
  mode: TentativeTaskMode;
  agent_role: AgentRole;
  draft_scope: DraftScope;
  depends_on: string[];
  parallel_safe: boolean;
  acceptance_criterion: string;
  required_tests: string[];
  patch_requirements: string[];
  scope_status: "draft_ungrounded";
}

export interface TentativePlanExecutionGroup {
  group_id: string;
  mode: ExecutionGroupMode;
  task_ids: string[];
}

export interface TentativePlan {
  version: 1;
  spec_id: string;
  status: "tentative";
  base_commit: string;
  source: "cli-json";
  created_at: string;
  tasks: TentativePlanTask[];
  execution_groups: TentativePlanExecutionGroup[];
}

export interface TentativePlanResult {
  spec_id: string;
  plan_path: string;
  status: "tentative";
  base_commit: string;
  task_count: number;
  execution_group_count: number;
}

interface TentativePlanInputTask {
  task_id: string;
  title: string;
  mode: TentativeTaskMode;
  agent_role: AgentRole;
  draft_scope: DraftScope;
  depends_on: string[];
  parallel_safe: boolean;
  acceptance_criterion: string;
  required_tests: string[];
  patch_requirements: string[];
}

interface TentativePlanInput {
  tasks: TentativePlanInputTask[];
  execution_groups: TentativePlanExecutionGroup[];
}

export async function planCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parsePlanArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result =
    parsed.value.action === "check"
      ? await checkPlanningAllowed(repoRoot, parsed.value.specId)
      : await createTentativePlanFromFile(repoRoot, parsed.value.specId, parsed.value.planFile);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function createTentativePlanFromFile(
  repoRoot: string,
  specId: string,
  planFile: string
): Promise<SpecResult<TentativePlanResult>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planFile, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "plan proposal file must contain valid JSON" };
    }
    throw error;
  }
  return createTentativePlan(repoRoot, specId, raw);
}

export async function createTentativePlan(
  repoRoot: string,
  specId: string,
  rawPlan: unknown
): Promise<SpecResult<TentativePlanResult>> {
  const allowed = await checkPlanningAllowed(repoRoot, specId);
  if (!allowed.ok) {
    return allowed;
  }

  const parsed = await parseTentativePlanInput(repoRoot, specId, rawPlan);
  if (!parsed.ok) {
    return parsed;
  }

  const baseCommit = await currentHead(repoRoot);
  if (!baseCommit.ok) {
    return baseCommit;
  }

  const plan: TentativePlan = {
    version: 1,
    spec_id: specId,
    status: "tentative",
    base_commit: baseCommit.value,
    source: "cli-json",
    created_at: new Date().toISOString(),
    tasks: parsed.value.tasks.map((task) => ({ ...task, scope_status: "draft_ungrounded" })),
    execution_groups: parsed.value.execution_groups
  };

  const planPath = tentativePlanPath(repoRoot, specId);
  await writeJsonAtomic(planPath, plan);
  return {
    ok: true,
    value: {
      spec_id: specId,
      plan_path: tentativePlanRelativePath(specId),
      status: "tentative",
      base_commit: baseCommit.value,
      task_count: plan.tasks.length,
      execution_group_count: plan.execution_groups.length
    }
  };
}

function parsePlanArgs(
  args: string[]
): SpecResult<{ action: "check"; specId: string } | { action: "propose"; specId: string; planFile: string }> {
  const [specId, flag, value, ...rest] = args;
  if (!specId) {
    return { ok: false, reason: planUsage() };
  }
  if (flag === "--check" && value === undefined && rest.length === 0) {
    return { ok: true, value: { action: "check", specId } };
  }
  if (flag === "--propose" && typeof value === "string" && rest.length === 0) {
    return { ok: true, value: { action: "propose", specId, planFile: value } };
  }
  return { ok: false, reason: planUsage() };
}

function planUsage(): string {
  return "usage: hivemind plan <spec-id> --check | --propose <plan-json-file>";
}

async function parseTentativePlanInput(repoRoot: string, specId: string, raw: unknown): Promise<SpecResult<TentativePlanInput>> {
  const specIdResult = validateRequestedSpecId(specId);
  if (!specIdResult.ok) {
    return specIdResult;
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "plan proposal must be a JSON object" };
  }

  const topLevelKeys = new Set(["tasks", "execution_groups"]);
  const extraTopLevel = Object.keys(raw).filter((key) => !topLevelKeys.has(key));
  if (extraTopLevel.length > 0) {
    return { ok: false, reason: `plan proposal contains unsupported top-level field: ${extraTopLevel[0]}` };
  }

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return { ok: false, reason: "plan proposal tasks must be a non-empty array" };
  }
  if (!Array.isArray(raw.execution_groups) || raw.execution_groups.length === 0) {
    return { ok: false, reason: "plan proposal execution_groups must be a non-empty array" };
  }

  const tasks: TentativePlanInputTask[] = [];
  const taskIds = new Set<string>();
  for (const [index, entry] of raw.tasks.entries()) {
    const task = await parseTentativeTask(repoRoot, index, entry);
    if (!task.ok) {
      return task;
    }
    if (taskIds.has(task.value.task_id)) {
      return { ok: false, reason: `tasks[${index}].task_id duplicates ${task.value.task_id}` };
    }
    taskIds.add(task.value.task_id);
    tasks.push(task.value);
  }

  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.depends_on) {
      if (!taskIds.has(dependency)) {
        return { ok: false, reason: `tasks[${index}].depends_on references unknown task ${dependency}` };
      }
    }
  }

  const executionGroups: TentativePlanExecutionGroup[] = [];
  const groupedTaskIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const [index, entry] of raw.execution_groups.entries()) {
    const group = parseExecutionGroup(index, entry, taskIds, groupedTaskIds, groupIds);
    if (!group.ok) {
      return group;
    }
    executionGroups.push(group.value);
  }

  for (const taskId of taskIds) {
    if (!groupedTaskIds.has(taskId)) {
      return { ok: false, reason: `execution_groups must include task ${taskId}` };
    }
  }

  return { ok: true, value: { tasks, execution_groups: executionGroups } };
}

async function parseTentativeTask(repoRoot: string, index: number, raw: unknown): Promise<SpecResult<TentativePlanInputTask>> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `tasks[${index}] must be a JSON object` };
  }
  const allowedKeys = new Set([
    "task_id",
    "title",
    "mode",
    "agent_role",
    "draft_scope",
    "depends_on",
    "parallel_safe",
    "acceptance_criterion",
    "required_tests",
    "patch_requirements"
  ]);
  const extra = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `tasks[${index}] contains unsupported field: ${extra[0]}` };
  }

  if (typeof raw.task_id !== "string") {
    return { ok: false, reason: `tasks[${index}].task_id is required` };
  }
  const taskIdResult = validateRequestedTaskId(raw.task_id);
  if (!taskIdResult.ok) {
    return { ok: false, reason: `tasks[${index}].${taskIdResult.reason}` };
  }
  if (await exists(path.join(repoRoot, ".hivemind", "tasks", `${raw.task_id}.contract.json`))) {
    return { ok: false, reason: `tasks[${index}].task_id collides with existing contract: .hivemind/tasks/${raw.task_id}.contract.json` };
  }

  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    return { ok: false, reason: `tasks[${index}].title must be a non-empty string` };
  }
  if (!isTaskMode(raw.mode)) {
    return { ok: false, reason: `tasks[${index}].mode must be read_only, write, or integration` };
  }
  if (!isAgentRole(raw.agent_role)) {
    return { ok: false, reason: `tasks[${index}].agent_role must be coordinator, scout, builder, or reviewer` };
  }
  if (!isRecord(raw.draft_scope)) {
    return { ok: false, reason: `tasks[${index}].draft_scope must be a JSON object` };
  }
  const draftScope = parseDraftScope(index, raw.draft_scope);
  if (!draftScope.ok) {
    return draftScope;
  }
  const dependsOn = parseStringArray(`tasks[${index}].depends_on`, raw.depends_on);
  if (!dependsOn.ok) {
    return dependsOn;
  }
  for (const dependency of dependsOn.value) {
    const dependencyIdResult = validateRequestedTaskId(dependency);
    if (!dependencyIdResult.ok) {
      return { ok: false, reason: `tasks[${index}].depends_on contains invalid task id "${dependency}"` };
    }
  }
  if (typeof raw.parallel_safe !== "boolean") {
    return { ok: false, reason: `tasks[${index}].parallel_safe must be a boolean` };
  }
  if (typeof raw.acceptance_criterion !== "string" || raw.acceptance_criterion.trim() === "") {
    return { ok: false, reason: `tasks[${index}].acceptance_criterion must be a non-empty string` };
  }
  const requiredTests = parseStringArray(`tasks[${index}].required_tests`, raw.required_tests);
  if (!requiredTests.ok) {
    return requiredTests;
  }
  const patchRequirements = parseStringArray(`tasks[${index}].patch_requirements`, raw.patch_requirements);
  if (!patchRequirements.ok) {
    return patchRequirements;
  }

  return {
    ok: true,
    value: {
      task_id: raw.task_id,
      title: raw.title.trim(),
      mode: raw.mode,
      agent_role: raw.agent_role,
      draft_scope: draftScope.value,
      depends_on: dependsOn.value,
      parallel_safe: raw.parallel_safe,
      acceptance_criterion: raw.acceptance_criterion.trim(),
      required_tests: requiredTests.value,
      patch_requirements: patchRequirements.value
    }
  };
}

function parseDraftScope(index: number, raw: Record<string, unknown>): SpecResult<DraftScope> {
  const allowedKeys = new Set(["allowed_files", "read_only_files", "forbidden_files", "must_not_change"]);
  const extra = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `tasks[${index}].draft_scope contains unsupported field: ${extra[0]}` };
  }

  const allowedFiles = parseStringArray(`tasks[${index}].draft_scope.allowed_files`, raw.allowed_files);
  if (!allowedFiles.ok) {
    return allowedFiles;
  }
  const readOnlyFiles = parseStringArray(`tasks[${index}].draft_scope.read_only_files`, raw.read_only_files);
  if (!readOnlyFiles.ok) {
    return readOnlyFiles;
  }
  const forbiddenFiles = parseStringArray(`tasks[${index}].draft_scope.forbidden_files`, raw.forbidden_files);
  if (!forbiddenFiles.ok) {
    return forbiddenFiles;
  }
  const mustNotChange = parseStringArray(`tasks[${index}].draft_scope.must_not_change`, raw.must_not_change);
  if (!mustNotChange.ok) {
    return mustNotChange;
  }
  return {
    ok: true,
    value: {
      allowed_files: allowedFiles.value,
      read_only_files: readOnlyFiles.value,
      forbidden_files: forbiddenFiles.value,
      must_not_change: mustNotChange.value
    }
  };
}

function parseExecutionGroup(
  index: number,
  raw: unknown,
  knownTaskIds: Set<string>,
  groupedTaskIds: Set<string>,
  groupIds: Set<string>
): SpecResult<TentativePlanExecutionGroup> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `execution_groups[${index}] must be a JSON object` };
  }
  const allowedKeys = new Set(["group_id", "mode", "task_ids"]);
  const extra = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `execution_groups[${index}] contains unsupported field: ${extra[0]}` };
  }
  if (typeof raw.group_id !== "string" || raw.group_id.trim() === "") {
    return { ok: false, reason: `execution_groups[${index}].group_id must be a non-empty string` };
  }
  if (groupIds.has(raw.group_id)) {
    return { ok: false, reason: `execution_groups[${index}].group_id duplicates ${raw.group_id}` };
  }
  groupIds.add(raw.group_id);
  if (!isExecutionGroupMode(raw.mode)) {
    return { ok: false, reason: `execution_groups[${index}].mode must be parallel or sequence` };
  }
  const taskIds = parseStringArray(`execution_groups[${index}].task_ids`, raw.task_ids);
  if (!taskIds.ok) {
    return taskIds;
  }
  if (taskIds.value.length === 0) {
    return { ok: false, reason: `execution_groups[${index}].task_ids must be non-empty` };
  }
  const localTaskIds = new Set<string>();
  for (const taskId of taskIds.value) {
    if (!knownTaskIds.has(taskId)) {
      return { ok: false, reason: `execution_groups[${index}].task_ids references unknown task ${taskId}` };
    }
    if (localTaskIds.has(taskId) || groupedTaskIds.has(taskId)) {
      return { ok: false, reason: `execution_groups[${index}].task_ids repeats task ${taskId}` };
    }
    localTaskIds.add(taskId);
    groupedTaskIds.add(taskId);
  }
  return {
    ok: true,
    value: {
      group_id: raw.group_id.trim(),
      mode: raw.mode,
      task_ids: taskIds.value
    }
  };
}

function parseStringArray(label: string, value: unknown): SpecResult<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `${label} must be an array of strings` };
  }
  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      return { ok: false, reason: `${label}[${index}] must be a string` };
    }
    strings.push(entry);
  }
  return { ok: true, value: strings };
}

async function currentHead(repoRoot: string): Promise<SpecResult<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, windowsHide: true });
    const value = stdout.trim();
    return value === "" ? { ok: false, reason: "git HEAD is empty" } : { ok: true, value };
  } catch {
    return { ok: false, reason: "failed to resolve current git HEAD" };
  }
}

function tentativePlanPath(repoRoot: string, specId: string): string {
  return path.join(repoRoot, tentativePlanRelativePath(specId));
}

function tentativePlanRelativePath(specId: string): string {
  return `.hivemind/plans/${specId}.tentative.json`;
}

function isTaskMode(value: unknown): value is TentativeTaskMode {
  return value === "read_only" || value === "write" || value === "integration";
}

function isExecutionGroupMode(value: unknown): value is ExecutionGroupMode {
  return value === "parallel" || value === "sequence";
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === "coordinator" || value === "scout" || value === "builder" || value === "reviewer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
