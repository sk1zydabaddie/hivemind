import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
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
  loadTentativePlan,
  reviewPlanForRatification,
  type PlanRatificationResult,
  type TentativePlan
} from "./plan.js";
import { readQuotaLedger, type QuotaLedger } from "./resource-ledger.js";
import { readPromotedRoutingPolicy } from "./learned-routing.js";
import type { LearnedRoutingPolicy, RoutingProviderScorecard } from "./routing-policy-schema.js";
import type { ValueQualityPolicy } from "./value-quality-policy-schema.js";
import { inferAllowedFilesTier, type TaskTier } from "./routing.js";
import { readJsonFile } from "./json.js";
import { readActiveSpec } from "./spec.js";
import { getStatus, type HivemindStatus } from "./status.js";

export interface WorkspaceQueueItem {
  id: string;
  kind: "plan_review" | "manager_approval" | "merge_blocked" | "task_attention" | "quality_cancel_failed" | "memory_review" | "quality_review" | "plan_amendment";
  title: string;
  detail: string;
  created_at: string;
  task_id: string | null;
  action: { type: string; payload: Record<string, unknown> } | null;
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
  plan_review: WorkspacePlanReview | null;
  current_plan: WorkspacePlanReview | null;
  needs_you: WorkspaceQueueItem[];
  later: WorkspaceQueueItem[];
  spend: {
    session_id: string | null;
    calls: number;
    effective_tokens: number;
    run_ceiling_tokens: number;
    session_ceiling_tokens: number;
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
  merged_tasks: string[];
  stopped_tasks: Array<{ task_id: string; state: "failed" | "blocked" | "cancelled" | "paused"; reason: string }>;
  calls: number;
  effective_tokens: number;
  provider_reported_tokens: number;
  self_measured_tokens: number;
  evidence_paths: string[];
}

export interface WorkspaceHistoryInspection {
  runs: WorkspaceHistoryRun[];
  run_ceiling_tokens: number;
  session_ceiling_tokens: number;
  warnings: string[];
}

export async function inspectWorkspace(repoRoot: string): Promise<{ ok: true; value: WorkspaceInspection } | { ok: false; reason: string }> {
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

  const planState = specId === null
    ? { ok: true as const, review: null, current: null }
    : await inspectPlans(repoRoot, specId, events.value, config.config);
  if (!planState.ok) return planState;
  const queues = await buildQueues(repoRoot, events.value, planState.review, session.value);
  if (!queues.ok) return queues;
  const ledger = await readQuotaLedger(repoRoot);
  if (!ledger.ok) return ledger;
  const swarm = await inspectCharacterizations(repoRoot);
  const memory = await inspectMemory(repoRoot, events.value, swarm.characterizations);
  if (!memory.ok) return memory;
  const history = await inspectHistory(repoRoot, events.value, ledger.value, config.config);
  if (!history.ok) return history;
  const sessionId = session.value?.session_id ?? null;
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
      plan_review: planState.review,
      current_plan: planState.current,
      needs_you: queues.value.needsYou,
      later: queues.value.later,
      spend: {
        session_id: sessionId,
        calls,
        effective_tokens: effectiveTokens,
        run_ceiling_tokens: config.config.resource_policy?.run_ceiling?.tokens ?? 150_000,
        session_ceiling_tokens: config.config.resource_policy?.session_ceiling?.tokens ?? 500_000
      },
      swarm,
      memory: memory.value,
      history: history.value
    }
  };
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
  const runs = ascending.map((session, index) => {
    const nextStart = ascending[index + 1]?.created_at;
    const runEvents = events.filter((event) => event.ts >= session.created_at && (nextStart === undefined || event.ts < nextStart));
    const mergedTasks = mergedTaskIds(runEvents);
    const stoppedTasks = stoppedTaskStates(runEvents);
    const usage = sessionUsage(ledger, session.session_id);
    const lastEventAt = runEvents.at(-1)?.ts ?? session.last_activity_at;
    const lastActivityAt = lastEventAt > session.last_activity_at ? lastEventAt : session.last_activity_at;
    const outcome = historyOutcome(session.status, mergedTasks, stoppedTasks);
    return {
      session_id: session.session_id,
      spec_id: session.spec_id,
      started_at: session.created_at,
      last_activity_at: lastActivityAt,
      duration_ms: Math.max(0, Date.parse(lastActivityAt) - Date.parse(session.created_at)),
      outcome: outcome.state,
      outcome_detail: outcome.detail,
      merged_tasks: mergedTasks,
      stopped_tasks: stoppedTasks,
      calls: usage.calls,
      effective_tokens: usage.effectiveTokens,
      provider_reported_tokens: usage.providerReportedTokens,
      self_measured_tokens: usage.selfMeasuredTokens,
      evidence_paths: [session.evidence_path, ".hivemind/log/events.jsonl"]
    } satisfies WorkspaceHistoryRun;
  });
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

function mergedTaskIds(events: HivemindEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "task.integrated" && event.task_id !== null) ids.add(event.task_id);
    if (event.type === "integration.passed" && Array.isArray(event.data.applied)) {
      for (const value of event.data.applied) if (typeof value === "string") ids.add(value);
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
  mergedTasks: string[],
  stoppedTasks: WorkspaceHistoryRun["stopped_tasks"]
): { state: WorkspaceHistoryRun["outcome"]; detail: string } {
  if (stoppedTasks.length > 0) return { state: "needs_attention", detail: `${stoppedTasks.length} task${stoppedTasks.length === 1 ? "" : "s"} stopped or paused.` };
  if (status === "paused") return { state: "paused", detail: "The run is waiting for a decision." };
  if (status === "active") return { state: "active", detail: "The run is still active." };
  if (mergedTasks.length > 0) return { state: "completed", detail: `${mergedTasks.length} task${mergedTasks.length === 1 ? "" : "s"} reached merge.` };
  return { state: "completed", detail: "The run ended without a merged task." };
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
    } else if (!reviewed.reason.includes("requires a current lint-passed tentative plan")) {
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
  session: ManagerWorkspaceSession | null
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
      title: `Approve ${plainActionName(pending.action_type)}`,
      detail: pending.recommendation || pending.reason,
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
  const mergeState = [...events].reverse().find((event) =>
    ["integration.blocked", "integration.failed", "integration.passed", "integration.started"].includes(event.type)
  );
  if (mergeState?.type === "integration.blocked") {
    needsYou.push(queueEvent(mergeState, "merge_blocked", "A change is blocked before merge", plainEvidence(mergeState)));
  }
  for (const event of latestTaskAttention(events)) {
    needsYou.push(queueEvent(event, "task_attention", taskAttentionTitle(event), plainEvidence(event)));
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

function latestTaskAttention(events: HivemindEvent[]): HivemindEvent[] {
  const latest = new Map<string, HivemindEvent>();
  const relevant = new Set([
    "task.started", "task.resumed", "task.redirected", "task.completed", "task.integrated", "task.cancelled",
    "task.failed", "task.blocked", "patch.rejected", "patch.accepted"
  ]);
  for (const event of events) {
    if (event.task_id !== null && relevant.has(event.type)) latest.set(event.task_id, event);
  }
  return [...latest.values()].filter((event) => ["task.failed", "task.blocked", "patch.rejected"].includes(event.type));
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

function taskAttentionTitle(event: HivemindEvent): string {
  if (event.type === "patch.rejected") return `${event.task_id} needs a revision`;
  if (event.type === "task.blocked") return `${event.task_id} cannot continue`;
  return `${event.task_id} stopped unexpectedly`;
}

function plainActionName(action: string): string {
  const labels: Record<string, string> = { run_worker: "starting this worker", integrate_shadow: "merging checked changes" };
  return labels[action] ?? action.replaceAll("_", " ");
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
