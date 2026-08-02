import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_AUTONOMY_LEVEL, isAutonomyLevel, type AutonomyLevel } from "./autonomy-level.js";
import { loadConfig, type HivemindConfig } from "./config.js";
import { readEvents, type HivemindEvent } from "./events.js";
import {
  inspectLatestManagerSession,
  inspectManagerSessionHistory,
  type ManagerWorkspaceSession
} from "./manager.js";
import { readCanonMemory, type CanonMemoryEntry } from "./memory-canon.js";
import { readMemoryProposal, type MemoryProposal } from "./memory-log.js";
import {
  loadCurrentRatifiedPlan,
  loadRatifiedPlanByIdentity,
  loadTentativePlan,
  reviewPlanForRatification,
  type PlanRatificationResult,
  type TentativePlan
} from "./plan.js";
import { readQuotaLedger, type QuotaLedger } from "./resource-ledger.js";
import { readPromotedRoutingPolicy } from "./learned-routing.js";
import { loadAdapterProfile } from "./adapter.js";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";
import { latestTaskRunState } from "./run-state.js";
import type { LearnedRoutingPolicy, RoutingProviderScorecard } from "./routing-policy-schema.js";
import type { ValueQualityPolicy } from "./value-quality-policy-schema.js";
import { inferAllowedFilesTier, type TaskTier } from "./routing.js";
import { readJsonFile } from "./json.js";
import { readActiveSpec } from "./spec.js";
import { getStatus, type HivemindStatus } from "./status.js";
import { inspectLatestAdoptionReadiness } from "./adoption.js";

export interface WorkspaceQueueItem {
  id: string;
  kind: "plan_review" | "manager_approval" | "verification_blocked" | "reverification_required" | "run_stalled" | "task_attention" | "quality_cancel_failed" | "memory_review" | "quality_review" | "plan_amendment" | "adoption_ready";
  title: string;
  detail: string;
  created_at: string;
  task_id: string | null;
  action: { type: string; payload: Record<string, unknown> } | null;
  change_set?: {
    verification_id: string;
    base_branch: string;
    task_ids: string[];
    changed_files: string[];
  };
}

export interface WorkspacePlanTask {
  task_id: string;
  title: string;
  tier: TaskTier;
  task_type: TentativePlan["tasks"][number]["task_type"];
  routing_task_type: TentativePlan["tasks"][number]["routing_task_type"];
  mode: string;
  agent_role: TentativePlan["tasks"][number]["agent_role"];
  scope: string[];
  allowed_file_intents: Record<string, string>;
  read_only_scope: string[];
  forbidden_scope: string[];
  must_not_change: string[];
  depends_on: string[];
  parallel_safe: boolean;
  acceptance_criterion: string;
  deterministic_validity_check: string | null;
  required_tests: string[];
  patch_requirements: string[];
  critical_path_approved: boolean;
}

export interface WorkspacePlanReview {
  spec_id: string;
  plan_hash: string;
  plan_path: string;
  base_commit: string;
  created_at: string;
  tasks: WorkspacePlanTask[];
  execution_groups: TentativePlan["execution_groups"];
}

export interface WorkspaceInspection {
  status: HivemindStatus;
  active_spec_id: string | null;
  manager_session: ManagerWorkspaceSession | null;
  autonomy: {
    configured_level: AutonomyLevel;
    run_levels: AutonomyLevel[];
  };
  plan_review: WorkspacePlanReview | null;
  current_plan: WorkspacePlanReview | null;
  integration_failure: {
    reason: string;
    task_ids: string[];
  } | null;
  needs_you: WorkspaceQueueItem[];
  later: WorkspaceQueueItem[];
  spend: {
    session_id: string | null;
    calls: number;
    effective_tokens: number;
    run_ceiling_tokens: number;
    session_ceiling_tokens: number;
    near_session_ceiling: boolean;
  };
  swarm: {
    characterizations: WorkspaceCharacterization[];
    warnings: string[];
  };
  memory: WorkspaceMemoryInspection;
  history: WorkspaceHistoryInspection;
}

export interface WorkspaceCharacterization {
  candidate_id: string;
  task_id: string;
  classification: "rejected" | "regression_signal" | "valid_characterization" | "indeterminate";
  reason: string;
  check_id: string;
  artifact_path: string;
  patch: string;
  base_outcome: "pass" | "fail" | "unknown";
  post_change_outcome: "pass" | "fail" | "unknown";
}

export interface WorkspaceMemoryProposal {
  proposal_id: string;
  proposed_at: string;
  title: string;
  lesson: string;
  evidence: string[];
  task_id: string | null;
  review_command: string;
}

export interface WorkspaceRoutingChange extends WorkspaceMemoryProposal {
  change_kind: "routing_weights" | "quality_eligibility";
  task_types: Array<{
    routing_task_type: string;
    providers: WorkspaceRoutingProvider[];
  }>;
  error_prone_task_types: string[];
}

export interface WorkspaceRoutingProvider {
  provider: string;
  weight: number;
  sample_count: number;
  request_count: number;
  accepted_count: number;
  integrated_count: number;
  failed_count: number;
  timeout_count: number;
  revision_count: number;
  merged_diff_bytes: number;
  effective_tokens: number;
  merged_diff_bytes_per_1k_tokens: number;
  handoff_safety_rate: number | null;
  cost_source: string;
  evidence: string[];
}

export interface WorkspaceCanonEntry {
  canon_id: string;
  approved_at: string;
  title: string;
  lesson: string;
  evidence: string[];
}

export interface WorkspaceMemoryInspection {
  pending_lessons: WorkspaceMemoryProposal[];
  routing_changes: WorkspaceRoutingChange[];
  draft_tests: WorkspaceCharacterization[];
  canon: WorkspaceCanonEntry[];
  active_routing: {
    status: "active" | "absent" | "stale" | "invalid";
    canon_id: string | null;
    reason: string | null;
    task_types: WorkspaceRoutingChange["task_types"];
  };
  warnings: string[];
}

export interface WorkspaceHistoryRun {
  session_id: string;
  spec_id: string;
  started_at: string;
  last_activity_at: string;
  duration_ms: number;
  outcome: "active" | "completed" | "needs_attention" | "paused";
  outcome_detail: string;
  verified_tasks: string[];
  merged_tasks: string[];
  stopped_tasks: Array<{ task_id: string; state: "failed" | "blocked" | "cancelled" | "paused"; reason: string }>;
  calls: number;
  effective_tokens: number;
  provider_reported_tokens: number;
  self_measured_tokens: number;
  evidence_paths: string[];
  autonomy_levels: AutonomyLevel[];
}

export interface WorkspaceHistoryInspection {
  runs: WorkspaceHistoryRun[];
  run_ceiling_tokens: number;
  session_ceiling_tokens: number;
  warnings: string[];
}

export const DEFAULT_RUN_STALL_INTERVAL_MS = 45_000;

export interface WorkspaceInspectionOptions {
  now?: Date;
  stallIntervalMs?: number;
  processLiveness?: (pid: number) => ProcessLiveness;
}

export async function inspectWorkspace(
  repoRoot: string,
  options: WorkspaceInspectionOptions = {}
): Promise<{ ok: true; value: WorkspaceInspection } | { ok: false; reason: string }> {
  const status = await getStatus(repoRoot);
  if (!status.ok) return status;
  const config = await loadConfig(repoRoot);
  if (!config.ok) return config;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const activeSpec = await readActiveSpec(repoRoot);
  if (!activeSpec.ok && !activeSpec.reason.startsWith("no active spec;")) return activeSpec;
  const specId = activeSpec.ok ? activeSpec.value.spec_id : null;
  const session = specId === null ? { ok: true as const, value: null } : await inspectLatestManagerSession(repoRoot, specId);
  if (!session.ok) return session;
  const currentSession = session.value;
  const currentRunLevels = currentSession === null
    ? []
    : runAutonomyLevels(events.value.filter((event) => event.ts >= currentSession.created_at), currentSession.autonomy_level);

  const planState = specId === null
    ? { ok: true as const, review: null, current: null }
    : await inspectPlans(repoRoot, specId, events.value, config.config);
  if (!planState.ok) return planState;
  const integrationFailure = buildIntegrationFailure(status.value, session.value);
  const queues = await buildQueues(
    repoRoot,
    events.value,
    planState.review,
    planState.current,
    session.value,
    integrationFailure,
    options
  );
  if (!queues.ok) return queues;
  const ledger = await readQuotaLedger(repoRoot);
  if (!ledger.ok) return ledger;
  const swarm = await inspectCharacterizations(repoRoot);
  const memory = await inspectMemory(repoRoot, events.value, swarm.characterizations);
  if (!memory.ok) return memory;
  const history = await inspectHistory(repoRoot, events.value, ledger.value, config.config);
  if (!history.ok) return history;
  const preparedPlanSession = planState.current === null
    ? null
    : latestPreparedPlanSession(events.value, planState.current);
  const sessionId = preparedPlanSession ?? session.value?.session_id ?? null;
  let calls = 0;
  let effectiveTokens = 0;
  if (sessionId !== null) {
    for (const entry of Object.values(ledger.value)) {
      const usage = entry.session_usage[sessionId];
      if (usage !== undefined && !entry.unmetered) {
        calls += usage.requests;
        effectiveTokens += usage.effective_tokens;
      }
    }
  }
  return {
    ok: true,
    value: {
      status: status.value,
      active_spec_id: specId,
      manager_session: session.value,
      autonomy: {
        configured_level: config.config.manager_autonomy?.level ?? DEFAULT_AUTONOMY_LEVEL,
        run_levels: currentRunLevels
      },
      plan_review: planState.review,
      current_plan: planState.current,
      integration_failure: integrationFailure,
      needs_you: queues.value.needsYou,
      later: queues.value.later,
      spend: {
        session_id: sessionId,
        calls,
        effective_tokens: effectiveTokens,
        run_ceiling_tokens: config.config.resource_policy?.run_ceiling?.tokens ?? 150_000,
        session_ceiling_tokens: config.config.resource_policy?.session_ceiling?.tokens ?? 500_000,
        near_session_ceiling: effectiveTokens >= (config.config.resource_policy?.session_ceiling?.tokens ?? 500_000) * 0.8
      },
      swarm,
      memory: memory.value,
      history: history.value
    }
  };
}

function latestPreparedPlanSession(
  events: HivemindEvent[],
  plan: WorkspacePlanReview
): string | null {
  const prepared = [...events].reverse().find((event) =>
    event.type === "plan.prepared" &&
    event.data.spec_id === plan.spec_id &&
    event.data.plan_hash === plan.plan_hash
  );
  return typeof prepared?.data.usage_session_id === "string"
    ? prepared.data.usage_session_id
    : null;
}

async function inspectCharacterizations(repoRoot: string): Promise<WorkspaceInspection["swarm"]> {
  const root = path.join(repoRoot, ".hivemind", "resource", "oracle-candidates");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { characterizations: [], warnings: [] }
      : { characterizations: [], warnings: ["Characterization evidence could not be read."] };
  }
  const characterizations: WorkspaceCharacterization[] = [];
  const warnings: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith(".")).sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const manifest = await readJsonFile(path.join(root, entry.name, "manifest.json"));
      const validation = await readJsonFile(path.join(root, entry.name, "validation.json"));
      if (!isRecord(manifest) || !isRecord(validation)) throw new Error("not an object");
      const classification = validation.classification;
      if (
        typeof manifest.candidate_id !== "string" ||
        typeof manifest.task_id !== "string" ||
        typeof manifest.check_id !== "string" ||
        typeof validation.reason !== "string" ||
        !["rejected", "regression_signal", "valid_characterization", "indeterminate"].includes(String(classification))
      ) {
        throw new Error("missing required fields");
      }
      characterizations.push({
        candidate_id: manifest.candidate_id,
        task_id: manifest.task_id,
        classification: classification as WorkspaceCharacterization["classification"],
        reason: validation.reason,
        check_id: manifest.check_id,
        artifact_path: `.hivemind/resource/oracle-candidates/${entry.name}`,
        patch: await readFile(path.join(root, entry.name, "candidate.patch"), "utf8"),
        base_outcome: attemptOutcome(validation.attempts, "base_with_candidate"),
        post_change_outcome: attemptOutcome(validation.attempts, "post_change_with_candidate")
      });
    } catch {
      warnings.push(`Characterization evidence ${entry.name} is unreadable.`);
    }
  }
  return { characterizations, warnings };
}

async function inspectMemory(
  repoRoot: string,
  events: HivemindEvent[],
  characterizations: WorkspaceCharacterization[]
): Promise<{ ok: true; value: WorkspaceMemoryInspection } | { ok: false; reason: string }> {
  const canon = await readCanonMemory(repoRoot);
  if (!canon.ok) return canon;
  const promotedIds = new Set(canon.value.map((entry) => entry.proposal_id));
  const proposals: MemoryProposal[] = [];
  const warnings: string[] = [];
  const proposalIds = [...new Set(events
    .filter((event) => event.type === "memory.proposed" && typeof event.data.proposal_id === "string")
    .map((event) => String(event.data.proposal_id)))];
  for (const proposalId of proposalIds) {
    if (promotedIds.has(proposalId)) continue;
    const proposal = await readMemoryProposal(repoRoot, proposalId);
    if (proposal.ok) proposals.push(proposal.value);
    else warnings.push(`Pending memory ${proposalId} could not be read: ${proposal.reason}`);
  }
  const activeRouting = await readPromotedRoutingPolicy(repoRoot);
  return {
    ok: true,
    value: {
      pending_lessons: proposals.filter((proposal) => proposal.routing_policy === null && proposal.value_quality_policy === null)
        .map(presentMemoryProposal).sort(compareMemoryItems),
      routing_changes: proposals.filter((proposal) => proposal.routing_policy !== null || proposal.value_quality_policy !== null)
        .map((proposal) => proposal.routing_policy !== null
          ? presentRoutingChange(proposal, proposal.routing_policy)
          : presentValueQualityChange(proposal, proposal.value_quality_policy as ValueQualityPolicy))
        .sort(compareMemoryItems),
      draft_tests: characterizations,
      canon: canon.value.map(presentCanonEntry).sort((left, right) => right.approved_at.localeCompare(left.approved_at)),
      active_routing: {
        status: activeRouting.promoted,
        canon_id: activeRouting.active_canon_id,
        reason: activeRouting.reason,
        task_types: activeRouting.active_policy === null ? [] : presentRoutingTaskTypes(activeRouting.active_policy)
      },
      warnings
    }
  };
}

async function inspectHistory(
  repoRoot: string,
  events: HivemindEvent[],
  ledger: QuotaLedger,
  config: HivemindConfig
): Promise<{ ok: true; value: WorkspaceHistoryInspection } | { ok: false; reason: string }> {
  const sessions = await inspectManagerSessionHistory(repoRoot);
  if (!sessions.ok) return sessions;
  const ascending = [...sessions.value].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const runs = await Promise.all(ascending.map(async (session, index) => {
    const nextStart = ascending[index + 1]?.created_at;
    const runEvents = events.filter((event) => event.ts >= session.created_at && (nextStart === undefined || event.ts < nextStart));
    const verifiedTasks = verifiedTaskIds(runEvents);
    const mergedTasks = mergedTaskIds(runEvents);
    const stoppedTasks = stoppedTaskStates(runEvents);
    const plannedTaskIds = await ratifiedTaskIds(repoRoot, events, session.spec_id, session.created_at);
    const usage = sessionUsage(ledger, session.session_id);
    const autonomyLevels = runAutonomyLevels(runEvents, session.autonomy_level);
    const lastEventAt = runEvents.at(-1)?.ts ?? session.last_activity_at;
    const lastActivityAt = lastEventAt > session.last_activity_at ? lastEventAt : session.last_activity_at;
    const outcome = historyOutcome(session.status, verifiedTasks, mergedTasks, stoppedTasks, plannedTaskIds);
    return {
      session_id: session.session_id,
      spec_id: session.spec_id,
      started_at: session.created_at,
      last_activity_at: lastActivityAt,
      duration_ms: Math.max(0, Date.parse(lastActivityAt) - Date.parse(session.created_at)),
      outcome: outcome.state,
      outcome_detail: outcome.detail,
      verified_tasks: verifiedTasks,
      merged_tasks: mergedTasks,
      stopped_tasks: stoppedTasks,
      calls: usage.calls,
      effective_tokens: usage.effectiveTokens,
      provider_reported_tokens: usage.providerReportedTokens,
      self_measured_tokens: usage.selfMeasuredTokens,
      evidence_paths: [session.evidence_path, ".hivemind/log/events.jsonl"],
      autonomy_levels: autonomyLevels
    } satisfies WorkspaceHistoryRun;
  }));
  return {
    ok: true,
    value: {
      runs: runs.reverse(),
      run_ceiling_tokens: config.resource_policy?.run_ceiling?.tokens ?? 150_000,
      session_ceiling_tokens: config.resource_policy?.session_ceiling?.tokens ?? 500_000,
      warnings: []
    }
  };
}

function presentMemoryProposal(proposal: MemoryProposal): WorkspaceMemoryProposal {
  return {
    proposal_id: proposal.proposal_id,
    proposed_at: proposal.proposed_at,
    title: proposal.title,
    lesson: proposal.lesson,
    evidence: [...proposal.evidence],
    task_id: proposal.task_id,
    review_command: `hivemind memory review ${proposal.proposal_id} --approve`
  };
}

function presentRoutingChange(proposal: MemoryProposal, policy: LearnedRoutingPolicy): WorkspaceRoutingChange {
  return { ...presentMemoryProposal(proposal), change_kind: "routing_weights", task_types: presentRoutingTaskTypes(policy), error_prone_task_types: [] };
}

function presentValueQualityChange(proposal: MemoryProposal, policy: ValueQualityPolicy): WorkspaceRoutingChange {
  return {
    ...presentMemoryProposal(proposal),
    change_kind: "quality_eligibility",
    task_types: [],
    error_prone_task_types: [...policy.error_prone_routing_task_types]
  };
}

function presentRoutingTaskTypes(policy: LearnedRoutingPolicy): WorkspaceRoutingChange["task_types"] {
  return policy.task_types.map((taskType) => ({
    routing_task_type: taskType.routing_task_type,
    providers: taskType.providers.map(presentRoutingProvider)
  }));
}

function presentRoutingProvider(provider: RoutingProviderScorecard): WorkspaceRoutingProvider {
  return {
    provider: provider.provider,
    weight: provider.weight,
    sample_count: provider.sample_count,
    request_count: provider.request_count,
    accepted_count: provider.accepted_count,
    integrated_count: provider.integrated_count,
    failed_count: provider.failed_count,
    timeout_count: provider.timeout_count,
    revision_count: provider.revision_count,
    merged_diff_bytes: provider.merged_diff_bytes,
    effective_tokens: provider.effective_tokens,
    merged_diff_bytes_per_1k_tokens: provider.merged_diff_bytes_per_1k_tokens,
    handoff_safety_rate: provider.handoff_safety_rate,
    cost_source: provider.cost_source,
    evidence: [...provider.evidence]
  };
}

function presentCanonEntry(entry: CanonMemoryEntry): WorkspaceCanonEntry {
  return {
    canon_id: entry.canon_id,
    approved_at: entry.approved_at,
    title: entry.title,
    lesson: entry.lesson,
    evidence: [...entry.evidence]
  };
}

function attemptOutcome(
  rawAttempts: unknown,
  tree: "base_with_candidate" | "post_change_with_candidate"
): "pass" | "fail" | "unknown" {
  if (!Array.isArray(rawAttempts)) return "unknown";
  const attempt = rawAttempts.find((value) => isRecord(value) && value.tree === tree);
  if (!isRecord(attempt) || !Array.isArray(attempt.runs) || attempt.runs.length === 0) return "unknown";
  const exitCodes = attempt.runs.map((run) => isRecord(run) ? run.exit_code : null);
  return exitCodes.every((exitCode) => exitCode === 0) ? "pass" : exitCodes.every((exitCode) => typeof exitCode === "number" && exitCode !== 0) ? "fail" : "unknown";
}

function verifiedTaskIds(events: HivemindEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "task.integrated" && event.task_id !== null) ids.add(event.task_id);
    if (event.type === "integration.passed" && Array.isArray(event.data.applied)) {
      for (const value of event.data.applied) if (typeof value === "string") ids.add(value);
    }
  }
  return [...ids].sort();
}

function mergedTaskIds(events: HivemindEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "adoption.completed" && Array.isArray(event.data.task_ids)) {
      for (const value of event.data.task_ids) if (typeof value === "string") ids.add(value);
    }
  }
  return [...ids].sort();
}

function stoppedTaskStates(events: HivemindEvent[]): WorkspaceHistoryRun["stopped_tasks"] {
  const terminal = new Map<string, WorkspaceHistoryRun["stopped_tasks"][number]>();
  const states = new Map<HivemindEvent["type"], WorkspaceHistoryRun["stopped_tasks"][number]["state"]>([
    ["task.failed", "failed"],
    ["task.blocked", "blocked"],
    ["task.cancelled", "cancelled"],
    ["task.paused", "paused"]
  ]);
  for (const event of events) {
    const state = states.get(event.type);
    if (event.task_id !== null && state !== undefined) {
      terminal.set(event.task_id, { task_id: event.task_id, state, reason: plainEvidence(event) });
    }
    if (event.task_id !== null && ["task.started", "task.completed", "task.integrated"].includes(event.type)) terminal.delete(event.task_id);
  }
  return [...terminal.values()].sort((left, right) => left.task_id.localeCompare(right.task_id));
}

function sessionUsage(ledger: QuotaLedger, sessionId: string) {
  let calls = 0;
  let effectiveTokens = 0;
  let providerReportedTokens = 0;
  let selfMeasuredTokens = 0;
  for (const entry of Object.values(ledger)) {
    const usage = entry.session_usage[sessionId];
    if (usage === undefined || entry.unmetered) continue;
    calls += usage.requests;
    effectiveTokens += usage.effective_tokens;
    providerReportedTokens += usage.provider_reported_tokens;
    selfMeasuredTokens += usage.self_measured_tokens;
  }
  return { calls, effectiveTokens, providerReportedTokens, selfMeasuredTokens };
}

function historyOutcome(
  status: ManagerWorkspaceSession["status"],
  verifiedTasks: string[],
  mergedTasks: string[],
  stoppedTasks: WorkspaceHistoryRun["stopped_tasks"],
  plannedTaskIds: string[] | null
): { state: WorkspaceHistoryRun["outcome"]; detail: string } {
  if (stoppedTasks.length > 0) return { state: "needs_attention", detail: `${stoppedTasks.length} task${stoppedTasks.length === 1 ? "" : "s"} stopped or paused.` };
  if (status === "paused") return { state: "paused", detail: "The run is waiting for a decision." };
  if (plannedTaskIds !== null && plannedTaskIds.every((taskId) => mergedTasks.includes(taskId))) {
    return { state: "completed", detail: `All ${plannedTaskIds.length} planned task${plannedTaskIds.length === 1 ? "" : "s"} merged into the project.` };
  }
  if (plannedTaskIds !== null && plannedTaskIds.every((taskId) => verifiedTasks.includes(taskId))) {
    return { state: "completed", detail: `All ${plannedTaskIds.length} planned task${plannedTaskIds.length === 1 ? "" : "s"} passed project checks and are ready to adopt.` };
  }
  if (status === "active") return { state: "active", detail: "The run is still active." };
  if (verifiedTasks.length > 0) return { state: "completed", detail: `${verifiedTasks.length} task${verifiedTasks.length === 1 ? "" : "s"} passed project checks and are ready to adopt.` };
  return { state: "completed", detail: "The run ended without a verified change." };
}

async function ratifiedTaskIds(
  repoRoot: string,
  events: HivemindEvent[],
  specId: string,
  sessionCreatedAt: string
): Promise<string[] | null> {
  const ratification = [...events].reverse().find((event) =>
    event.type === "plan.ratified" &&
    event.ts <= sessionCreatedAt &&
    event.data.spec_id === specId
  );
  if (ratification === undefined) return null;
  const plan = await loadRatifiedPlanByIdentity(
    repoRoot,
    specId,
    ratification.data.plan_path,
    ratification.data.plan_hash,
    "workspace history"
  );
  return plan.ok ? plan.value.tasks.map((task) => task.task_id) : null;
}

function compareMemoryItems(left: WorkspaceMemoryProposal, right: WorkspaceMemoryProposal): number {
  return right.proposed_at.localeCompare(left.proposed_at) || left.proposal_id.localeCompare(right.proposal_id);
}

async function inspectPlans(
  repoRoot: string,
  specId: string,
  events: HivemindEvent[],
  config: HivemindConfig
): Promise<{ ok: true; review: WorkspacePlanReview | null; current: WorkspacePlanReview | null } | { ok: false; reason: string }> {
  const tentative = await loadTentativePlan(repoRoot, specId);
  let review: WorkspacePlanReview | null = null;
  if (tentative.ok) {
    const reviewed = await reviewPlanForRatification(repoRoot, specId);
    if (reviewed.ok) {
      const alreadyRatified = events.some((event) =>
        event.type === "plan.ratified" && event.data.spec_id === specId && event.data.plan_hash === reviewed.value.plan_hash
      );
      if (!alreadyRatified) review = presentPlan(reviewed.value, config);
    } else if (
      !reviewed.reason.includes("requires a current lint-passed tentative plan") &&
      !tentativePlanWasFullyAdopted(tentative.value, events)
    ) {
      return reviewed;
    }
  } else if (!tentative.reason.startsWith("tentative plan not found:")) {
    return tentative;
  }
  const ratified = await loadCurrentRatifiedPlan(repoRoot, specId, "workspace plan inspection");
  if (!ratified.ok && !ratified.reason.endsWith("requires an explicitly ratified plan")) {
    return ratified;
  }
  const current = review ?? (ratified.ok ? presentStoredPlan(specId, ratified.value, config, events) : null);
  return { ok: true, review, current };
}

function tentativePlanWasFullyAdopted(plan: TentativePlan, events: HivemindEvent[]): boolean {
  const plannedTaskIds = plan.tasks.map((task) => task.task_id);
  return events.some((event) => {
    if (event.type !== "adoption.completed" || event.data.pre_adoption_ref !== plan.base_commit) return false;
    const adoptedTaskIds = new Set(
      Array.isArray(event.data.task_ids)
        ? event.data.task_ids.filter((taskId): taskId is string => typeof taskId === "string")
        : []
    );
    return plannedTaskIds.length > 0 && plannedTaskIds.every((taskId) => adoptedTaskIds.has(taskId));
  });
}

function presentPlan(
  review: PlanRatificationResult,
  config: HivemindConfig
): WorkspacePlanReview {
  return presentPlanData(review.spec_id, review.plan_hash, review.plan_path, review.plan, config);
}

function presentStoredPlan(
  specId: string,
  plan: TentativePlan,
  config: HivemindConfig,
  events: HivemindEvent[]
): WorkspacePlanReview {
  const ratified = [...events].reverse().find((event) => event.type === "plan.ratified" && event.data.spec_id === specId);
  return presentPlanData(
    specId,
    typeof ratified?.data.plan_hash === "string" ? ratified.data.plan_hash : "",
    typeof ratified?.data.plan_path === "string" ? ratified.data.plan_path : "",
    plan,
    config
  );
}

function presentPlanData(
  specId: string,
  planHash: string,
  planPath: string,
  plan: TentativePlan,
  config: HivemindConfig
): WorkspacePlanReview {
  return {
    spec_id: specId,
    plan_hash: planHash,
    plan_path: planPath,
    base_commit: plan.base_commit,
    created_at: plan.created_at,
    tasks: plan.tasks.map((task) => {
      const scope = task.grounded_scope ?? task.draft_scope;
      return {
        task_id: task.task_id,
        title: task.title,
        tier: inferAllowedFilesTier(scope.allowed_files, config),
        task_type: task.task_type,
        routing_task_type: task.routing_task_type,
        mode: task.mode,
        agent_role: task.agent_role,
        scope: scope.allowed_files,
        allowed_file_intents: { ...(task.draft_scope.allowed_file_intents ?? {}) },
        read_only_scope: scope.read_only_files,
        forbidden_scope: scope.forbidden_files,
        must_not_change: scope.must_not_change,
        depends_on: task.depends_on,
        parallel_safe: task.parallel_safe,
        acceptance_criterion: task.acceptance_criterion,
        deterministic_validity_check: task.deterministic_validity_check ?? null,
        required_tests: task.required_tests,
        patch_requirements: task.patch_requirements,
        critical_path_approved: task.critical_path_approved
      };
    }),
    execution_groups: plan.execution_groups.map((group) => ({ ...group, task_ids: [...group.task_ids] }))
  };
}

async function buildQueues(
  repoRoot: string,
  events: HivemindEvent[],
  planReview: WorkspacePlanReview | null,
  currentPlan: WorkspacePlanReview | null,
  session: ManagerWorkspaceSession | null,
  integrationFailure: WorkspaceInspection["integration_failure"],
  options: WorkspaceInspectionOptions
): Promise<{ ok: true; value: { needsYou: WorkspaceQueueItem[]; later: WorkspaceQueueItem[] } } | { ok: false; reason: string }> {
  const needsYou: WorkspaceQueueItem[] = [];
  if (planReview !== null) {
    needsYou.push({
      id: `plan:${planReview.plan_hash}`,
      kind: "plan_review",
      title: "A plan is ready to review",
      detail: `${planReview.tasks.length} tasks are waiting for your approval before work begins.`,
      created_at: planReview.created_at,
      task_id: null,
      action: null
    });
  }
  if (session?.pending_action !== null && session?.pending_action !== undefined) {
    const pending = session.pending_action;
    needsYou.push({
      id: `approval:${pending.pending_action_id}`,
      kind: "manager_approval",
      title: plainApprovalTitle(pending.action_type),
      detail: plainApprovalDetail(pending.action_type),
      created_at: session.created_at,
      task_id: typeof pending.action === "object" && pending.action !== null && "task_id" in pending.action && typeof pending.action.task_id === "string" ? pending.action.task_id : null,
      action: {
        type: "manager.approve_pending",
        payload: {
          session_id: session.session_id,
          pending_action_id: pending.pending_action_id,
          action_type: pending.action_type,
          subject: pending.subject,
          expected_state_hash: pending.expected_state_hash
        }
      }
    });
  }
  if (integrationFailure !== null) {
    needsYou.push({
      id: `integration-failure:${session?.session_id ?? "unknown"}`,
      kind: "verification_blocked",
      title: "The project check could not finish",
      detail: integrationFailure.reason,
      created_at: session?.created_at ?? new Date(0).toISOString(),
      task_id: integrationFailure.task_ids[0] ?? null,
      action: session === null ? null : {
        type: "manager.retry_blocked",
        payload: { session_id: session.session_id }
      }
    });
  }
  const stalled = await inspectRunStall(repoRoot, events, planReview, currentPlan, session, options);
  if (stalled !== null) needsYou.push(stalled);
  const adoption = await inspectLatestAdoptionReadiness(repoRoot);
  if (!adoption.ok) return adoption;
  if (adoption.value.status === "needs_reverification") {
    const taskDetail = adoption.value.task_ids.length === 0 ? "the queued changes" : adoption.value.task_ids.join(" + ");
    needsYou.push({
      id: `reverify:${adoption.value.verified_at ?? "unknown"}:${adoption.value.reason_code}`,
      kind: "reverification_required",
      title: adoptionReasonTitle(adoption.value.reason_code),
      detail: `${adoption.value.reason} Fresh checks will re-evaluate ${taskDetail}; they will not reuse or alter the old result.`,
      created_at: adoption.value.verified_at ?? new Date(0).toISOString(),
      task_id: adoption.value.task_ids[0] ?? null,
      action: { type: "verification.rerun", payload: {} }
    });
  }
  if (adoption.value.status === "ready" && adoption.value.verification_id !== null) {
    const verificationId = adoption.value.verification_id;
    const baseBranch = adoption.value.base_branch ?? "the project branch";
    const reviewed = [...events].reverse().find((event) => event.type === "adoption.reviewed" && event.data.verification_id === verificationId);
    const reviewFailed = reviewed !== undefined && events.some((event) =>
      event.type === "adoption.failed" && event.data.pending_adoption_id === reviewed.data.pending_adoption_id && event.ts >= reviewed.ts
    );
    const exactReview = reviewed !== undefined && !reviewFailed &&
      typeof reviewed.data.pending_adoption_id === "string" &&
      typeof reviewed.data.expected_base_head === "string" &&
      typeof reviewed.data.expected_state_hash === "string";
    const taskSummary = adoption.value.task_ids.join(" + ");
    const fileSummary = `${adoption.value.changed_files.length} files`;
    const baseSummary = adoption.value.base_commit === null ? "the verified base" : adoption.value.base_commit.slice(0, 8);
    needsYou.push({
      id: `adoption:${verificationId}:${exactReview ? reviewed!.data.pending_adoption_id : "review"}`,
      kind: "adoption_ready",
      title: exactReview ? "Confirm this exact change set" : "Fresh checks passed; review the change set",
      detail: exactReview
        ? `${taskSummary} / ${fileSummary} / base ${baseSummary}. This one action moves the verified set onto ${baseBranch}.`
        : `${taskSummary} / ${fileSummary} / base ${baseSummary}. Review binds this exact set before merge authorization appears.`,
      created_at: exactReview ? reviewed!.ts : adoption.value.verified_at ?? new Date(0).toISOString(),
      task_id: null,
      action: exactReview ? {
        type: "adoption.execute",
        payload: {
          pending_adoption_id: reviewed!.data.pending_adoption_id,
          verification_id: verificationId,
          expected_base_head: reviewed!.data.expected_base_head,
          expected_state_hash: reviewed!.data.expected_state_hash
        }
      } : { type: "adoption.review", payload: { verification_id: verificationId } },
      change_set: {
        verification_id: verificationId,
        base_branch: baseBranch,
        task_ids: [...adoption.value.task_ids],
        changed_files: [...adoption.value.changed_files]
      }
    });
  }
  for (const event of latestTaskAttention(events)) {
    needsYou.push(queueEvent(event, "task_attention", taskAttentionTitle(event), plainEvidence(event)));
  }
  const exhausted = [...events].reverse().find((event) => event.type === "quota.exhausted" && event.data.source === "token_ceiling");
  if (exhausted !== undefined) {
    needsYou.push(queueEvent(exhausted, "task_attention", "The run reached its spending limit", plainEvidence(exhausted)));
  }
  for (const event of latestQualityCancellationFailures(events)) {
    needsYou.push(queueEvent(event, "quality_cancel_failed", "A draft run could not stop cleanly", plainEvidence(event)));
  }

  const canon = await readCanonMemory(repoRoot);
  if (!canon.ok) return canon;
  const promoted = new Set(canon.value.map((entry) => entry.proposal_id));
  const later: WorkspaceQueueItem[] = [];
  for (const event of events) {
    if (event.type === "memory.proposed" && typeof event.data.proposal_id === "string" && !promoted.has(event.data.proposal_id)) {
      later.push(queueEvent(event, "memory_review", typeof event.data.title === "string" ? event.data.title : "Something may be worth remembering", "Review the supporting evidence when you have time."));
    }
    if (event.type === "quality.selection_decided") {
      later.push(queueEvent(event, "quality_review", "A candidate change is ready to compare", "Review the selected draft and its test evidence later."));
    }
    if (event.type === "plan.amendment_queued") {
      later.push(queueEvent(event, "plan_amendment", "A plan change is queued", "It will take effect only after the updated plan is reviewed and approved."));
    }
  }
  return {
    ok: true,
    value: {
      needsYou: needsYou.sort(compareQueueItems),
      later: later.sort(compareQueueItems)
    }
  };
}

async function inspectRunStall(
  repoRoot: string,
  events: HivemindEvent[],
  planReview: WorkspacePlanReview | null,
  currentPlan: WorkspacePlanReview | null,
  session: ManagerWorkspaceSession | null,
  options: WorkspaceInspectionOptions
): Promise<WorkspaceQueueItem | null> {
  if (planReview !== null || currentPlan === null) return null;
  const now = options.now ?? new Date();
  const stallIntervalMs = options.stallIntervalMs ?? DEFAULT_RUN_STALL_INTERVAL_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(stallIntervalMs) || stallIntervalMs <= 0) return null;
  if (events.some((event) => {
    const taskIds = event.data.task_ids;
    return event.type === "adoption.completed" &&
      Array.isArray(taskIds) &&
      currentPlan.tasks.every((task) => taskIds.includes(task.task_id));
  })) return null;

  if (session === null) {
    const ratified = [...events].reverse().find((event) =>
      event.type === "plan.ratified" &&
      event.data.spec_id === currentPlan.spec_id &&
      event.data.plan_hash === currentPlan.plan_hash
    );
    if (ratified === undefined || elapsedMs(now, ratified.ts) < stallIntervalMs) return null;
    return {
      id: `run-stalled:start:${currentPlan.plan_hash}:${ratified.ts}`,
      kind: "run_stalled",
      title: "Approved work has not started",
      detail: `No project step was recorded after the plan was approved. Expected next: start the ${currentPlan.tasks.length}-task run.`,
      created_at: ratified.ts,
      task_id: null,
      action: {
        type: "manager.start",
        payload: { message: "Continue the exact approved plan through the normal checks.", tool: "manager" }
      }
    };
  }

  if (session.status !== "active" || !session.continuation_available) return null;
  const runEvents = events.filter((event) => event.ts >= session.created_at);
  const lastProgressAt = [...runEvents.map((event) => event.ts), session.last_activity_at]
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) ?? session.created_at;
  if (elapsedMs(now, lastProgressAt) < stallIntervalMs) return null;

  for (const task of currentPlan.tasks) {
    const state = latestTaskRunState(events, task.task_id);
    if (state.state !== "running") continue;
    const worker = await inspectRunningWorkerStall(repoRoot, events, task.task_id, state.started, now, stallIntervalMs, options.processLiveness);
    if (worker.status === "healthy_or_uncertain") return null;
    return {
      id: `run-stalled:worker:${task.task_id}:${worker.since}`,
      kind: "run_stalled",
      title: `${task.task_id} stopped making progress`,
      detail: `${worker.reason} Expected next: stop the worker cleanly, then retry or re-plan.`,
      created_at: worker.since,
      task_id: task.task_id,
      action: { type: "task.stop", payload: { task_id: task.task_id, reason: "Stop a stalled worker from the workspace." } }
    };
  }

  return {
    id: `run-stalled:continue:${session.session_id}:${lastProgressAt}`,
    kind: "run_stalled",
    title: "The run stopped advancing",
    detail: `No durable project step followed the last recorded activity. Expected next: continue the approved run from its stored state.`,
    created_at: lastProgressAt,
    task_id: null,
    action: {
      type: "manager.continue",
      payload: { session_id: session.session_id, tool: session.tool, max_steps: 25 }
    }
  };
}

async function inspectRunningWorkerStall(
  repoRoot: string,
  events: HivemindEvent[],
  taskId: string,
  started: HivemindEvent,
  now: Date,
  stallIntervalMs: number,
  probeLiveness: ((pid: number) => ProcessLiveness) | undefined
): Promise<{ status: "stalled"; reason: string; since: string } | { status: "healthy_or_uncertain" }> {
  const runId = started.data.run_id;
  const processStarted = [...events].reverse().find((event) =>
    event.type === "task.worker_process_started" &&
    event.task_id === taskId &&
    event.data.run_id === runId
  );
  if (processStarted === undefined) {
    return elapsedMs(now, started.ts) >= stallIntervalMs
      ? { status: "stalled", reason: "The worker never recorded a process start.", since: started.ts }
      : { status: "healthy_or_uncertain" };
  }
  const processStopped = events.some((event) =>
    event.type === "task.worker_process_stopped" &&
    event.task_id === taskId &&
    event.data.run_id === runId &&
    event.ts >= processStarted.ts
  );
  if (processStopped) {
    return { status: "stalled", reason: "The worker stopped without recording a task result.", since: processStarted.ts };
  }
  const pid = Number(processStarted.data.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "healthy_or_uncertain" };
  const liveness = (probeLiveness ?? getProcessLiveness)(pid);
  if (liveness === "dead") {
    return { status: "stalled", reason: "The worker process ended without recording a task result.", since: processStarted.ts };
  }
  if (liveness === "unknown") return { status: "healthy_or_uncertain" };

  const tool = typeof processStarted.data.tool === "string" ? processStarted.data.tool : "";
  if (tool === "") return { status: "healthy_or_uncertain" };
  const profile = await loadAdapterProfile(repoRoot, tool);
  if (!profile.ok || profile.profile.timeout_ms === undefined) return { status: "healthy_or_uncertain" };
  return elapsedMs(now, processStarted.ts) >= profile.profile.timeout_ms + stallIntervalMs
    ? {
        status: "stalled",
        reason: `The worker remained active past its ${Math.ceil(profile.profile.timeout_ms / 1000)}-second time limit.`,
        since: processStarted.ts
      }
    : { status: "healthy_or_uncertain" };
}

function elapsedMs(now: Date, timestamp: string): number {
  const then = Date.parse(timestamp);
  return Number.isNaN(then) ? 0 : Math.max(0, now.getTime() - then);
}

function latestTaskAttention(events: HivemindEvent[]): HivemindEvent[] {
  const latest = new Map<string, HivemindEvent>();
  const relevant = new Set([
    "task.started", "task.resumed", "task.redirected", "task.completed", "task.integrated", "task.cancelled",
    "task.failed", "task.blocked", "task.paused", "patch.rejected", "patch.accepted"
  ]);
  for (const event of events) {
    if (event.task_id !== null && relevant.has(event.type)) latest.set(event.task_id, event);
  }
  return [...latest.values()].filter((event) => ["task.failed", "task.blocked", "task.paused", "patch.rejected"].includes(event.type));
}

function latestQualityCancellationFailures(events: HivemindEvent[]): HivemindEvent[] {
  const latest = new Map<string, HivemindEvent>();
  for (const event of events) {
    const id = event.data.quality_run_id;
    if (typeof id === "string" && ["quality.cancel_failed", "quality.cancelled"].includes(event.type)) latest.set(id, event);
  }
  return [...latest.values()].filter((event) => event.type === "quality.cancel_failed");
}

function queueEvent(event: HivemindEvent, kind: WorkspaceQueueItem["kind"], title: string, detail: string): WorkspaceQueueItem {
  const identity = typeof event.data.proposal_id === "string"
    ? event.data.proposal_id
    : typeof event.data.quality_run_id === "string"
      ? event.data.quality_run_id
      : event.task_id ?? event.type;
  return { id: `${kind}:${identity}:${event.ts}`, kind, title, detail, created_at: event.ts, task_id: event.task_id, action: null };
}

function plainEvidence(event: HivemindEvent): string {
  for (const key of ["plain_reason", "report", "reason", "recommendation"]) {
    if (typeof event.data[key] === "string" && event.data[key].trim() !== "") return event.data[key] as string;
  }
  return "Open the details to see what happened.";
}

function buildIntegrationFailure(
  status: HivemindStatus,
  session: ManagerWorkspaceSession | null
): WorkspaceInspection["integration_failure"] {
  if (session?.blocked_action_type !== "integrate_shadow" || session.blocked_reason === null) {
    return null;
  }
  return {
    reason: plainIntegrationFailureReason(session.blocked_reason),
    task_ids: [...status.integration.queue]
  };
}

function plainIntegrationFailureReason(reason: string): string {
  const missingBranch = /^(?:configured )?base branch (.+) not found$/u.exec(reason);
  if (missingBranch) {
    return `The configured project branch "${missingBranch[1]}" could not be found. Review the base branch setting, then retry the project check.`;
  }
  if (/config\.base_branch is not recorded/iu.test(reason)) {
    return "This project has no recorded base branch. Check out the intended branch, run project setup again, then retry the project check.";
  }
  return reason;
}

function taskAttentionTitle(event: HivemindEvent): string {
  if (event.type === "patch.rejected") return `${event.task_id} needs a revision`;
  if (event.type === "task.blocked") return `${event.task_id} cannot continue`;
  if (event.type === "task.paused") return `${event.task_id} is waiting for capacity`;
  return `${event.task_id} stopped unexpectedly`;
}

function runAutonomyLevels(events: HivemindEvent[], startingLevel: AutonomyLevel): AutonomyLevel[] {
  const levels: AutonomyLevel[] = [startingLevel];
  for (const event of events) {
    if (event.type !== "autonomy.decision_recorded" || !isAutonomyLevel(event.data.level)) continue;
    if (levels.at(-1) !== event.data.level) levels.push(event.data.level);
  }
  return levels;
}

function plainApprovalTitle(action: string): string {
  const labels: Record<string, string> = {
    run_worker: "Approve starting this worker",
    integrate_shadow: "Approve checking this change against the project"
  };
  return labels[action] ?? `Approve ${action.replaceAll("_", " ")}`;
}

function plainApprovalDetail(action: string): string {
  if (action === "run_worker") {
    return "This starts the assigned worker inside its approved file boundary.";
  }
  if (action === "integrate_shadow") {
    return "This applies the change to an isolated copy and runs the project's configured checks. It does not update the project branch.";
  }
  return "Review this proposed action before allowing the run to continue.";
}

function adoptionReasonTitle(reason: string): string {
  if (reason === "missing_provenance") return "This change needs fresh checks before it can merge";
  if (reason === "moved_head") return "The project changed after these checks";
  if (reason === "changed_inputs") return "The checked inputs no longer match";
  if (reason === "lease_problem") return "Editing ownership changed after verification";
  if (reason === "oracle_block") return "Test coverage is not strong enough to continue";
  return "The latest project checks need to run again";
}

function compareQueueItems(left: WorkspaceQueueItem, right: WorkspaceQueueItem): number {
  return right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
