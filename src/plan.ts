import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { observableInterfaceKind, observableValidityCheckProblem } from "./acceptance-conformance.js";
import { writeJsonAtomic } from "./atomic.js";
import { type AutonomyLevel } from "./autonomy-level.js";
import { readProjectAutonomyLevel, recordAutonomyDecision } from "./autonomy.js";
import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  runAdapterProcess
} from "./adapter.js";
import { canonicalizeIntentPath } from "./canonicalize.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { loadConfig } from "./config.js";
import { normalizeAllowedFileIntents, type AgentRole, type AllowedFileIntent, type TaskContract } from "./contract.js";
import { appendEvent, readEvents } from "./events.js";
import { matchesAny } from "./glob.js";
import { integratedTaskIdsFromEvents } from "./integration-state.js";
import { extractJsonObject } from "./json.js";
import { buildPlanningGenerationPrompt } from "./planning-prompt.js";
import { assertNoKnownFailedScopeRepeat, evaluateThrashForPlan, type ReplanEvaluationResult } from "./replan.js";
import { findGitRoot } from "./repo.js";
import { isRoutingTaskType, type RoutingTaskType, routingTaskTypeExpectation } from "./routing-task-type.js";
import { checkPlanningAllowed, requireActiveSpecRatified } from "./spec.js";
import { loadSpecDocument, type SpecResult, validateRequestedSpecId } from "./spec-format.js";
import { validateRequestedTaskId } from "./task-id.js";
import { latestTaskRunState } from "./run-state.js";
import { workerProtectedPathReason, workerProtectedScopeReason } from "./worker-protected-paths.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";
import { codedFailure, hasFailureCode } from "./failure-code.js";

const execFileAsync = promisify(execFile);

export type TentativeTaskMode = "read_only" | "write" | "integration";
export type TentativeTaskType = "generative" | "deterministic";
export type ExecutionGroupMode = "parallel" | "sequence";
type TentativePlanSource = "cli-json" | "adapter-generated";

export interface DraftScope {
  allowed_files: string[];
  allowed_file_intents?: Record<string, AllowedFileIntent>;
  read_only_files: string[];
  forbidden_files: string[];
  must_not_change: string[];
}

type DraftScopePathField = "allowed_files" | "read_only_files" | "forbidden_files";

export interface TentativePlanTask {
  task_id: string;
  title: string;
  task_type: TentativeTaskType;
  routing_task_type: RoutingTaskType;
  mode: TentativeTaskMode;
  agent_role: AgentRole;
  draft_scope: DraftScope;
  depends_on: string[];
  parallel_safe: boolean;
  acceptance_criterion: string;
  deterministic_validity_check?: string;
  required_tests: string[];
  patch_requirements: string[];
  critical_path_approved: boolean;
  scope_status: ScopeStatus;
  grounding_evidence?: GroundingEvidence;
  grounded_scope?: DraftScope;
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
  source: TentativePlanSource;
  created_at: string;
  grounding_status?: "grounded";
  grounded_at?: string;
  grounded_base_commit?: string;
  lint_status?: "passed";
  linted_at?: string;
  linted_base_commit?: string;
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

export interface GeneratedPlanResult extends TentativePlanResult {
  tool: string;
  proposal_path: string;
  source: "adapter-generated";
  apply_command: string;
}

export interface WorkspacePreparedPlanResult {
  spec_id: string;
  plan_hash: string;
  plan_path: string;
  proposal_path: string;
  usage_session_id: string;
  task_count: number;
  lint_status: "passed";
  status: "awaiting_ratification" | "ratified_by_policy";
  autonomy_level: AutonomyLevel;
}

export interface GroundPlanResult {
  spec_id: string;
  plan_path: string;
  status: "tentative";
  grounding_status: "grounded";
  base_commit: string;
  task_count: number;
}

export interface PlanLintResult {
  spec_id: string;
  plan_path: string;
  status: "tentative";
  lint_status: "passed";
  base_commit: string;
  task_count: number;
  rule_count: number;
}

export interface PlanRatificationResult {
  spec_id: string;
  plan_hash: string;
  plan_path: string;
  task_count: number;
  plan: TentativePlan;
}

export interface ManualTaskAuthorizationReview {
  spec_id: string;
  task_id: string;
  contract_hash: string;
  contract_path: string;
}

export interface PlanAmendmentResult {
  amendment_id: string;
  spec_id: string;
  kind: "add_task" | "edit_task";
  task_id: string;
  status: "queued";
}

export interface GroundingEvidence {
  source: "git-tree";
  base_commit: string;
  checked_at: string;
  cited_paths: string[];
  resolved_files: string[];
}

type ScopeStatus = "draft_ungrounded" | "grounded";

interface TentativePlanInputTask {
  task_id: string;
  title: string;
  task_type: TentativeTaskType;
  routing_task_type: RoutingTaskType;
  mode: TentativeTaskMode;
  agent_role: AgentRole;
  draft_scope: DraftScope;
  depends_on: string[];
  parallel_safe: boolean;
  acceptance_criterion: string;
  deterministic_validity_check?: string;
  required_tests: string[];
  patch_requirements: string[];
  critical_path_approved: boolean;
}

interface TentativePlanInput {
  tasks: TentativePlanInputTask[];
  execution_groups: TentativePlanExecutionGroup[];
}

export interface PlanCommandOptions {
  closureCoverageAdvisory?: (repoRoot: string, specId: string) => Promise<unknown | undefined>;
}

export async function planCommand(cwd: string, args: string[], options: PlanCommandOptions = {}): Promise<number> {
  const parsed = parsePlanArgs(cwd, args);
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
      : parsed.value.action === "propose"
        ? await createTentativePlanFromFile(repoRoot, parsed.value.specId, parsed.value.planFile)
        : parsed.value.action === "generate"
          ? await generateTentativePlan(repoRoot, parsed.value.specId, parsed.value.tool, parsed.value.outPath, parsed.value.steering)
          : parsed.value.action === "ground"
            ? await groundTentativePlan(repoRoot, parsed.value.specId)
            : parsed.value.action === "lint"
              ? await lintTentativePlan(repoRoot, parsed.value.specId)
              : parsed.value.action === "review"
                ? await reviewPlanForRatification(repoRoot, parsed.value.specId)
                : parsed.value.action === "ratify"
                  ? await ratifyPlan(repoRoot, parsed.value.specId, parsed.value.expectedHash)
                  : await routeThrashEvaluation(repoRoot, parsed.value.specId, parsed.value.taskId, parsed.value.budget);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  let output: unknown = result.value;
  if (parsed.value.action === "ground" && options.closureCoverageAdvisory !== undefined) {
    try {
      const advisory = await options.closureCoverageAdvisory(repoRoot, parsed.value.specId);
      if (advisory !== undefined) {
        output = { ...result.value, advisories: { closure_coverage: advisory } };
      }
    } catch {
      // Advisory failure must never change grounding's successful result.
    }
  }

  console.log(JSON.stringify(output, null, 2));
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
  rawPlan: unknown,
  source: TentativePlanSource = "cli-json"
): Promise<SpecResult<TentativePlanResult>> {
  const allowed = await checkPlanningAllowed(repoRoot, specId);
  if (!allowed.ok) {
    return allowed;
  }

  const parsed = await parseTentativePlanInput(repoRoot, specId, rawPlan);
  if (!parsed.ok) {
    return parsed;
  }
  const failedScopeGuard = await assertNoKnownFailedScopeRepeat(repoRoot, specId, parsed.value.tasks);
  if (!failedScopeGuard.ok) {
    return failedScopeGuard;
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
    source,
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

export async function generateTentativePlan(
  repoRoot: string,
  specId: string,
  tool: string,
  outPath: string,
  steering?: string
): Promise<SpecResult<GeneratedPlanResult>> {
  return generateTentativePlanWithSession(repoRoot, specId, tool, outPath, steering);
}

async function generateTentativePlanWithSession(
  repoRoot: string,
  specId: string,
  tool: string,
  outPath: string,
  steering?: string,
  usageSessionId?: string
): Promise<SpecResult<GeneratedPlanResult>> {
  const allowed = await checkPlanningAllowed(repoRoot, specId);
  if (!allowed.ok) {
    return allowed;
  }
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) {
    return spec;
  }
  const confinedOut = confineOutputPath(repoRoot, outPath, "planning proposal");
  if (!confinedOut.ok) {
    return confinedOut;
  }
  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }
  const dangerousArgs = findDangerousAdapterArgs(profileResult.profile.invoke);
  if (dangerousArgs.length > 0) {
    return {
      ok: false,
      reason: `planning adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); proposal generation must use a non-dangerous profile`
    };
  }

  const baseCommit = await currentHead(repoRoot);
  if (!baseCommit.ok) {
    return baseCommit;
  }
  const trackedFiles = await trackedFilesAtBase(repoRoot, baseCommit.value);
  if (!trackedFiles.ok) {
    return trackedFiles;
  }

  const prompt = await buildPlanningGenerationPrompt({
    repoRoot,
    specId,
    specMarkdown: spec.value.markdown,
    baseCommit: baseCommit.value,
    trackedFiles: trackedFiles.value,
    ...(steering === undefined ? {} : { steering })
  });
  if (!prompt.ok) {
    return prompt;
  }
  const processResult = await runAdapterProcess(repoRoot, profileResult.profile, repoRoot, prompt.value, {
    outputLogPath: adapterRunLogPath(repoRoot, `planning-${specId}`),
    usageSessionId,
    usageRunId: usageSessionId ?? specId
  });
  if (!processResult.ok) {
    return processResult;
  }
  if (processResult.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, processResult.value, "planning adapter") };
  }

  const proposal = parseGeneratedPlan(processResult.value.modelOutput);
  if (!proposal.ok) {
    return proposal;
  }
  await writeJsonAtomic(confinedOut.value.absolutePath, proposal.value);

  const stored = await createTentativePlan(repoRoot, specId, proposal.value, "adapter-generated");
  if (!stored.ok) {
    return stored;
  }
  return {
    ok: true,
    value: {
      ...stored.value,
      tool: profileResult.profile.tool,
      proposal_path: confinedOut.value.relativePath,
      source: "adapter-generated",
      apply_command: `hivemind plan ${specId} --propose ${confinedOut.value.relativePath}`
    }
  };
}

export async function prepareWorkspaceTentativePlan(
  repoRoot: string,
  prompt: string,
  tool: string
): Promise<SpecResult<WorkspacePreparedPlanResult>> {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt === "") {
    return { ok: false, reason: "planning prompt must not be empty" };
  }
  if (prompt.length > 20_000) {
    return { ok: false, reason: "planning prompt must be a non-empty string of at most 20000 characters" };
  }
  const activeSpec = await requireActiveSpecRatified(repoRoot);
  if (!activeSpec.ok) return activeSpec;

  const usageSessionId = randomUUID();
  const proposalPath = path.join(
    repoRoot,
    ".hivemind",
    "resource",
    "planning",
    `${usageSessionId}.proposal.json`
  );
  const generated = await generateTentativePlanWithSession(
    repoRoot,
    activeSpec.value.spec_id,
    tool,
    proposalPath,
    normalizedPrompt,
    usageSessionId
  );
  if (!generated.ok) return generated;

  const grounded = await groundTentativePlan(repoRoot, activeSpec.value.spec_id);
  if (!grounded.ok) return grounded;
  const linted = await lintTentativePlan(repoRoot, activeSpec.value.spec_id);
  if (!linted.ok) return linted;
  const reviewed = await reviewPlanForRatification(repoRoot, activeSpec.value.spec_id);
  if (!reviewed.ok) return reviewed;
  const autonomy = await readProjectAutonomyLevel(repoRoot);
  if (!autonomy.ok) return autonomy;

  const recorded = await appendEvent(repoRoot, {
    type: "plan.prepared",
    task_id: null,
    data: {
      version: 1,
      spec_id: reviewed.value.spec_id,
      plan_hash: reviewed.value.plan_hash,
      plan_path: reviewed.value.plan_path,
      proposal_path: generated.value.proposal_path,
      usage_session_id: usageSessionId,
      tool,
      prompt: normalizedPrompt,
      prompt_hash: createHash("sha256").update(normalizedPrompt).digest("hex"),
      autonomy_level: autonomy.value,
      status: "awaiting_ratification",
      authorization_effect: "none"
    }
  });
  if (!recorded.ok) return recorded;

  if (autonomy.value === "auto") {
    const ratified = await ratifyPlanWithSource(repoRoot, reviewed.value.spec_id, reviewed.value.plan_hash, "autonomy_policy", autonomy.value);
    if (!ratified.ok) return ratified;
    const decision = await recordAutonomyDecision(repoRoot, {
      level: autonomy.value,
      session_id: usageSessionId,
      decision: "plan_ratification",
      action_type: "plan.ratify",
      interruption: "suppressed",
      authorization_source: "autonomy_policy",
      result: "authorized",
      reason: "Auto suppresses the plan interruption after the existing exact-hash ratification primitive succeeds."
    });
    if (!decision.ok) return decision;
  } else {
    const decision = await recordAutonomyDecision(repoRoot, {
      level: autonomy.value,
      session_id: usageSessionId,
      decision: "plan_ratification",
      action_type: "plan.ratify",
      interruption: "required",
      authorization_source: "human",
      result: "paused",
      reason: `${autonomy.value} requires exact-hash human plan ratification before execution.`
    });
    if (!decision.ok) return decision;
  }

  return {
    ok: true,
    value: {
      spec_id: reviewed.value.spec_id,
      plan_hash: reviewed.value.plan_hash,
      plan_path: reviewed.value.plan_path,
      proposal_path: generated.value.proposal_path,
      usage_session_id: usageSessionId,
      task_count: reviewed.value.task_count,
      lint_status: "passed",
      status: autonomy.value === "auto" ? "ratified_by_policy" : "awaiting_ratification",
      autonomy_level: autonomy.value
    }
  };
}

export async function readRatifiedWorkspacePlanSession(
  repoRoot: string,
  specId: string
): Promise<SpecResult<{ session_id: string }>> {
  const reviewed = await reviewPlanForRatification(repoRoot, specId);
  if (!reviewed.ok) return reviewed;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const ratified = [...events.value].reverse().find((event) =>
    event.type === "plan.ratified" &&
    event.data.spec_id === specId &&
    event.data.plan_hash === reviewed.value.plan_hash
  );
  if (ratified === undefined) {
    return { ok: false, reason: "workspace execution requires exact-hash ratification of the prepared plan" };
  }
  const prepared = [...events.value].reverse().find((event) =>
    event.type === "plan.prepared" &&
    event.data.spec_id === specId &&
    event.data.plan_hash === reviewed.value.plan_hash &&
    event.data.plan_path === reviewed.value.plan_path
  );
  if (prepared === undefined) {
    return { ok: false, reason: "workspace execution requires a durable prepared-plan record" };
  }
  const sessionId = prepared.data.usage_session_id;
  if (typeof sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) {
    return { ok: false, reason: "workspace execution refused: prepared-plan session identity is invalid" };
  }
  return { ok: true, value: { session_id: sessionId } };
}

function parsePlanArgs(
  cwd: string,
  args: string[]
): SpecResult<
  | { action: "check"; specId: string }
  | { action: "propose"; specId: string; planFile: string }
  | { action: "generate"; specId: string; tool: string; outPath: string; steering?: string }
  | { action: "ground"; specId: string }
  | { action: "lint"; specId: string }
  | { action: "review"; specId: string }
  | { action: "ratify"; specId: string; expectedHash: string }
  | { action: "thrash"; specId: string; taskId: string; budget?: number }
> {
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
  if (flag === "--generate") {
    const optionArgs = value === undefined ? rest : [value, ...rest];
    const toolIndex = optionArgs.indexOf("--tool");
    const outIndex = optionArgs.indexOf("--out");
    const steerIndex = optionArgs.indexOf("--steer");
    const tool = toolIndex >= 0 ? optionArgs[toolIndex + 1] : undefined;
    const outPath = outIndex >= 0 ? optionArgs[outIndex + 1] : undefined;
    const steering = steerIndex >= 0 ? optionArgs[steerIndex + 1] : undefined;
    const expectedLength = steering === undefined ? 4 : 6;
    if (tool && outPath && optionArgs.length === expectedLength && (steerIndex < 0 || steering !== undefined)) {
      return { ok: true, value: { action: "generate", specId, tool, outPath: path.resolve(cwd, outPath), ...(steering === undefined ? {} : { steering }) } };
    }
  }
  if (flag === "--ground" && value === undefined && rest.length === 0) {
    return { ok: true, value: { action: "ground", specId } };
  }
  if (flag === "--lint" && value === undefined && rest.length === 0) {
    return { ok: true, value: { action: "lint", specId } };
  }
  if (flag === "--review" && value === undefined && rest.length === 0) {
    return { ok: true, value: { action: "review", specId } };
  }
  if (flag === "--ratify" && typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && rest.length === 0) {
    return { ok: true, value: { action: "ratify", specId, expectedHash: value } };
  }
  if (flag === "--thrash" && typeof value === "string") {
    const taskIdResult = validateRequestedTaskId(value);
    if (!taskIdResult.ok) {
      return taskIdResult;
    }
    if (rest.length === 0) {
      return { ok: true, value: { action: "thrash", specId, taskId: value } };
    }
    if (rest.length === 2 && rest[0] === "--budget" && /^\d+$/.test(rest[1])) {
      const budget = Number(rest[1]);
      if (!Number.isSafeInteger(budget) || budget < 1) {
        return { ok: false, reason: "re-plan budget must be a positive integer" };
      }
      return { ok: true, value: { action: "thrash", specId, taskId: value, budget } };
    }
  }
  return { ok: false, reason: planUsage() };
}

function planUsage(): string {
  return "usage: hivemind plan <spec-id> --check | --propose <plan-json-file> | --generate --tool <tool> --out <plan-json-file> [--steer <steering>] | --ground | --lint | --review | --ratify <reviewed-plan-hash> | --thrash <task-id> [--budget <n>]";
}

function parseGeneratedPlan(stdout: string): SpecResult<unknown> {
  const extracted = extractJsonObject(stdout, "planning generator");
  if (!extracted.ok) {
    return extracted;
  }
  try {
    return { ok: true, value: JSON.parse(extracted.value) as unknown };
  } catch {
    return { ok: false, reason: "planning generator did not return valid JSON" };
  }
}

function confineOutputPath(repoRoot: string, outPath: string, label: string): SpecResult<{ absolutePath: string; relativePath: string }> {
  const absolutePath = path.resolve(outPath);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, reason: `${label} output path must stay inside the repository` };
  }
  if (relativePath.split(path.sep).includes(".git")) {
    return { ok: false, reason: `${label} output path must not be inside .git` };
  }
  return { ok: true, value: { absolutePath, relativePath: relativePath.replace(/\\/g, "/") } };
}

export async function evaluatePlanThrash(
  repoRoot: string,
  specId: string,
  taskId: string,
  budget?: number
): Promise<SpecResult<ReplanEvaluationResult>> {
  const allowed = await checkPlanningAllowed(repoRoot, specId);
  if (!allowed.ok) {
    return allowed;
  }
  const loaded = await loadTentativePlan(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }
  return evaluateThrashForPlan(repoRoot, loaded.value, taskId, budget);
}

async function routeThrashEvaluation(
  repoRoot: string,
  specId: string,
  taskId: string,
  budget?: number
): Promise<SpecResult<ReplanEvaluationResult>> {
  const daemonResult = await callDaemonIfConfigured<ReplanEvaluationResult>(repoRoot, "/plan/thrash", {
    spec_id: specId,
    task_id: taskId,
    ...(budget === undefined ? {} : { budget })
  });
  return daemonResult.routed ? (daemonResult.ok ? { ok: true, value: daemonResult.value } : { ok: false, reason: daemonResult.reason }) : evaluatePlanThrash(repoRoot, specId, taskId, budget);
}

export async function groundTentativePlan(repoRoot: string, specId: string): Promise<SpecResult<GroundPlanResult>> {
  const allowed = await checkPlanningAllowed(repoRoot, specId);
  if (!allowed.ok) {
    return allowed;
  }

  const loaded = await loadTentativePlan(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }

  const head = await currentHead(repoRoot);
  if (!head.ok) {
    return head;
  }
  if (loaded.value.base_commit !== head.value) {
    return {
      ok: false,
      reason: `tentative plan base ${loaded.value.base_commit} is stale relative to current HEAD ${head.value}; re-propose the plan before grounding`
    };
  }

  const tracked = await trackedFilesAtBase(repoRoot, loaded.value.base_commit);
  if (!tracked.ok) {
    return tracked;
  }

  const checkedAt = new Date().toISOString();
  const groundedTasks: TentativePlanTask[] = [];
  for (const task of loaded.value.tasks) {
    const grounded = await groundTaskScope(repoRoot, task, tracked.value, loaded.value.base_commit, checkedAt);
    if (!grounded.ok) {
      return grounded;
    }
    groundedTasks.push(grounded.value);
  }

  const groundedPlan: TentativePlan = {
    ...loaded.value,
    grounding_status: "grounded",
    grounded_at: checkedAt,
    grounded_base_commit: loaded.value.base_commit,
    tasks: groundedTasks
  };

  await writeJsonAtomic(tentativePlanPath(repoRoot, specId), groundedPlan);
  return {
    ok: true,
    value: {
      spec_id: specId,
      plan_path: tentativePlanRelativePath(specId),
      status: "tentative",
      grounding_status: "grounded",
      base_commit: loaded.value.base_commit,
      task_count: groundedPlan.tasks.length
    }
  };
}

export async function lintTentativePlan(repoRoot: string, specId: string): Promise<SpecResult<PlanLintResult>> {
  const allowed = await checkPlanningAllowed(repoRoot, specId);
  if (!allowed.ok) {
    return allowed;
  }

  const loaded = await loadTentativePlan(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }

  const head = await currentHead(repoRoot);
  if (!head.ok) {
    return head;
  }

  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }

  const lintResult = runPlanLintRules(loaded.value, head.value, config.config.critical_globs ?? []);
  if (!lintResult.ok) {
    return lintResult;
  }

  const lintedPlan: TentativePlan = {
    ...loaded.value,
    lint_status: "passed",
    linted_at: new Date().toISOString(),
    linted_base_commit: loaded.value.base_commit
  };
  await writeJsonAtomic(tentativePlanPath(repoRoot, specId), lintedPlan);

  return {
    ok: true,
    value: {
      spec_id: specId,
      plan_path: tentativePlanRelativePath(specId),
      status: "tentative",
      lint_status: "passed",
      base_commit: loaded.value.base_commit,
      task_count: loaded.value.tasks.length,
      rule_count: planLintRuleCount
    }
  };
}

export async function requireContractFromLintedPlan(
  repoRoot: string,
  specId: string,
  contract: TaskContract
): Promise<SpecResult<void>> {
  const planResult = await loadCurrentRatifiedPlan(repoRoot, specId, "contract creation");
  if (!planResult.ok) {
    return planResult;
  }
  const plan = planResult.value;
  const task = plan.tasks.find((entry) => entry.task_id === contract.task_id);
  if (task === undefined) {
    return { ok: false, reason: `contract task ${contract.task_id} is not present in the active ratified plan` };
  }
  if (task.grounded_scope === undefined) {
    return { ok: false, reason: `contract task ${contract.task_id} is not grounded in lint-passed plan` };
  }
  const mismatches = contractPlanMismatches(contract, task, plan);
  if (mismatches.length > 0) {
    return { ok: false, reason: `contract does not match lint-passed plan task ${contract.task_id}: ${mismatches.join("; ")}` };
  }
  const dependencyResult = await requireTaskDependenciesIntegrated(repoRoot, specId, contract.task_id);
  if (!dependencyResult.ok) {
    return dependencyResult;
  }
  return { ok: true, value: undefined };
}

export async function requireTaskDependenciesIntegrated(
  repoRoot: string,
  specId: string,
  taskId: string
): Promise<SpecResult<void>> {
  const planResult = await loadCurrentRatifiedPlan(repoRoot, specId, `task ${taskId} dependency check`);
  if (!planResult.ok) {
    const tentative = await loadTentativePlan(repoRoot, specId);
    if (tentative.ok) {
      return planResult;
    }
    // Absent is a plan state; unreadable is not. Anything that is not
    // definitively "no plan" refuses, so a wording change cannot turn an
    // unreadable plan into a missing one.
    if (!hasFailureCode(tentative, "tentative_plan_not_found")) {
      return { ok: false, reason: `task ${taskId} dependency check refused because plan state is unreadable: ${tentative.reason}` };
    }
    return requireManualTaskAuthorized(repoRoot, specId, taskId);
  }
  const task = planResult.value.tasks.find((entry) => entry.task_id === taskId);
  if (task === undefined) {
    return { ok: false, reason: `task ${taskId} is not present in the active ratified plan` };
  }
  if (task.depends_on.length === 0) {
    return { ok: true, value: undefined };
  }

  const eventsResult = await readEvents(repoRoot);
  if (!eventsResult.ok) {
    return eventsResult;
  }
  const integrated = integratedTaskIdsFromEvents(eventsResult.value);
  const missing = task.depends_on.filter((dependency) => !integrated.has(dependency));
  if (missing.length > 0) {
    return { ok: false, reason: `task ${taskId} depends_on not integrated: ${missing.join(", ")}` };
  }

  return { ok: true, value: undefined };
}

export async function reviewManualTaskForAuthorization(
  repoRoot: string,
  specId: string,
  taskId: string
): Promise<SpecResult<ManualTaskAuthorizationReview>> {
  const spec = validateRequestedSpecId(specId);
  if (!spec.ok) return spec;
  const task = validateRequestedTaskId(taskId);
  if (!task.ok) return task;
  const planning = await checkPlanningAllowed(repoRoot, specId);
  if (!planning.ok) return planning;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  if (events.value.some((event) => event.type === "plan.ratified" && event.data.spec_id === specId)) {
    return { ok: false, reason: `manual task authorization refused: ${specId} already has a ratified plan` };
  }
  const tentative = await loadTentativePlan(repoRoot, specId);
  if (tentative.ok) {
    return { ok: false, reason: `manual task authorization refused: ${specId} has a tentative plan; ratify that exact plan instead` };
  }
  if (!hasFailureCode(tentative, "tentative_plan_not_found")) {
    return { ok: false, reason: `manual task authorization refused because plan state is unreadable: ${tentative.reason}` };
  }
  return readManualTaskContractHash(repoRoot, specId, taskId);
}

export async function authorizeManualTask(
  repoRoot: string,
  specId: string,
  taskId: string,
  expectedContractHash: string
): Promise<SpecResult<ManualTaskAuthorizationReview>> {
  if (!/^[a-f0-9]{64}$/u.test(expectedContractHash)) {
    return { ok: false, reason: "manual task authorization requires the exact 64-character contract hash shown by review" };
  }
  const reviewed = await reviewManualTaskForAuthorization(repoRoot, specId, taskId);
  if (!reviewed.ok) return reviewed;
  if (reviewed.value.contract_hash !== expectedContractHash) {
    return {
      ok: false,
      reason: `manual task contract changed after review: expected ${expectedContractHash}, current hash is ${reviewed.value.contract_hash}`
    };
  }
  const appended = await appendEvent(repoRoot, {
    type: "manual_task.authorized",
    task_id: taskId,
    data: {
      version: 1,
      spec_id: specId,
      contract_hash: expectedContractHash,
      contract_path: reviewed.value.contract_path,
      confirmation: "exact_contract_hash"
    }
  });
  return appended.ok ? reviewed : appended;
}

async function requireManualTaskAuthorized(repoRoot: string, specId: string, taskId: string): Promise<SpecResult<void>> {
  const current = await readManualTaskContractHash(repoRoot, specId, taskId);
  if (!current.ok) return current;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const authorization = events.value.filter((event) =>
    event.type === "manual_task.authorized" && event.task_id === taskId && event.data.spec_id === specId
  ).at(-1);
  if (
    authorization === undefined ||
    authorization.data.contract_hash !== current.value.contract_hash ||
    authorization.data.contract_path !== current.value.contract_path ||
    authorization.data.confirmation !== "exact_contract_hash"
  ) {
    return { ok: false, reason: `task ${taskId} has no plan and requires explicit authorization of its exact contract hash` };
  }
  return { ok: true, value: undefined };
}

async function readManualTaskContractHash(
  repoRoot: string,
  specId: string,
  taskId: string
): Promise<SpecResult<ManualTaskAuthorizationReview>> {
  const relativePath = `.hivemind/tasks/${taskId}.contract.json`;
  let contents: string;
  let raw: unknown;
  try {
    contents = await readFile(path.join(repoRoot, relativePath), "utf8");
    raw = JSON.parse(contents.replace(/^\uFEFF/u, ""));
  } catch (error: unknown) {
    return { ok: false, reason: `manual task authorization refused: ${relativePath} is missing or unreadable` };
  }
  if (!isRecord(raw) || raw.task_id !== taskId) {
    return { ok: false, reason: `manual task authorization refused: ${relativePath} does not declare ${taskId}` };
  }
  return {
    ok: true,
    value: {
      spec_id: specId,
      task_id: taskId,
      contract_hash: createHash("sha256").update(contents).digest("hex"),
      contract_path: relativePath
    }
  };
}

async function loadCurrentLintedPlan(repoRoot: string, specId: string, action: string): Promise<SpecResult<TentativePlan>> {
  const loaded = await loadTentativePlan(repoRoot, specId);
  if (!loaded.ok) {
    return { ok: false, reason: `${action} requires a lint-passed tentative plan: ${loaded.reason}` };
  }
  const head = await currentHead(repoRoot);
  if (!head.ok) {
    return head;
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }
  const plan = loaded.value;
  if (plan.lint_status !== "passed" || plan.linted_base_commit !== plan.base_commit || plan.linted_at === undefined) {
    return codedFailure("plan_not_currently_lint_passed", `${action} requires a current lint-passed tentative plan`);
  }
  const lintResult = runPlanLintRules(plan, head.value, config.config.critical_globs ?? []);
  if (!lintResult.ok) {
    return lintResult;
  }
  return { ok: true, value: plan };
}

export async function reviewPlanForRatification(
  repoRoot: string,
  specId: string
): Promise<SpecResult<PlanRatificationResult>> {
  const plan = await loadCurrentLintedPlan(repoRoot, specId, "plan ratification review");
  if (!plan.ok) {
    return plan;
  }
  const planHash = hashPlan(plan.value);
  return {
    ok: true,
    value: {
      spec_id: specId,
      plan_hash: planHash,
      plan_path: tentativePlanRelativePath(specId),
      task_count: plan.value.tasks.length,
      plan: plan.value
    }
  };
}

export async function ratifyPlan(
  repoRoot: string,
  specId: string,
  expectedHash: string
): Promise<SpecResult<PlanRatificationResult>> {
  const autonomy = await readProjectAutonomyLevel(repoRoot);
  if (!autonomy.ok) return autonomy;
  return ratifyPlanWithSource(repoRoot, specId, expectedHash, "human", autonomy.value);
}

async function ratifyPlanWithSource(
  repoRoot: string,
  specId: string,
  expectedHash: string,
  authorizationSource: "human" | "autonomy_policy",
  autonomyLevel: AutonomyLevel
): Promise<SpecResult<PlanRatificationResult>> {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
    return { ok: false, reason: "plan ratification requires the exact 64-character hash shown by --review" };
  }
  const reviewed = await reviewPlanForRatification(repoRoot, specId);
  if (!reviewed.ok) {
    return reviewed;
  }
  if (reviewed.value.plan_hash !== expectedHash) {
    return {
      ok: false,
      reason: `plan changed after review: expected ${expectedHash}, current hash is ${reviewed.value.plan_hash}`
    };
  }
  const plan = await loadCurrentLintedPlan(repoRoot, specId, "plan ratification");
  if (!plan.ok) {
    return plan;
  }
  const relativePath = ratifiedPlanRelativePath(specId, expectedHash);
  const absolutePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, `${JSON.stringify(plan.value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
    const existing = await readFile(absolutePath, "utf8");
    if (hashPlan(JSON.parse(existing) as TentativePlan) !== expectedHash) {
      return { ok: false, reason: `immutable ratified plan artifact conflicts at ${relativePath}` };
    }
  }
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const alreadyRecorded = events.value.some((event) =>
    event.type === "plan.ratified" &&
    event.data.spec_id === specId &&
    event.data.plan_hash === expectedHash &&
    event.data.plan_path === relativePath
  );
  if (!alreadyRecorded) {
    const event = await appendEvent(repoRoot, {
      type: "plan.ratified",
      task_id: null,
      data: {
        version: 1,
        spec_id: specId,
        plan_hash: expectedHash,
        plan_path: relativePath,
        base_commit: plan.value.base_commit,
        task_count: plan.value.tasks.length,
        confirmation: "exact_plan_hash",
        authorization_source: authorizationSource,
        autonomy_level: autonomyLevel
      }
    });
    if (!event.ok) {
      return event;
    }
  }
  return {
    ok: true,
    value: {
      spec_id: specId,
      plan_hash: expectedHash,
      plan_path: relativePath,
      task_count: plan.value.tasks.length,
      plan: plan.value
    }
  };
}

export async function loadCurrentRatifiedPlan(
  repoRoot: string,
  specId: string,
  action = "operation"
): Promise<SpecResult<TentativePlan>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const ratification = events.value.filter((event) =>
    event.type === "plan.ratified" && event.data.spec_id === specId
  ).at(-1);
  if (ratification === undefined) {
    return { ok: false, reason: `${action} requires an explicitly ratified plan` };
  }
  const planPath = ratification.data.plan_path;
  const planHash = ratification.data.plan_hash;
  return loadRatifiedPlanByIdentity(repoRoot, specId, planPath, planHash, action);
}

export async function loadRatifiedPlanByIdentity(
  repoRoot: string,
  specId: string,
  planPath: unknown,
  planHash: unknown,
  action = "operation"
): Promise<SpecResult<TentativePlan>> {
  if (
    typeof planPath !== "string" ||
    typeof planHash !== "string" ||
    planPath !== ratifiedPlanRelativePath(specId, planHash)
  ) {
    return { ok: false, reason: `${action} refused: durable plan ratification metadata is invalid` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(repoRoot, planPath), "utf8"));
  } catch {
    return { ok: false, reason: `${action} refused: ratified plan artifact is missing or unreadable` };
  }
  const validated = validateStoredTentativePlan(raw, specId);
  if (!validated.ok) {
    return { ok: false, reason: `${action} refused: ratified plan artifact is invalid: ${validated.reason}` };
  }
  if (hashPlan(validated.value) !== planHash) {
    return { ok: false, reason: `${action} refused: ratified plan artifact hash does not match durable ratification` };
  }
  return validated;
}

export async function queuePlanAmendment(
  repoRoot: string,
  specId: string,
  request: unknown
): Promise<SpecResult<PlanAmendmentResult>> {
  if (!isRecord(request)) {
    return { ok: false, reason: "plan amendment must be a JSON object" };
  }
  const allowed = new Set(["kind", "task", "execution_group"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `plan amendment contains unsupported field: ${extra[0]}` };
  }
  if (request.kind !== "add_task" && request.kind !== "edit_task") {
    return { ok: false, reason: "plan amendment kind must be add_task or edit_task" };
  }
  if (!isRecord(request.task) || typeof request.task.task_id !== "string") {
    return { ok: false, reason: "plan amendment task must be a task object with task_id" };
  }
  const taskId = validateRequestedTaskId(request.task.task_id);
  if (!taskId.ok) {
    return taskId;
  }
  const taskIdValue = request.task.task_id;
  const plan = await loadCurrentRatifiedPlan(repoRoot, specId, "plan amendment");
  if (!plan.ok) {
    return plan;
  }
  const existingIndex = plan.value.tasks.findIndex((task) => task.task_id === taskIdValue);
  if (request.kind === "add_task" && existingIndex >= 0) {
    return { ok: false, reason: `add-only amendment refused: task ${taskIdValue} already exists` };
  }
  if (request.kind === "edit_task" && existingIndex < 0) {
    return { ok: false, reason: `task edit refused: task ${taskIdValue} is not in the active ratified plan` };
  }
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  if (request.kind === "edit_task" && latestTaskRunState(events.value, taskIdValue).state !== "not_started") {
    return { ok: false, reason: `task edit refused: ${taskIdValue} has started and its contract is immutable; redirect or cancel and re-plan` };
  }

  const tasks: Array<Record<string, unknown>> = plan.value.tasks.map(toPlanInputTask);
  if (existingIndex >= 0) {
    tasks[existingIndex] = request.task;
  } else {
    tasks.push(request.task);
  }
  const groups = plan.value.execution_groups.map((group) => ({ ...group, task_ids: [...group.task_ids] }));
  if (request.kind === "add_task") {
    if (!isRecord(request.execution_group) || typeof request.execution_group.group_id !== "string") {
      return { ok: false, reason: "add_task amendment requires an execution_group with group_id and mode" };
    }
    const amendmentGroup = request.execution_group;
    const groupId = amendmentGroup.group_id as string;
    const group = groups.find((entry) => entry.group_id === groupId);
    if (group === undefined) {
      if (request.execution_group.mode !== "parallel" && request.execution_group.mode !== "sequence") {
        return { ok: false, reason: "new amendment execution_group mode must be parallel or sequence" };
      }
      groups.push({ group_id: groupId, mode: request.execution_group.mode, task_ids: [taskIdValue] });
    } else {
      group.task_ids.push(taskIdValue);
    }
  }
  const parsed = await parseTentativePlanInput(
    repoRoot,
    specId,
    { tasks, execution_groups: groups },
    new Set(plan.value.tasks.map((task) => task.task_id))
  );
  if (!parsed.ok) {
    return { ok: false, reason: `plan amendment refused: ${parsed.reason}` };
  }
  const amendmentId = `A-${randomUUID()}`;
  const appended = await appendEvent(repoRoot, {
    type: "plan.amendment_queued",
    task_id: taskIdValue,
    data: {
      version: 1,
      amendment_id: amendmentId,
      spec_id: specId,
      kind: request.kind,
      task: parsed.value.tasks.find((task) => task.task_id === taskIdValue) as TentativePlanTask,
      execution_groups: parsed.value.execution_groups,
      base_plan_hash: hashPlan(plan.value),
      status: "queued",
      authoritative_effect: "none_until_replanned_and_ratified"
    }
  });
  return appended.ok
    ? { ok: true, value: { amendment_id: amendmentId, spec_id: specId, kind: request.kind, task_id: taskIdValue, status: "queued" } }
    : appended;
}

function hashPlan(plan: TentativePlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function toPlanInputTask(task: TentativePlanTask): Record<string, unknown> {
  return {
    task_id: task.task_id,
    title: task.title,
    task_type: task.task_type,
    routing_task_type: task.routing_task_type,
    mode: task.mode,
    agent_role: task.agent_role,
    draft_scope: task.draft_scope,
    depends_on: task.depends_on,
    parallel_safe: task.parallel_safe,
    acceptance_criterion: task.acceptance_criterion,
    ...(task.deterministic_validity_check === undefined ? {} : { deterministic_validity_check: task.deterministic_validity_check }),
    required_tests: task.required_tests,
    patch_requirements: task.patch_requirements,
    critical_path_approved: task.critical_path_approved
  };
}

function ratifiedPlanRelativePath(specId: string, planHash: string): string {
  return `.hivemind/plans/ratified/${specId}/${planHash}.json`;
}

export async function resolveContractFilesAtBase(
  repoRoot: string,
  taskId: string,
  baseCommit: string,
  files: string[],
  label: DraftScopePathField,
  allowedFileIntents?: Record<string, AllowedFileIntent>
): Promise<SpecResult<string[]>> {
  const tracked = await trackedFilesAtBase(repoRoot, baseCommit);
  if (!tracked.ok) {
    return tracked;
  }
  if (label === "allowed_files") {
    return resolveContractAllowedFilesAtBase(repoRoot, taskId, files, tracked.value, allowedFileIntents);
  }
  return resolveScopeEntries(taskId, label, files, tracked.value, { allowGlobs: false });
}

export async function loadTentativePlan(repoRoot: string, specId: string): Promise<SpecResult<TentativePlan>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(tentativePlanPath(repoRoot, specId), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      // Callers distinguish "no plan yet" from "the plan is broken", so this
      // carries a code. It used to be recoverable only by matching this
      // sentence, in five places across four modules.
      return codedFailure("tentative_plan_not_found", `tentative plan not found: ${tentativePlanRelativePath(specId)}`);
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${tentativePlanRelativePath(specId)}` };
    }
    throw error;
  }

  return validateStoredTentativePlan(raw, specId);
}

function validateStoredTentativePlan(raw: unknown, specId: string): SpecResult<TentativePlan> {
  if (!isRecord(raw)) {
    return { ok: false, reason: "tentative plan must be a JSON object" };
  }
  const allowedKeys = new Set([
    "version",
    "spec_id",
    "status",
    "base_commit",
    "source",
    "created_at",
    "grounding_status",
    "grounded_at",
    "grounded_base_commit",
    "lint_status",
    "linted_at",
    "linted_base_commit",
    "tasks",
    "execution_groups"
  ]);
  // Version before the field set, not after. A plan from a newer build carries
  // fields this build has never heard of, so the closed-world check would
  // report "unsupported field: x" -- which reads as a malformed plan rather
  // than as a format this build cannot read.
  const gated = checkFormatVersion(raw, formatVersions.tentativePlan, "the tentative plan");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  const extra = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `tentative plan contains unsupported field: ${extra[0]}` };
  }
  if (raw.spec_id !== specId) {
    return { ok: false, reason: `tentative plan spec_id must be ${specId}` };
  }
  if (raw.status !== "tentative") {
    return { ok: false, reason: "tentative plan status must be tentative" };
  }
  if (typeof raw.base_commit !== "string" || raw.base_commit.trim() === "") {
    return { ok: false, reason: "tentative plan base_commit must be a non-empty string" };
  }
  if (!isTentativePlanSource(raw.source)) {
    return { ok: false, reason: "tentative plan source must be cli-json or adapter-generated" };
  }
  if (typeof raw.created_at !== "string" || raw.created_at.trim() === "") {
    return { ok: false, reason: "tentative plan created_at must be a non-empty string" };
  }
  if (raw.grounding_status !== undefined && raw.grounding_status !== "grounded") {
    return { ok: false, reason: "tentative plan grounding_status must be grounded when present" };
  }
  if (raw.grounding_status === "grounded" && raw.grounded_at === undefined) {
    return { ok: false, reason: "tentative plan grounded_at must be present when grounding_status is grounded" };
  }
  if (raw.grounding_status === "grounded" && raw.grounded_base_commit === undefined) {
    return { ok: false, reason: "tentative plan grounded_base_commit must be present when grounding_status is grounded" };
  }
  if (raw.grounding_status === undefined && raw.grounded_at !== undefined) {
    return { ok: false, reason: "tentative plan grounded_at requires top-level grounding_status" };
  }
  if (raw.grounding_status === undefined && raw.grounded_base_commit !== undefined) {
    return { ok: false, reason: "tentative plan grounded_base_commit requires top-level grounding_status" };
  }
  if (raw.grounded_at !== undefined && (typeof raw.grounded_at !== "string" || raw.grounded_at.trim() === "")) {
    return { ok: false, reason: "tentative plan grounded_at must be a non-empty string when present" };
  }
  if (raw.grounded_base_commit !== undefined && (typeof raw.grounded_base_commit !== "string" || raw.grounded_base_commit.trim() === "")) {
    return { ok: false, reason: "tentative plan grounded_base_commit must be a non-empty string when present" };
  }
  if (raw.lint_status !== undefined && raw.lint_status !== "passed") {
    return { ok: false, reason: "tentative plan lint_status must be passed when present" };
  }
  if (raw.lint_status === "passed" && raw.linted_at === undefined) {
    return { ok: false, reason: "tentative plan linted_at must be present when lint_status is passed" };
  }
  if (raw.lint_status === "passed" && raw.linted_base_commit === undefined) {
    return { ok: false, reason: "tentative plan linted_base_commit must be present when lint_status is passed" };
  }
  if (raw.lint_status === undefined && raw.linted_at !== undefined) {
    return { ok: false, reason: "tentative plan linted_at requires lint_status" };
  }
  if (raw.lint_status === undefined && raw.linted_base_commit !== undefined) {
    return { ok: false, reason: "tentative plan linted_base_commit requires lint_status" };
  }
  if (raw.linted_at !== undefined && (typeof raw.linted_at !== "string" || raw.linted_at.trim() === "")) {
    return { ok: false, reason: "tentative plan linted_at must be a non-empty string when present" };
  }
  if (raw.linted_base_commit !== undefined && (typeof raw.linted_base_commit !== "string" || raw.linted_base_commit.trim() === "")) {
    return { ok: false, reason: "tentative plan linted_base_commit must be a non-empty string when present" };
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return { ok: false, reason: "tentative plan tasks must be a non-empty array" };
  }
  if (!Array.isArray(raw.execution_groups) || raw.execution_groups.length === 0) {
    return { ok: false, reason: "tentative plan execution_groups must be a non-empty array" };
  }

  const tasks: TentativePlanTask[] = [];
  const taskIds = new Set<string>();
  for (const [index, entry] of raw.tasks.entries()) {
    const task = validateStoredTask(index, entry);
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
    if (raw.grounding_status === "grounded" && task.scope_status !== "grounded") {
      return { ok: false, reason: `tasks[${index}].scope_status must be grounded when top-level grounding_status is grounded` };
    }
    if (raw.grounding_status === undefined && task.scope_status === "grounded") {
      return { ok: false, reason: `tasks[${index}].grounded tasks require top-level grounding_status` };
    }
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

  return {
    ok: true,
    value: {
      version: 1,
      spec_id: specId,
      status: "tentative",
      base_commit: raw.base_commit,
      source: raw.source,
      created_at: raw.created_at,
      ...(raw.grounding_status === undefined ? {} : { grounding_status: "grounded" }),
      ...(raw.grounded_at === undefined ? {} : { grounded_at: raw.grounded_at }),
      ...(raw.grounded_base_commit === undefined ? {} : { grounded_base_commit: raw.grounded_base_commit }),
      ...(raw.lint_status === undefined ? {} : { lint_status: "passed" }),
      ...(raw.linted_at === undefined ? {} : { linted_at: raw.linted_at }),
      ...(raw.linted_base_commit === undefined ? {} : { linted_base_commit: raw.linted_base_commit }),
      tasks,
      execution_groups: executionGroups
    }
  };
}

function validateStoredTask(index: number, raw: unknown): SpecResult<TentativePlanTask> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `tasks[${index}] must be a JSON object` };
  }
  const allowedKeys = new Set([
      "task_id",
      "title",
      "task_type",
      "routing_task_type",
      "mode",
      "agent_role",
    "draft_scope",
    "depends_on",
      "parallel_safe",
      "acceptance_criterion",
      "deterministic_validity_check",
      "required_tests",
    "patch_requirements",
    "critical_path_approved",
    "scope_status",
    "grounding_evidence",
    "grounded_scope"
  ]);
  const extra = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    return { ok: false, reason: `tasks[${index}] contains unsupported field: ${extra[0]}` };
  }
  if (raw.scope_status !== "draft_ungrounded" && raw.scope_status !== "grounded") {
    return { ok: false, reason: `tasks[${index}].scope_status must be draft_ungrounded or grounded` };
  }
  const base = parseStoredTaskBase(index, raw);
  if (!base.ok) {
    return base;
  }
  if (raw.scope_status === "grounded") {
    const evidence = parseGroundingEvidence(index, raw.grounding_evidence);
    if (!evidence.ok) {
      return evidence;
    }
    if (!isRecord(raw.grounded_scope)) {
      return { ok: false, reason: `tasks[${index}].grounded_scope must be a JSON object when scope_status is grounded` };
    }
    const groundedScope = parseDraftScope(index, raw.grounded_scope);
    if (!groundedScope.ok) {
      return groundedScope;
    }
    return {
      ok: true,
      value: {
        ...base.value,
        scope_status: "grounded",
        grounding_evidence: evidence.value,
        grounded_scope: groundedScope.value
      }
    };
  }
  if (raw.grounding_evidence !== undefined || raw.grounded_scope !== undefined) {
    return { ok: false, reason: `tasks[${index}] must not include grounding fields while scope_status is draft_ungrounded` };
  }
  return { ok: true, value: { ...base.value, scope_status: "draft_ungrounded" } };
}

function parseStoredTaskBase(index: number, raw: Record<string, unknown>): SpecResult<Omit<TentativePlanTask, "scope_status" | "grounding_evidence" | "grounded_scope">> {
  if (typeof raw.task_id !== "string") {
    return { ok: false, reason: `tasks[${index}].task_id is required` };
  }
  const taskIdResult = validateRequestedTaskId(raw.task_id);
  if (!taskIdResult.ok) {
    return { ok: false, reason: `tasks[${index}].${taskIdResult.reason}` };
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    return { ok: false, reason: `tasks[${index}].title must be a non-empty string` };
  }
  const taskType = parseTaskType(index, raw.task_type);
  if (!taskType.ok) {
    return taskType;
  }
  const routingTaskType = parseRoutingTaskType(index, raw.routing_task_type);
  if (!routingTaskType.ok) {
    return routingTaskType;
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
  const deterministicValidityCheck = parseOptionalNonEmptyString(index, "deterministic_validity_check", raw.deterministic_validity_check);
  if (!deterministicValidityCheck.ok) {
    return deterministicValidityCheck;
  }
  const requiredTests = parseStringArray(`tasks[${index}].required_tests`, raw.required_tests);
  if (!requiredTests.ok) {
    return requiredTests;
  }
  const patchRequirements = parseStringArray(`tasks[${index}].patch_requirements`, raw.patch_requirements);
  if (!patchRequirements.ok) {
    return patchRequirements;
  }
  if (raw.critical_path_approved !== undefined && typeof raw.critical_path_approved !== "boolean") {
    return { ok: false, reason: `tasks[${index}].critical_path_approved must be a boolean when present` };
  }
  return {
    ok: true,
    value: {
      task_id: raw.task_id,
      title: raw.title.trim(),
      task_type: taskType.value,
      routing_task_type: routingTaskType.value,
      mode: raw.mode,
      agent_role: raw.agent_role,
      draft_scope: draftScope.value,
      depends_on: dependsOn.value,
      parallel_safe: raw.parallel_safe,
      acceptance_criterion: raw.acceptance_criterion.trim(),
      ...(deterministicValidityCheck.value === undefined ? {} : { deterministic_validity_check: deterministicValidityCheck.value }),
      required_tests: requiredTests.value,
      patch_requirements: patchRequirements.value,
      critical_path_approved: raw.critical_path_approved ?? false
    }
  };
}

function parseGroundingEvidence(index: number, raw: unknown): SpecResult<GroundingEvidence> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `tasks[${index}].grounding_evidence must be a JSON object when scope_status is grounded` };
  }
  if (raw.source !== "git-tree") {
    return { ok: false, reason: `tasks[${index}].grounding_evidence.source must be git-tree` };
  }
  if (typeof raw.base_commit !== "string" || raw.base_commit.trim() === "") {
    return { ok: false, reason: `tasks[${index}].grounding_evidence.base_commit must be a non-empty string` };
  }
  if (typeof raw.checked_at !== "string" || raw.checked_at.trim() === "") {
    return { ok: false, reason: `tasks[${index}].grounding_evidence.checked_at must be a non-empty string` };
  }
  const citedPaths = parseStringArray(`tasks[${index}].grounding_evidence.cited_paths`, raw.cited_paths);
  if (!citedPaths.ok) {
    return citedPaths;
  }
  const resolvedFiles = parseStringArray(`tasks[${index}].grounding_evidence.resolved_files`, raw.resolved_files);
  if (!resolvedFiles.ok) {
    return resolvedFiles;
  }
  return {
    ok: true,
    value: {
      source: "git-tree",
      base_commit: raw.base_commit,
      checked_at: raw.checked_at,
      cited_paths: citedPaths.value,
      resolved_files: resolvedFiles.value
    }
  };
}

export async function trackedFilesAtBase(repoRoot: string, baseCommit: string): Promise<SpecResult<string[]>> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", baseCommit], { cwd: repoRoot, windowsHide: true });
    return { ok: true, value: uniqueSorted(stdout.split(/\r?\n/).map((entry) => normalizeGitPath(entry)).filter((entry) => entry !== "")) };
  } catch {
    return { ok: false, reason: `failed to list tracked files at base commit ${baseCommit}` };
  }
}

async function groundTaskScope(
  repoRoot: string,
  task: TentativePlanTask,
  trackedFiles: string[],
  baseCommit: string,
  checkedAt: string
): Promise<SpecResult<TentativePlanTask>> {
  const allowed = await resolveAllowedScopeEntries(repoRoot, task.task_id, task.draft_scope, trackedFiles);
  if (!allowed.ok) {
    return allowed;
  }
  const readOnly = resolveScopeEntries(task.task_id, "read_only_files", task.draft_scope.read_only_files, trackedFiles, { allowGlobs: true });
  if (!readOnly.ok) {
    return readOnly;
  }
  const forbidden = resolveScopeEntries(task.task_id, "forbidden_files", task.draft_scope.forbidden_files, trackedFiles, { allowGlobs: true });
  if (!forbidden.ok) {
    return forbidden;
  }

  const citedPaths = uniqueSorted([...task.draft_scope.allowed_files, ...task.draft_scope.read_only_files, ...task.draft_scope.forbidden_files]);
  const resolvedFiles = uniqueSorted([...allowed.value, ...readOnly.value, ...forbidden.value]);
  return {
    ok: true,
    value: {
      ...task,
      scope_status: "grounded",
      grounding_evidence: {
        source: "git-tree",
        base_commit: baseCommit,
        checked_at: checkedAt,
        cited_paths: citedPaths,
        resolved_files: resolvedFiles
      },
      grounded_scope: {
        allowed_files: allowed.value,
        ...(task.draft_scope.allowed_file_intents === undefined ? {} : { allowed_file_intents: task.draft_scope.allowed_file_intents }),
        read_only_files: readOnly.value,
        forbidden_files: forbidden.value,
        must_not_change: task.draft_scope.must_not_change
      }
    }
  };
}

async function resolveAllowedScopeEntries(
  repoRoot: string,
  taskId: string,
  scope: DraftScope,
  trackedFiles: string[]
): Promise<SpecResult<string[]>> {
  const resolved: string[] = [];
  const tracked = new Set(trackedFiles);
  for (const entry of scope.allowed_files) {
    const normalized = normalizeGitPath(entry);
    const problem = validateGroundingPathSyntax(taskId, "allowed_files", entry, normalized);
    if (problem !== null) {
      return { ok: false, reason: problem };
    }
    const intent = allowedFileIntent(scope, entry, normalized);
    if (hasGlob(normalized)) {
      const matches = trackedFiles.filter((file) => globMatches(normalized, file));
      if (intent === "create") {
        if (matches.length > 0) {
          return { ok: false, reason: `task ${taskId} allowed_files create glob "${entry}" matched tracked files at base: ${matches.join(", ")}` };
        }
        resolved.push(normalized);
        continue;
      }
      if (matches.length === 0) {
        return { ok: false, reason: `task ${taskId} allowed_files glob "${entry}" matched no tracked files at base` };
      }
      resolved.push(...matches);
      continue;
    }

    if (intent === "create") {
      const canonical = await canonicalizeIntentPath(repoRoot, normalized);
      if (!canonical.ok) {
        return { ok: false, reason: `task ${taskId} allowed_files create path "${entry}" is not confined to the repo: ${canonical.reason}` };
      }
      if (tracked.has(canonical.resolved)) {
        return { ok: false, reason: `task ${taskId} allowed_files create path "${entry}" already exists at base` };
      }
      resolved.push(canonical.resolved);
      continue;
    }

    if (!tracked.has(normalized)) {
      return { ok: false, reason: `task ${taskId} allowed_files path "${entry}" is not a tracked file at base` };
    }
    resolved.push(normalized);
  }
  return { ok: true, value: uniqueSorted(resolved) };
}

function resolveScopeEntries(
  taskId: string,
  field: DraftScopePathField,
  entries: string[],
  trackedFiles: string[],
  options: { allowGlobs: boolean }
): SpecResult<string[]> {
  const resolved: string[] = [];
  const tracked = new Set(trackedFiles);
  for (const entry of entries) {
    const normalized = normalizeGitPath(entry);
    const problem = validateGroundingPathSyntax(taskId, field, entry, normalized);
    if (problem !== null) {
      return { ok: false, reason: problem };
    }
    if (hasGlob(normalized)) {
      if (!options.allowGlobs) {
        return { ok: false, reason: `task ${taskId} ${field} path "${entry}" uses a glob; contract lease scopes must be concrete files` };
      }
      const matches = trackedFiles.filter((file) => globMatches(normalized, file));
      const protectedMatch = matches.find((file) => workerProtectedPathReason(file) !== null);
      if (protectedMatch !== undefined) {
        return {
          ok: false,
          reason: `task ${taskId} ${field} glob "${entry}" resolved protected path "${protectedMatch}"`
        };
      }
      if (matches.length === 0) {
        return { ok: false, reason: `task ${taskId} ${field} glob "${entry}" matched no tracked files at base` };
      }
      resolved.push(...matches);
      continue;
    }
    if (!tracked.has(normalized)) {
      return { ok: false, reason: `task ${taskId} ${field} path "${entry}" is not a tracked file at base` };
    }
    resolved.push(normalized);
  }
  return { ok: true, value: uniqueSorted(resolved) };
}

async function resolveContractAllowedFilesAtBase(
  repoRoot: string,
  taskId: string,
  files: string[],
  trackedFiles: string[],
  allowedFileIntents: Record<string, AllowedFileIntent> | undefined
): Promise<SpecResult<string[]>> {
  const resolved: string[] = [];
  const tracked = new Set(trackedFiles);
  const intents = normalizeAllowedFileIntents(files, allowedFileIntents);
  for (const entry of files) {
    const normalized = normalizeGitPath(entry);
    const problem = validateGroundingPathSyntax(taskId, "allowed_files", entry, normalized);
    if (problem !== null) {
      return { ok: false, reason: problem };
    }
    if (hasGlob(normalized)) {
      return { ok: false, reason: `task ${taskId} allowed_files path "${entry}" uses a glob; contract lease scopes must be concrete files` };
    }
    const intent = allowedFileIntent({ allowed_files: files, allowed_file_intents: intents, read_only_files: [], forbidden_files: [], must_not_change: [] }, entry, normalized);
    if (intent === "create") {
      const canonical = await canonicalizeIntentPath(repoRoot, normalized);
      if (!canonical.ok) {
        return { ok: false, reason: `task ${taskId} allowed_files create path "${entry}" is not confined to the repo: ${canonical.reason}` };
      }
      if (tracked.has(canonical.resolved)) {
        return { ok: false, reason: `task ${taskId} allowed_files create path "${entry}" already exists at base` };
      }
      resolved.push(canonical.resolved);
      continue;
    }
    if (!tracked.has(normalized)) {
      return { ok: false, reason: `task ${taskId} allowed_files path "${entry}" is not a tracked file at base` };
    }
    resolved.push(normalized);
  }
  return { ok: true, value: uniqueSorted(resolved) };
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/u, "").trim();
}

function validateGroundingPathSyntax(
  taskId: string,
  field: DraftScopePathField,
  original: string,
  normalized: string
): string | null {
  if (normalized === "" || normalized.startsWith("/") || normalized.includes("..")) {
    return `task ${taskId} ${field} contains invalid path "${original}"`;
  }
  if (/[\[\]]/u.test(normalized)) {
    return `task ${taskId} ${field} path "${original}" uses unsupported bracket glob syntax`;
  }
  if (normalized.split("/").includes(".git")) {
    return `task ${taskId} ${field} contains invalid path "${original}"`;
  }
  const protectedReason = field === "allowed_files"
    ? workerProtectedScopeReason(normalized)
    : workerProtectedPathReason(normalized);
  if (protectedReason !== null) {
    return `task ${taskId} ${field} contains protected path "${original}": ${protectedReason}`;
  }
  return null;
}

function allowedFileIntent(scope: DraftScope, original: string, normalized: string): AllowedFileIntent {
  const intents = scope.allowed_file_intents;
  if (intents === undefined) {
    return "modify";
  }
  const values = [intents[original], intents[normalized]].filter((value): value is AllowedFileIntent => value === "create" || value === "modify");
  return values.length > 0 && values.every((value) => value === "create") ? "create" : "modify";
}

function hasGlob(value: string): boolean {
  return /[*?]/u.test(value);
}

function globMatches(pattern: string, file: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|\\]/gu, "\\$&");
  const regex = escaped.replace(/\*\*/gu, "\u0000").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]").replace(/\u0000/gu, ".*");
  return new RegExp(`^${regex}$`, "u").test(file);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const planLintRuleCount = 8;

function runPlanLintRules(plan: TentativePlan, head: string, criticalGlobs: string[]): SpecResult<void> {
  const rules: Array<() => SpecResult<void>> = [
    () => lintGroundingRequired(plan),
    () => lintGroundingFreshness(plan, head),
    () => lintParallelSafety(plan),
    () => lintParallelScopeOverlap(plan),
    () => lintDependencyCycle(plan),
    () => lintCriticalApproval(plan, criticalGlobs),
    () => lintRightSizingAcceptance(plan),
    () => lintSkeletonTrapAcceptance(plan)
  ];

  for (const rule of rules) {
    const result = rule();
    if (!result.ok) {
      return { ok: false, reason: `plan-lint failed: ${result.reason}` };
    }
  }
  return { ok: true, value: undefined };
}

function contractPlanMismatches(contract: TaskContract, task: TentativePlanTask, plan: TentativePlan): string[] {
  const mismatches: string[] = [];
  const scope = task.grounded_scope;
  if (scope === undefined) {
    return ["grounded_scope is missing"];
  }
  if (contract.base_commit !== plan.base_commit) {
    mismatches.push(`base_commit ${contract.base_commit} does not match plan base ${plan.base_commit}`);
  }
  if (contract.title !== task.title) {
    mismatches.push("title does not match plan task");
  }
  if (contract.agent_role !== task.agent_role) {
    mismatches.push("agent_role does not match plan task");
  }
  if (contract.routing_task_type !== task.routing_task_type) {
    mismatches.push("routing_task_type does not match plan task");
  }
  if (contract.acceptance_criterion !== task.acceptance_criterion) {
    mismatches.push("acceptance_criterion does not match plan task");
  }
  if (contract.deterministic_validity_check !== task.deterministic_validity_check) {
    mismatches.push("deterministic_validity_check does not match plan task");
  }
  if (!sameArray(contract.allowed_files, scope.allowed_files)) {
    mismatches.push("allowed_files do not match grounded plan scope");
  }
  if (!sameIntentMap(contract.allowed_file_intents, normalizeAllowedFileIntents(scope.allowed_files, scope.allowed_file_intents))) {
    mismatches.push("allowed_file_intents do not match grounded plan scope");
  }
  if (!sameArray(contract.read_only_files, scope.read_only_files)) {
    mismatches.push("read_only_files do not match grounded plan scope");
  }
  if (!sameArray(contract.forbidden_files, scope.forbidden_files)) {
    mismatches.push("forbidden_files do not match grounded plan scope");
  }
  if (!sameArray(contract.must_not_change, scope.must_not_change)) {
    mismatches.push("must_not_change does not match plan task");
  }
  if (!sameArray(contract.required_tests, task.required_tests)) {
    mismatches.push("required_tests do not match plan task");
  }
  if (!sameArray(contract.patch_requirements, task.patch_requirements)) {
    mismatches.push("patch_requirements do not match plan task");
  }
  if (contract.allowed_symbols.length > 0 || contract.forbidden_symbols.length > 0) {
    mismatches.push("symbol scopes are not produced by lint-passed plans yet");
  }
  return mismatches;
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameIntentMap(left: Record<string, AllowedFileIntent>, right: Record<string, AllowedFileIntent>): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => rightEntries[index][0] === key && rightEntries[index][1] === value);
}

function lintGroundingRequired(plan: TentativePlan): SpecResult<void> {
  if (plan.grounding_status !== "grounded") {
    return { ok: false, reason: "GROUNDING_REQUIRED: tentative plan must be grounded before lint" };
  }
  if (plan.grounded_base_commit === undefined || plan.grounded_at === undefined) {
    return { ok: false, reason: "GROUNDING_REQUIRED: tentative plan is missing top-level grounding metadata" };
  }
  for (const task of plan.tasks) {
    if (task.scope_status !== "grounded" || task.grounding_evidence === undefined || task.grounded_scope === undefined) {
      return { ok: false, reason: `GROUNDING_REQUIRED: task ${task.task_id} is not grounded` };
    }
  }
  return { ok: true, value: undefined };
}

function lintGroundingFreshness(plan: TentativePlan, head: string): SpecResult<void> {
  if (plan.base_commit !== head) {
    return { ok: false, reason: `GROUNDING_FRESHNESS: tentative plan base ${plan.base_commit} is stale relative to current HEAD ${head}` };
  }
  if (plan.grounded_base_commit !== plan.base_commit) {
    return { ok: false, reason: `GROUNDING_FRESHNESS: grounded_base_commit ${plan.grounded_base_commit ?? "<missing>"} does not match plan base ${plan.base_commit}` };
  }
  for (const task of plan.tasks) {
    if (task.grounding_evidence?.base_commit !== plan.base_commit) {
      return { ok: false, reason: `GROUNDING_FRESHNESS: task ${task.task_id} grounding evidence is not derived from plan base ${plan.base_commit}` };
    }
  }
  return { ok: true, value: undefined };
}

function lintParallelSafety(plan: TentativePlan): SpecResult<void> {
  const tasksById = new Map(plan.tasks.map((task) => [task.task_id, task]));
  for (const group of plan.execution_groups) {
    if (group.mode !== "parallel") continue;
    for (const taskId of group.task_ids) {
      const task = tasksById.get(taskId);
      if (task !== undefined && !task.parallel_safe) {
        return {
          ok: false,
          reason: `PARALLEL_SAFETY_REQUIRED: group ${group.group_id} task ${taskId} is not marked parallel_safe`
        };
      }
    }
  }
  return { ok: true, value: undefined };
}

function lintParallelScopeOverlap(plan: TentativePlan): SpecResult<void> {
  const tasksById = new Map(plan.tasks.map((task) => [task.task_id, task]));
  for (const group of plan.execution_groups) {
    if (group.mode !== "parallel") {
      continue;
    }
    const owners = new Map<string, string>();
    for (const taskId of group.task_ids) {
      const task = tasksById.get(taskId);
      if (task === undefined) {
        continue;
      }
      for (const file of task.grounded_scope?.allowed_files ?? []) {
        const existing = owners.get(file);
        if (existing !== undefined) {
          return {
            ok: false,
            reason: `PARALLEL_SCOPE_OVERLAP: group ${group.group_id} tasks ${existing} and ${task.task_id} both allow ${file}`
          };
        }
        owners.set(file, task.task_id);
      }
    }
  }
  return { ok: true, value: undefined };
}

function lintDependencyCycle(plan: TentativePlan): SpecResult<void> {
  const tasksById = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  function visit(taskId: string): SpecResult<void> {
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(cycleStart), taskId].join(" -> ");
      return { ok: false, reason: `DEPENDENCY_CYCLE: ${cycle}` };
    }
    if (visited.has(taskId)) {
      return { ok: true, value: undefined };
    }
    const task = tasksById.get(taskId);
    if (task === undefined) {
      return { ok: false, reason: `DEPENDENCY_CYCLE: unknown dependency ${taskId}` };
    }
    visiting.add(taskId);
    stack.push(taskId);
    for (const dependency of task.depends_on) {
      const result = visit(dependency);
      if (!result.ok) {
        return result;
      }
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return { ok: true, value: undefined };
  }

  for (const task of plan.tasks) {
    const result = visit(task.task_id);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, value: undefined };
}

function lintCriticalApproval(plan: TentativePlan, criticalGlobs: string[]): SpecResult<void> {
  if (criticalGlobs.length === 0) {
    return { ok: true, value: undefined };
  }
  for (const task of plan.tasks) {
    const grounded = task.grounded_scope;
    if (grounded === undefined) {
      return { ok: false, reason: `GROUNDING_REQUIRED: task ${task.task_id} is not grounded` };
    }
    const criticalFile = [...grounded.allowed_files, ...grounded.read_only_files, ...grounded.forbidden_files].find((file) => matchesAny(file, criticalGlobs));
    if (criticalFile !== undefined && task.critical_path_approved !== true) {
      return { ok: false, reason: `CRITICAL_APPROVAL_REQUIRED: task ${task.task_id} touches Critical path ${criticalFile} without critical_path_approved` };
    }
  }
  return { ok: true, value: undefined };
}

function lintRightSizingAcceptance(plan: TentativePlan): SpecResult<void> {
  for (const task of plan.tasks) {
    if (task.acceptance_criterion.trim() === "") {
      return { ok: false, reason: `RIGHT_SIZING_ACCEPTANCE: task ${task.task_id} acceptance_criterion must be non-empty` };
    }
    if (task.required_tests.filter((entry) => entry.trim() !== "").length === 0) {
      return { ok: false, reason: `RIGHT_SIZING_ACCEPTANCE: task ${task.task_id} required_tests must include at least one non-empty command` };
    }
  }
  return { ok: true, value: undefined };
}

function lintSkeletonTrapAcceptance(plan: TentativePlan): SpecResult<void> {
  for (const task of plan.tasks) {
    const observableInterface = observableInterfaceKind(task.acceptance_criterion);
    if (observableInterface !== null && task.deterministic_validity_check === undefined) {
      return {
        ok: false,
        reason: `SKELETON_TRAP_ACCEPTANCE: task ${task.task_id} names an observable ${observableInterface} but has no deterministic_validity_check`
      };
    }
    if (observableInterface !== null && task.deterministic_validity_check !== undefined) {
      const validityProblem = observableValidityCheckProblem(task.deterministic_validity_check, task.required_tests);
      if (validityProblem !== null) {
        return { ok: false, reason: `SKELETON_TRAP_ACCEPTANCE: task ${task.task_id} ${validityProblem}` };
      }
    }
    if (task.task_type !== "generative") {
      continue;
    }
    if (task.deterministic_validity_check !== undefined) {
      continue;
    }
    if (!isBehavioralAcceptanceCriterion(task.acceptance_criterion)) {
      return {
        ok: false,
        reason: `SKELETON_TRAP_ACCEPTANCE: task ${task.task_id} is generative and requires a BEHAVIORAL human-judged acceptance_criterion or deterministic_validity_check`
      };
    }
  }
  return { ok: true, value: undefined };
}

function isBehavioralAcceptanceCriterion(criterion: string): boolean {
  const normalized = criterion.toLowerCase();
  return (
    normalized.includes("behavioral") ||
    normalized.includes("human-judged") ||
    normalized.includes("human judged") ||
    normalized.includes("human reads") ||
    normalized.includes("human confirms") ||
    normalized.includes("human review")
  );
}

async function parseTentativePlanInput(
  repoRoot: string,
  specId: string,
  raw: unknown,
  allowExistingTaskIds: ReadonlySet<string> = new Set()
): Promise<SpecResult<TentativePlanInput>> {
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
    const task = await parseTentativeTask(repoRoot, index, entry, allowExistingTaskIds);
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

async function parseTentativeTask(
  repoRoot: string,
  index: number,
  raw: unknown,
  allowExistingTaskIds: ReadonlySet<string>
): Promise<SpecResult<TentativePlanInputTask>> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `tasks[${index}] must be a JSON object` };
  }
  const allowedKeys = new Set([
      "task_id",
      "title",
      "task_type",
      "routing_task_type",
      "mode",
      "agent_role",
    "draft_scope",
    "depends_on",
      "parallel_safe",
      "acceptance_criterion",
      "deterministic_validity_check",
      "required_tests",
    "patch_requirements",
    "critical_path_approved"
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
  if (!allowExistingTaskIds.has(raw.task_id) && await exists(path.join(repoRoot, ".hivemind", "tasks", `${raw.task_id}.contract.json`))) {
    return { ok: false, reason: `tasks[${index}].task_id collides with existing contract: .hivemind/tasks/${raw.task_id}.contract.json` };
  }

  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    return { ok: false, reason: `tasks[${index}].title must be a non-empty string` };
  }
  const taskType = parseTaskType(index, raw.task_type);
  if (!taskType.ok) {
    return taskType;
  }
  const routingTaskType = parseRoutingTaskType(index, raw.routing_task_type);
  if (!routingTaskType.ok) {
    return routingTaskType;
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
  const deterministicValidityCheck = parseOptionalNonEmptyString(index, "deterministic_validity_check", raw.deterministic_validity_check);
  if (!deterministicValidityCheck.ok) {
    return deterministicValidityCheck;
  }
  const requiredTests = parseStringArray(`tasks[${index}].required_tests`, raw.required_tests);
  if (!requiredTests.ok) {
    return requiredTests;
  }
  const patchRequirements = parseStringArray(`tasks[${index}].patch_requirements`, raw.patch_requirements);
  if (!patchRequirements.ok) {
    return patchRequirements;
  }
  if (raw.critical_path_approved !== undefined && typeof raw.critical_path_approved !== "boolean") {
    return { ok: false, reason: `tasks[${index}].critical_path_approved must be a boolean when present` };
  }

  return {
    ok: true,
    value: {
      task_id: raw.task_id,
      title: raw.title.trim(),
      task_type: taskType.value,
      routing_task_type: routingTaskType.value,
      mode: raw.mode,
      agent_role: raw.agent_role,
      draft_scope: draftScope.value,
      depends_on: dependsOn.value,
      parallel_safe: raw.parallel_safe,
      acceptance_criterion: raw.acceptance_criterion.trim(),
      ...(deterministicValidityCheck.value === undefined ? {} : { deterministic_validity_check: deterministicValidityCheck.value }),
      required_tests: requiredTests.value,
      patch_requirements: patchRequirements.value,
      critical_path_approved: raw.critical_path_approved ?? false
    }
  };
}

function parseDraftScope(index: number, raw: Record<string, unknown>): SpecResult<DraftScope> {
  const allowedKeys = new Set(["allowed_files", "allowed_file_intents", "read_only_files", "forbidden_files", "must_not_change"]);
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
  const allowedFileIntents = parseAllowedFileIntents(index, allowedFiles.value, raw.allowed_file_intents);
  if (!allowedFileIntents.ok) {
    return allowedFileIntents;
  }
  return {
    ok: true,
    value: {
      allowed_files: allowedFiles.value,
      ...(allowedFileIntents.value === undefined ? {} : { allowed_file_intents: allowedFileIntents.value }),
      read_only_files: readOnlyFiles.value,
      forbidden_files: forbiddenFiles.value,
      must_not_change: mustNotChange.value
    }
  };
}

function parseAllowedFileIntents(
  index: number,
  allowedFiles: string[],
  raw: unknown
): SpecResult<Record<string, AllowedFileIntent> | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return { ok: true, value: Object.fromEntries(allowedFiles.map((entry) => [normalizeGitPath(entry), "modify" as const])) };
  }
  const allowedLookup = new Set(allowedFiles.flatMap((entry) => [entry, normalizeGitPath(entry)]));
  const intents: Record<string, AllowedFileIntent> = {};
  for (const entry of allowedFiles) {
    const normalized = normalizeGitPath(entry);
    const rawValues = [raw[entry], raw[normalized]];
    const validValues = rawValues.filter((value): value is AllowedFileIntent => value === "create" || value === "modify");
    intents[normalized] = validValues.length > 0 && validValues.every((value) => value === "create") ? "create" : "modify";
  }
  for (const key of Object.keys(raw)) {
    if (!allowedLookup.has(key)) {
      return { ok: false, reason: `tasks[${index}].draft_scope.allowed_file_intents contains unknown allowed_files entry: ${key}` };
    }
  }
  return { ok: true, value: intents };
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

export async function currentHead(repoRoot: string): Promise<SpecResult<string>> {
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

function parseTaskType(index: number, value: unknown): SpecResult<TentativeTaskType> {
  if (value === undefined) {
    return { ok: true, value: "deterministic" };
  }
  if (value === "generative" || value === "deterministic") {
    return { ok: true, value };
  }
  return { ok: false, reason: `tasks[${index}].task_type must be generative or deterministic` };
}

function parseRoutingTaskType(index: number, value: unknown): SpecResult<RoutingTaskType> {
  if (isRoutingTaskType(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    reason: `tasks[${index}].routing_task_type must be one of: ${routingTaskTypeExpectation()}`
  };
}

function parseOptionalNonEmptyString(index: number, field: string, value: unknown): SpecResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: `tasks[${index}].${field} must be a non-empty string when present` };
  }
  return { ok: true, value: value.trim() };
}

function isExecutionGroupMode(value: unknown): value is ExecutionGroupMode {
  return value === "parallel" || value === "sequence";
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === "coordinator" || value === "scout" || value === "builder" || value === "reviewer";
}

function isTentativePlanSource(value: unknown): value is TentativePlanSource {
  return value === "cli-json" || value === "adapter-generated";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
