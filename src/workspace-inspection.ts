import { loadConfig, type HivemindConfig } from "./config.js";
import { readEvents, type HivemindEvent } from "./events.js";
import { inspectLatestManagerSession, type ManagerWorkspaceSession } from "./manager.js";
import { readCanonMemory } from "./memory-canon.js";
import {
  loadCurrentRatifiedPlan,
  loadTentativePlan,
  reviewPlanForRatification,
  type PlanRatificationResult,
  type TentativePlan
} from "./plan.js";
import { readQuotaLedger } from "./resource-ledger.js";
import { inferAllowedFilesTier, type TaskTier } from "./routing.js";
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
      }
    }
  };
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
