import { isRecord } from "./json.js";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents } from "./events.js";
import { readPromotedValueQualityPolicy } from "./learned-routing.js";
import { findGitRoot } from "./repo.js";
import { checkTokenBudgetPreflight } from "./resource-ledger.js";
import { inferTaskTier, routeTaskProvider, type RouteDecision, type TaskTier } from "./routing.js";
import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";
import { validateTaskId } from "./task-id.js";

export type ValueQualityStrategy = "best_of_n" | "draft_refine";

export interface ValueQualityAdmission {
  version: 1;
  quality_run_id: string;
  task_id: string;
  strategy: ValueQualityStrategy;
  draft_count: number | null;
  task_tier: TaskTier;
  routing_task_type: RoutingTaskType;
  policy_status: "not_required" | "active";
  promoted_policy_applied: boolean;
  policy_canon_id: string | null;
  policy_source_evidence_hash: string | null;
  policy_source_event_count: number | null;
  reason: string;
}

export interface ValueQualityCallAuthorization {
  quality_run_id: string;
  task_id: string;
  route: RouteDecision;
}

export interface AdmittedValueQualityRun {
  quality_run_id: string;
  task_id: string;
  strategy: ValueQualityStrategy;
  draft_count: number | null;
  task_tier: TaskTier;
  routing_task_type: RoutingTaskType;
}

interface AdmissionRequest {
  strategy: ValueQualityStrategy;
  n?: number;
}

interface AdmissionEvaluation {
  admitted: boolean;
  taskTier: TaskTier;
  routingTaskType: RoutingTaskType;
  policyStatus: "not_required" | "active" | "absent" | "stale" | "invalid" | "empty" | "not_error_prone";
  promotedPolicyApplied: boolean;
  policyCanonId: string | null;
  policySourceEvidenceHash: string | null;
  policySourceEventCount: number | null;
  reason: string;
}

export async function admitValueQuality(
  repoRoot: string,
  taskId: string,
  request: unknown
): Promise<{ ok: true; value: ValueQualityAdmission } | { ok: false; reason: string }> {
  const parsed = parseAdmissionRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const contract = await loadAndValidateContract(repoRoot, taskId);
  if (!contract.ok) {
    return contract;
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }
  const evaluation = await evaluateAdmission(repoRoot, contract.contract.routing_task_type, inferTaskTier(contract.contract, config.config));
  const qualityRunId = `Q-${taskId}-${randomUUID()}`;
  const draftCount = parsed.value.strategy === "best_of_n" ? parsed.value.n ?? 2 : null;
  const eventData = {
    version: 1,
    quality_run_id: qualityRunId,
    strategy: parsed.value.strategy,
    draft_count: draftCount,
    admitted: evaluation.admitted,
    reason: evaluation.reason,
    task_tier: evaluation.taskTier,
    routing_task_type: evaluation.routingTaskType,
    policy_status: evaluation.policyStatus,
    promoted_policy_applied: evaluation.promotedPolicyApplied,
    policy_canon_id: evaluation.policyCanonId,
    policy_source_evidence_hash: evaluation.policySourceEvidenceHash,
    policy_source_event_count: evaluation.policySourceEventCount
  };
  const appended = await appendEvent(repoRoot, {
    type: "quality.admission_decided",
    task_id: taskId,
    data: eventData
  });
  if (!appended.ok) {
    return appended;
  }
  if (!evaluation.admitted) {
    return { ok: false, reason: evaluation.reason };
  }
  return {
    ok: true,
    value: {
      version: 1,
      quality_run_id: qualityRunId,
      task_id: taskId,
      strategy: parsed.value.strategy,
      draft_count: draftCount,
      task_tier: evaluation.taskTier,
      routing_task_type: evaluation.routingTaskType,
      policy_status: "active" === evaluation.policyStatus ? "active" : "not_required",
      promoted_policy_applied: evaluation.promotedPolicyApplied,
      policy_canon_id: evaluation.policyCanonId,
      policy_source_evidence_hash: evaluation.policySourceEvidenceHash,
      policy_source_event_count: evaluation.policySourceEventCount,
      reason: evaluation.reason
    }
  };
}

export async function authorizeValueQualityCall(
  repoRoot: string,
  qualityRunId: string,
  options: {
    requestedTool?: string;
    estimatedInputTokens?: number;
    routingPreference?: "default" | "cheapest" | "strongest";
  } = {}
): Promise<{ ok: true; value: ValueQualityCallAuthorization } | { ok: false; reason: string }> {
  const admitted = await loadAdmittedValueQualityRun(repoRoot, qualityRunId);
  if (!admitted.ok) {
    return admitted;
  }
  const taskId = admitted.value.task_id;
  const contract = await loadAndValidateContract(repoRoot, taskId);
  if (!contract.ok) {
    return contract;
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }
  const evaluation = await evaluateAdmission(repoRoot, contract.contract.routing_task_type, inferTaskTier(contract.contract, config.config));
  if (!evaluation.admitted) {
    return { ok: false, reason: `quality call refused because current admission policy no longer permits ${taskId}: ${evaluation.reason}` };
  }
  const route = await routeTaskProvider(
    repoRoot,
    contract.contract,
    config.config,
    options.requestedTool,
    { preference: options.routingPreference ?? "default" }
  );
  if (!route.ok) {
    return route;
  }
  const estimatedInputTokens = options.estimatedInputTokens ?? 0;
  const budget = await checkTokenBudgetPreflight(repoRoot, route.value.tool, qualityRunId, estimatedInputTokens);
  if (!budget.ok) {
    return { ok: false, reason: budget.reason };
  }
  return {
    ok: true,
    value: {
      quality_run_id: qualityRunId,
      task_id: taskId,
      route: route.value
    }
  };
}

export async function loadAdmittedValueQualityRun(
  repoRoot: string,
  qualityRunId: string
): Promise<{ ok: true; value: AdmittedValueQualityRun } | { ok: false; reason: string }> {
  const parsedId = parseQualityRunId(qualityRunId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const eventResult = await readEvents(repoRoot);
  if (!eventResult.ok) {
    return eventResult;
  }
  if (eventResult.value.some((event) =>
    (event.type === "quality.cancel_requested" || event.type === "quality.cancelled") &&
    event.data.quality_run_id === qualityRunId
  )) {
    return { ok: false, reason: `quality run is cancelled: ${qualityRunId}` };
  }
  const matches = eventResult.value.filter(
    (event) => event.type === "quality.admission_decided" && event.data.quality_run_id === qualityRunId
  );
  if (matches.length !== 1 || !isValidAdmittedDecision(matches[0].task_id, matches[0].data)) {
    return { ok: false, reason: `quality run is not backed by exactly one admitted durable decision: ${qualityRunId}` };
  }
  const event = matches[0];
  if (event.task_id !== parsedId.taskId) {
    return { ok: false, reason: `quality_run_id task identity ${parsedId.taskId} does not match admitted task ${event.task_id}` };
  }
  return {
    ok: true,
    value: {
      quality_run_id: qualityRunId,
      task_id: event.task_id,
      strategy: event.data.strategy as ValueQualityStrategy,
      draft_count: event.data.draft_count as number | null,
      task_tier: event.data.task_tier as TaskTier,
      routing_task_type: event.data.routing_task_type as RoutingTaskType
    }
  };
}

export async function valueQualityCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }
  const routed = await callDaemonIfConfigured<ValueQualityAdmission>(repoRoot, "/quality/admit", {
    task_id: parsed.value.taskId,
    strategy: parsed.value.request.strategy,
    ...(parsed.value.request.n === undefined ? {} : { n: parsed.value.request.n })
  });
  const result = routed.routed
    ? routed.ok
      ? { ok: true as const, value: routed.value }
      : { ok: false as const, reason: routed.reason }
    : await admitValueQuality(repoRoot, parsed.value.taskId, parsed.value.request);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function parseAdmissionRequest(value: unknown): { ok: true; value: AdmissionRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "value-quality admission request must be a JSON object" };
  }
  if (Object.keys(value).some((key) => key !== "strategy" && key !== "n")) {
    return { ok: false, reason: "value-quality admission request contains an unsupported field" };
  }
  if (value.strategy !== "best_of_n" && value.strategy !== "draft_refine") {
    return { ok: false, reason: "value-quality strategy must be best_of_n or draft_refine" };
  }
  if (value.strategy === "draft_refine") {
    return value.n === undefined
      ? { ok: true, value: { strategy: "draft_refine" } }
      : { ok: false, reason: "draft_refine admission does not accept n" };
  }
  if (value.n !== undefined && (!Number.isSafeInteger(value.n) || Number(value.n) < 2 || Number(value.n) > 3)) {
    return { ok: false, reason: "best_of_n draft count must be an integer from 2 through 3" };
  }
  return {
    ok: true,
    value: {
      strategy: "best_of_n",
      ...(value.n === undefined ? {} : { n: Number(value.n) })
    }
  };
}

async function evaluateAdmission(
  repoRoot: string,
  routingTaskType: RoutingTaskType,
  taskTier: TaskTier
): Promise<AdmissionEvaluation> {
  if (taskTier === "low") {
    return deniedEvaluation(taskTier, routingTaskType, "not_required", "Low-tier tasks are never admitted to value-quality spending");
  }
  if (taskTier === "high" || taskTier === "critical") {
    return {
      admitted: true,
      taskTier,
      routingTaskType,
      policyStatus: "not_required",
      promotedPolicyApplied: false,
      policyCanonId: null,
      policySourceEvidenceHash: null,
      policySourceEventCount: null,
      reason: `${taskTier} task tier is eligible for explicit value-quality spending`
    };
  }
  const promoted = await readPromotedValueQualityPolicy(repoRoot);
  if (promoted.promoted !== "active" || promoted.active_policy === null) {
    return deniedEvaluation(
      taskTier,
      routingTaskType,
      promoted.promoted,
      `Medium task is not admitted because ${promoted.reason ?? "no active human-promoted value-quality policy exists"}`
    );
  }
  if (promoted.active_policy.error_prone_routing_task_types.length === 0) {
    return deniedEvaluation(
      taskTier,
      routingTaskType,
      "empty",
      "Medium task is not admitted because the active value-quality policy names no error-prone routing task types",
      promoted
    );
  }
  if (!promoted.active_policy.error_prone_routing_task_types.includes(routingTaskType)) {
    return deniedEvaluation(
      taskTier,
      routingTaskType,
      "not_error_prone",
      `Medium task routing_task_type ${routingTaskType} is not marked error-prone by the active value-quality policy`,
      promoted
    );
  }
  return {
    admitted: true,
    taskTier,
    routingTaskType,
    policyStatus: "active",
    promotedPolicyApplied: true,
    policyCanonId: promoted.active_canon_id,
    policySourceEvidenceHash: promoted.active_policy.source_evidence_hash,
    policySourceEventCount: promoted.active_policy.source_event_count,
    reason: `Medium task routing_task_type ${routingTaskType} is marked error-prone by active human-promoted policy ${promoted.active_canon_id}`
  };
}

function deniedEvaluation(
  taskTier: TaskTier,
  routingTaskType: RoutingTaskType,
  policyStatus: AdmissionEvaluation["policyStatus"],
  reason: string,
  promoted?: Awaited<ReturnType<typeof readPromotedValueQualityPolicy>>
): AdmissionEvaluation {
  const activePolicy = promoted?.promoted === "active" ? promoted.active_policy : null;
  return {
    admitted: false,
    taskTier,
    routingTaskType,
    policyStatus,
    promotedPolicyApplied: activePolicy !== null,
    policyCanonId: activePolicy === null ? null : promoted?.active_canon_id ?? null,
    policySourceEvidenceHash: activePolicy?.source_evidence_hash ?? null,
    policySourceEventCount: activePolicy?.source_event_count ?? null,
    reason
  };
}

function parseCommandArgs(
  args: string[]
): { ok: true; value: { taskId: string; request: AdmissionRequest } } | { ok: false; reason: string } {
  if (args.length < 4 || args[0] !== "admit" || args[1].trim() === "" || args[2] !== "--strategy") {
    return { ok: false, reason: valueQualityUsage() };
  }
  const taskId = args[1];
  const strategy = args[3] === "best-of-n" ? "best_of_n" : args[3] === "draft-refine" ? "draft_refine" : args[3];
  if (args.length === 4) {
    const parsed = parseAdmissionRequest({ strategy });
    return parsed.ok ? { ok: true, value: { taskId, request: parsed.value } } : { ok: false, reason: parsed.reason };
  }
  if (args.length === 6 && args[4] === "--n" && /^\d+$/u.test(args[5])) {
    const parsed = parseAdmissionRequest({ strategy, n: Number(args[5]) });
    return parsed.ok ? { ok: true, value: { taskId, request: parsed.value } } : { ok: false, reason: parsed.reason };
  }
  return { ok: false, reason: valueQualityUsage() };
}

function valueQualityUsage(): string {
  return "usage: hivemind quality admit <task-id> --strategy best-of-n [--n 2|3] | draft-refine";
}

export function parseQualityRunId(value: string): { ok: true; taskId: string } | { ok: false; reason: string } {
  const match = value.match(/^Q-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  if (match === null || validateTaskId(match[1]) !== null) {
    return { ok: false, reason: "quality_run_id must use the Q-<task-id>-<uuid> format" };
  }
  return { ok: true, taskId: match[1] };
}

function isValidAdmittedDecision(taskId: string | null, data: Record<string, unknown>): boolean {
  if (
    taskId === null ||
    data.version !== 1 ||
    data.admitted !== true ||
    typeof data.quality_run_id !== "string" ||
    !parseQualityRunId(data.quality_run_id).ok ||
    (data.strategy !== "best_of_n" && data.strategy !== "draft_refine") ||
    typeof data.reason !== "string" ||
    data.reason.trim() === "" ||
    (data.task_tier !== "low" && data.task_tier !== "medium" && data.task_tier !== "high" && data.task_tier !== "critical") ||
    !isRoutingTaskType(data.routing_task_type) ||
    typeof data.promoted_policy_applied !== "boolean"
  ) {
    return false;
  }
  if (data.strategy === "best_of_n" && (!Number.isSafeInteger(data.draft_count) || Number(data.draft_count) < 2 || Number(data.draft_count) > 3)) {
    return false;
  }
  if (data.strategy === "draft_refine" && data.draft_count !== null) {
    return false;
  }
  return true;
}
