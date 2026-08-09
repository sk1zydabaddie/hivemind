import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_AUTONOMY_LEVEL, isAutonomyLevel, type AutonomyLevel } from "./autonomy-level.js";
import { loadConfig, type HivemindConfig } from "./config.js";
import { readEvents, type HivemindEvent } from "./events.js";
import { integratedTaskIdsFromEvents } from "./integration-state.js";
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
import { readQuotaLedgerState, type QuotaLedger } from "./resource-ledger.js";
import { readPromotedRoutingPolicy } from "./learned-routing.js";
import { loadAdapterProfile } from "./adapter.js";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";
import { latestTaskRunState } from "./run-state.js";
import type { LearnedRoutingPolicy, RoutingProviderScorecard } from "./routing-policy-schema.js";
import type { ValueQualityPolicy } from "./value-quality-policy-schema.js";
import { inferAllowedFilesTier, type TaskTier } from "./routing.js";
import { readJsonFile } from "./json.js";
import { readActiveSpec } from "./spec.js";
import { loadSpecDocument } from "./spec-format.js";
import { getStatus, type HivemindStatus } from "./status.js";
import { inspectLatestAdoptionReadiness } from "./adoption.js";
import { readTaskOutput } from "./output-stream.js";
import { hasFailureCode } from "./failure-code.js";

export interface WorkspaceQueueItem {
  id: string;
  kind: "plan_review" | "manager_approval" | "verification_blocked" | "reverification_required" | "run_stalled" | "task_attention" | "quality_cancel_failed" | "memory_review" | "quality_review" | "plan_amendment" | "adoption_ready" | "adoption_failed" | "adoption_indeterminate";
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
  tasks: WorkspaceTaskProjection[];
  execution_groups: WorkspaceExecutionGroupProjection[];
  task_titles: Record<string, string>;
  active_spec_id: string | null;
  active_spec_title: string | null;
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
    reserved_tokens: number;
    committed_tokens: number;
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

export type WorkspaceTaskState =
  | "planned"
  | "running"
  | "paused"
  | "submitted"
  | "accepted"
  | "rejected"
  | "blocked"
  | "failed"
  | "cancelled"
  | "verified"
  | "merged";

export interface WorkspaceTaskProjection {
  task_id: string;
  title: string;
  state: WorkspaceTaskState;
  agent: string | null;
  worktree: string | null;
  lease_files: string[];
  patch: {
    submitted: boolean;
    analyzed: boolean;
    verdict: string | null;
    reason: string | null;
    changed_files: number | null;
  };
  integration: string;
  issue: string | null;
  stalled: boolean;
  last_event: string | null;
  last_event_at: string | null;
  execution_group: string | null;
  group_mode: "parallel" | "sequence" | null;
  depends_on: string[];
  started_at: string | null;
  worker_finished_at: string | null;
}

export interface WorkspaceExecutionGroupProjection {
  group_id: string;
  mode: "parallel" | "sequence";
  task_ids: string[];
  label: string;
  counts: {
    working: number;
    waiting: number;
    needs_you: number;
    done: number;
  };
  configured_cap: number | null;
  effective_concurrency: number | null;
  binding_limit: "configured_cap" | "budget" | "ready_count" | null;
  capacity_note: string | null;
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
  if (!activeSpec.ok && !hasFailureCode(activeSpec, "no_active_spec")) return activeSpec;
  const specId = activeSpec.ok ? activeSpec.value.spec_id : null;
  /* Read-only, and never fatal: a project without a readable spec document still
     reports the rest of its state. */
  const specDocument = specId === null ? null : await loadSpecDocument(repoRoot, specId);
  const specTitle =
    specDocument !== null && specDocument.ok && specDocument.value.title.trim() !== ""
      ? specDocument.value.title.trim()
      : null;
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
  const integrationFailure = buildIntegrationFailure(status.value, session.value, config.config);
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
  const ledger = await readQuotaLedgerState(repoRoot);
  if (!ledger.ok) return ledger;
  const swarm = await inspectCharacterizations(repoRoot);
  const memory = await inspectMemory(repoRoot, events.value, swarm.characterizations);
  if (!memory.ok) return memory;
  // One answer to "which tasks are verified", derived once over the whole
  // durable log and shared by every surface below. Nothing here re-derives it.
  const integrated = integratedTaskIdsFromEvents(events.value);
  const history = await inspectHistory(repoRoot, events.value, ledger.value.providers, config.config, integrated);
  if (!history.ok) return history;
  const preparedPlanSession = planState.current === null
    ? null
    : latestPreparedPlanSession(events.value, planState.current);
  const sessionId = preparedPlanSession ?? session.value?.session_id ?? null;
  let calls = 0;
  let effectiveTokens = 0;
  if (sessionId !== null) {
    for (const entry of Object.values(ledger.value.providers)) {
      const usage = entry.session_usage[sessionId];
      if (usage !== undefined && !entry.unmetered) {
        calls += usage.requests;
        effectiveTokens += usage.effective_tokens;
      }
    }
  }
  const reservedTokens = sessionId === null
    ? 0
    : Object.values(ledger.value.reservations).reduce((total, reservation) =>
      total + (reservation.status === "active" && reservation.session_id === sessionId ? reservation.reserved_tokens : 0), 0);
  const committedTokens = effectiveTokens + reservedTokens;
  const tasks = buildWorkspaceTasks(status.value, events.value, planState.current ?? planState.review, queues.value.needsYou, integrated);
  const executionGroups = buildWorkspaceExecutionGroups(tasks, planState.current ?? planState.review, events.value);
  const taskTitles = Object.fromEntries(tasks.map((task) => [task.task_id, task.title]));
  return {
    ok: true,
    value: {
      status: status.value,
      tasks,
      execution_groups: executionGroups,
      task_titles: taskTitles,
      active_spec_id: specId,
      active_spec_title: specTitle,
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
        reserved_tokens: reservedTokens,
        committed_tokens: committedTokens,
        run_ceiling_tokens: config.config.resource_policy?.run_ceiling?.tokens ?? 150_000,
        session_ceiling_tokens: config.config.resource_policy?.session_ceiling?.tokens ?? 500_000,
        near_session_ceiling: committedTokens >= (config.config.resource_policy?.session_ceiling?.tokens ?? 500_000) * 0.8
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

function buildWorkspaceTasks(
  status: HivemindStatus,
  events: HivemindEvent[],
  plan: WorkspacePlanReview | null,
  needsYou: WorkspaceQueueItem[],
  integrated: Set<string>
): WorkspaceTaskProjection[] {
  const planTasks = new Map((plan?.tasks ?? []).map((task) => [task.task_id, task]));
  const statusTasks = new Map(status.tasks.map((task) => [task.task_id, task]));
  const orderedIds = [
    ...(plan?.tasks.map((task) => task.task_id) ?? []),
    ...status.tasks.map((task) => task.task_id).filter((taskId) => !planTasks.has(taskId))
  ];
  const stalled = new Set(needsYou.filter((item) => item.kind === "run_stalled" && item.task_id !== null).map((item) => item.task_id!));
  const observed = new Map<string, WorkspaceTaskProjection>();

  for (const taskId of orderedIds) {
    const planned = planTasks.get(taskId);
    const durable = statusTasks.get(taskId);
    const group = plan?.execution_groups.find((candidate) => candidate.task_ids.includes(taskId));
    observed.set(taskId, {
      task_id: taskId,
      title: planned?.title ?? durable?.title ?? taskId,
      state: "planned",
      agent: null,
      worktree: durable?.worktree === "present" ? ".hivemind/worktrees/" + taskId : null,
      lease_files: [...(durable?.lease.files ?? [])],
      patch: {
        submitted: durable?.patch.submitted ?? false,
        analyzed: durable?.patch.analyzed ?? false,
        verdict: durable?.patch.verdict ?? null,
        reason: durable?.patch.reason ?? null,
        changed_files: null
      },
      integration: durable?.integrated ? "verified" : durable?.queued ? "queued" : "not queued",
      issue: null,
      stalled: stalled.has(taskId),
      last_event: null,
      last_event_at: null,
      execution_group: group?.group_id ?? null,
      group_mode: group?.mode ?? null,
      depends_on: [...(planned?.depends_on ?? [])],
      started_at: null,
      worker_finished_at: null
    });
  }

  for (const event of events) {
    const direct = event.task_id === null ? null : observed.get(event.task_id);
    if (direct !== null && direct !== undefined) {
      direct.last_event = event.type;
      direct.last_event_at = event.ts;
      applyWorkspaceTaskEvent(direct, event);
    }
    if (event.type === "integration.passed" && Array.isArray(event.data.applied)) {
      for (const taskId of event.data.applied) {
        // An integration.passed only stands while the durable trail still backs
        // it. A later rejection, superseding submit, or failed integration
        // retracts it, so gate on the shared set rather than latching here.
        if (typeof taskId !== "string" || !integrated.has(taskId)) continue;
        const task = observed.get(taskId);
        if (task === undefined) continue;
        task.state = "verified";
        task.integration = "verified";
        task.issue = null;
      }
    }
    if (event.type === "adoption.completed" && Array.isArray(event.data.task_ids)) {
      for (const taskId of event.data.task_ids) {
        if (typeof taskId !== "string") continue;
        const task = observed.get(taskId);
        if (task === undefined) continue;
        task.state = "merged";
        task.integration = "merged";
        task.issue = null;
      }
    }
    // A verified set whose adoption failed or could not be determined must not
    // keep reading as verified: the rehearsal passed, but the transition it was
    // rehearsing did not happen, or nobody can say whether it did.
    if ((event.type === "adoption.failed" || event.type === "adoption.indeterminate") && Array.isArray(event.data.task_ids)) {
      for (const taskId of event.data.task_ids) {
        if (typeof taskId !== "string") continue;
        const task = observed.get(taskId);
        if (task === undefined || task.state === "merged") continue;
        task.state = "blocked";
        task.integration = event.type === "adoption.indeterminate" ? "adoption indeterminate" : "adoption failed";
        task.issue = plainEvidence(event);
      }
    }
  }
  return orderedIds.map((taskId) => observed.get(taskId)!).filter(Boolean);
}

function applyWorkspaceTaskEvent(task: WorkspaceTaskProjection, event: HivemindEvent): void {
  if (event.type === "task.created") {
    task.title = readNonEmptyString(event.data.title) ?? readNonEmptyString(event.data.goal) ?? task.title;
    return;
  }
  if (event.type === "task.assigned") {
    task.agent = readNonEmptyString(event.data.agent) ?? readNonEmptyString(event.data.tool) ?? task.agent;
    return;
  }
  if (["task.started", "task.resumed", "task.redirected"].includes(event.type)) {
    task.state = "running";
    task.agent = readNonEmptyString(event.data.tool) ?? task.agent;
    task.worktree = readNonEmptyString(event.data.worktree) ?? task.worktree;
    task.issue = null;
    task.started_at ??= event.ts;
    return;
  }
  if (event.type === "task.completed") {
    task.state = "submitted";
    task.worker_finished_at = event.ts;
    return;
  }
  if (event.type === "task.paused") task.state = "paused";
  if (event.type === "task.cancelled") task.state = "cancelled";
  if (event.type === "task.blocked") task.state = "blocked";
  if (event.type === "task.failed") task.state = "failed";
  if (["task.paused", "task.cancelled", "task.blocked", "task.failed"].includes(event.type)) {
    task.issue = plainEvidence(event);
    task.worker_finished_at = event.ts;
    return;
  }
  if (event.type === "patch.submitted") {
    task.state = "submitted";
    task.patch.submitted = true;
    // A new patch supersedes the previous analysis. status.ts's
    // latestPatchEventState already resets here; without this the two Core
    // readers disagree and the Work tab shows a stale "accept" verdict for a
    // patch that was never analyzed.
    task.patch.analyzed = false;
    task.patch.verdict = null;
    task.patch.reason = null;
    task.patch.changed_files = readSafeNumber(event.data.changed_files);
    return;
  }
  if (event.type === "patch.accepted") {
    task.state = "accepted";
    task.patch.analyzed = true;
    task.patch.verdict = "accept";
    task.patch.reason = readNonEmptyString(event.data.reason);
    task.issue = null;
    return;
  }
  if (event.type === "patch.rejected") {
    task.state = "rejected";
    task.patch.analyzed = true;
    task.patch.verdict = readNonEmptyString(event.data.verdict) ?? "reject";
    task.patch.reason = readNonEmptyString(event.data.reason);
    task.issue = task.patch.reason;
  }
}

function buildWorkspaceExecutionGroups(
  tasks: WorkspaceTaskProjection[],
  plan: WorkspacePlanReview | null,
  events: HivemindEvent[]
): WorkspaceExecutionGroupProjection[] {
  const definitions = plan?.execution_groups ?? fallbackWorkspaceGroups(tasks);
  return definitions.map((group) => {
    const groupTasks = group.task_ids.map((taskId) => tasks.find((task) => task.task_id === taskId)).filter((task): task is WorkspaceTaskProjection => task !== undefined);
    const groupStates = groupTasks.map(classifyWorkspaceGroupTask);
    const counts = {
      working: groupStates.filter((state) => state === "working").length,
      waiting: groupStates.filter((state) => state === "waiting").length,
      needs_you: groupStates.filter((state) => state === "needs_you").length,
      done: groupStates.filter((state) => state === "done").length
    };
    const wave = latestWaveForGroup(events, group.group_id);
    const configuredCap = readSafeNumber(wave?.data.configured_cap);
    const effectiveConcurrency = readSafeNumber(wave?.data.effective_concurrency);
    const binding = wave?.data.binding_limit;
    const bindingLimit = binding === "configured_cap" || binding === "budget" || binding === "ready_count" ? binding : null;
    return {
      group_id: group.group_id,
      mode: group.mode,
      task_ids: [...group.task_ids],
      label: actualGroupLabel(counts),
      counts,
      configured_cap: configuredCap,
      effective_concurrency: effectiveConcurrency,
      binding_limit: bindingLimit,
      capacity_note: bindingLimit === "budget" && configuredCap !== null && effectiveConcurrency !== null
        ? `Budget allows ${effectiveConcurrency} worker${effectiveConcurrency === 1 ? "" : "s"} right now; the project limit is ${configuredCap}.`
        : null
    };
  });
}

function classifyWorkspaceGroupTask(task: WorkspaceTaskProjection): keyof WorkspaceExecutionGroupProjection["counts"] {
  if (task.stalled || ["failed", "blocked", "rejected"].includes(task.state)) return "needs_you";
  if (["verified", "merged", "cancelled"].includes(task.state)) return "done";
  if (["running", "submitted", "accepted"].includes(task.state)) return "working";
  return "waiting";
}

function fallbackWorkspaceGroups(tasks: WorkspaceTaskProjection[]): Array<{ group_id: string; mode: "parallel" | "sequence"; task_ids: string[] }> {
  const grouped = new Map<string, { group_id: string; mode: "parallel" | "sequence"; task_ids: string[] }>();
  for (const task of tasks) {
    const groupId = task.execution_group ?? "current-work";
    const value = grouped.get(groupId) ?? { group_id: groupId, mode: task.group_mode ?? "sequence", task_ids: [] };
    value.task_ids.push(task.task_id);
    grouped.set(groupId, value);
  }
  return [...grouped.values()];
}

function latestWaveForGroup(events: HivemindEvent[], groupId: string): HivemindEvent | undefined {
  return [...events].reverse().find((event) => event.type === "scheduler.wave_started" && event.data.group_id === groupId);
}

function actualGroupLabel(counts: WorkspaceExecutionGroupProjection["counts"]): string {
  const parts = [
    [counts.working, "working"],
    [counts.waiting, "waiting"],
    [counts.needs_you, "needs you"],
    [counts.done, "done"]
  ] as const;
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(", ") || "No active tasks";
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readSafeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
  config: HivemindConfig,
  integrated: Set<string>
): Promise<{ ok: true; value: WorkspaceHistoryInspection } | { ok: false; reason: string }> {
  const sessions = await inspectManagerSessionHistory(repoRoot);
  if (!sessions.ok) return sessions;
  const ascending = [...sessions.value].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const runs = await Promise.all(ascending.map(async (session, index) => {
    const nextStart = ascending[index + 1]?.created_at;
    const runEvents = events.filter((event) => event.ts >= session.created_at && (nextStart === undefined || event.ts < nextStart));
    const verifiedTasks = runVerifiedTaskIds(runEvents, integrated);
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

// Scope only. This decides which run a verified task is attributed to; whether
// the task is verified at all is decided solely by the caller's
// integratedTaskIdsFromEvents set, so History and `hivemind status` cannot
// disagree — including after a retraction the run window alone cannot see.
function runVerifiedTaskIds(runEvents: HivemindEvent[], integrated: Set<string>): string[] {
  const ids = new Set<string>();
  for (const event of runEvents) {
    if (event.type !== "integration.passed" || !Array.isArray(event.data.applied)) continue;
    for (const value of event.data.applied) {
      if (typeof value === "string" && integrated.has(value)) ids.add(value);
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
    if (event.task_id !== null && ["task.started", "task.completed"].includes(event.type)) terminal.delete(event.task_id);
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
      !hasFailureCode(reviewed, "plan_not_currently_lint_passed") &&
      !tentativePlanWasFullyAdopted(tentative.value, events)
    ) {
      return reviewed;
    }
  } else if (!hasFailureCode(tentative, "tentative_plan_not_found")) {
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
  needsYou.push(...await inspectRunStalls(repoRoot, events, planReview, currentPlan, session, options));
  needsYou.push(...unresolvedAdoptionOutcomes(events));
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
    needsYou.push(queueEvent(
      event,
      "task_attention",
      taskAttentionTitle(event, currentPlan ?? planReview),
      taskAttentionDetail(event, events, currentPlan ?? planReview)
    ));
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

async function inspectRunStalls(
  repoRoot: string,
  events: HivemindEvent[],
  planReview: WorkspacePlanReview | null,
  currentPlan: WorkspacePlanReview | null,
  session: ManagerWorkspaceSession | null,
  options: WorkspaceInspectionOptions
): Promise<WorkspaceQueueItem[]> {
  if (planReview !== null || currentPlan === null) return [];
  const now = options.now ?? new Date();
  const stallIntervalMs = options.stallIntervalMs ?? DEFAULT_RUN_STALL_INTERVAL_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(stallIntervalMs) || stallIntervalMs <= 0) return [];
  if (events.some((event) => {
    const taskIds = event.data.task_ids;
    return event.type === "adoption.completed" &&
      Array.isArray(taskIds) &&
      currentPlan.tasks.every((task) => taskIds.includes(task.task_id));
  })) return [];

  if (session === null) {
    const ratified = [...events].reverse().find((event) =>
      event.type === "plan.ratified" &&
      event.data.spec_id === currentPlan.spec_id &&
      event.data.plan_hash === currentPlan.plan_hash
    );
    if (ratified === undefined || elapsedMs(now, ratified.ts) < stallIntervalMs) return [];
    return [{
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
    }];
  }

  if (session.status !== "active" || !session.continuation_available) return [];
  const runEvents = events.filter((event) => event.ts >= session.created_at);
  const lastProgressAt = [...runEvents.map((event) => event.ts), session.last_activity_at]
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) ?? session.created_at;
  const workerAlerts: WorkspaceQueueItem[] = [];
  let runningWorkers = 0;
  for (const task of currentPlan.tasks) {
    const state = latestTaskRunState(events, task.task_id);
    if (state.state !== "running") continue;
    runningWorkers += 1;
    const worker = await inspectRunningWorkerStall(repoRoot, events, task.task_id, state.started, now, stallIntervalMs, options.processLiveness);
    if (worker.status === "healthy_or_uncertain") continue;
    workerAlerts.push({
      id: `run-stalled:worker:${task.task_id}:${worker.since}`,
      kind: "run_stalled",
      title: `${task.title} stopped making progress`,
      detail: `${worker.reason} Expected next: stop the worker cleanly, then retry or re-plan.`,
      created_at: worker.since,
      task_id: task.task_id,
      action: { type: "task.stop", payload: { task_id: task.task_id, reason: "Stop a stalled worker from the workspace." } }
    });
  }
  if (workerAlerts.length > 0) return workerAlerts;
  if (runningWorkers > 0 || elapsedMs(now, lastProgressAt) < stallIntervalMs) return [];

  return [{
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
  }];
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
  const output = await readTaskOutput(repoRoot, taskId);
  if (!output.ok) return { status: "healthy_or_uncertain" };
  const latestOutputAt = output.value.map((record) => record.ts).sort().at(-1);
  if (latestOutputAt !== undefined && elapsedMs(now, latestOutputAt) < stallIntervalMs) {
    return { status: "healthy_or_uncertain" };
  }
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

/**
 * Adoption is the only transition that touches the user's own branch, so a
 * failed or indeterminate one must never be silent. An indeterminate outcome
 * carries no action: the system has concluded it cannot tell whether the branch
 * moved, and there is no safe automatic recovery, so it hands the human the refs
 * to check by hand instead of offering a button that might do it twice.
 */
function unresolvedAdoptionOutcomes(events: HivemindEvent[]): WorkspaceQueueItem[] {
  const superseded = new Set(
    events.filter((event) => event.type === "adoption.completed").map((event) => event.data.verification_id)
  );
  const items: WorkspaceQueueItem[] = [];
  for (const event of events) {
    if (event.type !== "adoption.failed" && event.type !== "adoption.indeterminate") continue;
    // A later successful adoption of the same verified set resolves it.
    if (superseded.has(event.data.verification_id)) continue;
    const taskIds = (Array.isArray(event.data.task_ids) ? event.data.task_ids : []).filter(
      (entry): entry is string => typeof entry === "string"
    );
    const scope = taskIds.length === 0 ? "the verified change set" : taskIds.join(" + ");
    const indeterminate = event.type === "adoption.indeterminate";
    items.push({
      id: `${event.type}:${String(event.data.adoption_id ?? event.ts)}`,
      kind: indeterminate ? "adoption_indeterminate" : "adoption_failed",
      title: indeterminate ? "We cannot tell whether this landed" : "The merge did not happen",
      detail: indeterminate
        ? `${scope} could not be confirmed either way. Check your branch by hand: it was at ${refSummary(event.data.pre_adoption_ref)} before, the change would have made it ${refSummary(event.data.adopted_ref ?? event.data.candidate_commit)}, and it now reads ${refSummary(event.data.observed_head)}. ${plainEvidence(event)}`
        : `${scope} was not merged and your branch is unchanged. ${plainEvidence(event)}`,
      created_at: event.ts,
      task_id: taskIds[0] ?? null,
      action: null
    });
  }
  return items;
}

function refSummary(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, 12) : "an unknown commit";
}

function latestTaskAttention(events: HivemindEvent[]): HivemindEvent[] {
  const latest = new Map<string, HivemindEvent>();
  const relevant = new Set([
    "task.started", "task.resumed", "task.redirected", "task.completed", "task.cancelled",
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
  session: ManagerWorkspaceSession | null,
  config: HivemindConfig
): WorkspaceInspection["integration_failure"] {
  if (session?.blocked_action_type !== "integrate_shadow" || session.blocked_reason === null) {
    return null;
  }
  return {
    reason: plainIntegrationFailureReason(session.blocked_reason, session.blocked_code, config.base_branch),
    task_ids: [...status.integration.queue]
  };
}

function plainIntegrationFailureReason(
  reason: string,
  code: ManagerWorkspaceSession["blocked_code"],
  configuredBaseBranch: string | undefined
): string {
  const failure = { ok: false as const, ...(code === null ? {} : { code }) };
  if (hasFailureCode(failure, "integration_base_branch_not_found") && configuredBaseBranch?.trim()) {
    return `The configured project branch "${configuredBaseBranch.trim()}" could not be found. Review the base branch setting, then retry the project check.`;
  }
  if (hasFailureCode(failure, "integration_base_branch_missing")) {
    return "This project has no recorded base branch. Check out the intended branch, run project setup again, then retry the project check.";
  }
  return reason;
}

function taskAttentionTitle(event: HivemindEvent, plan: WorkspacePlanReview | null): string {
  const title = plan?.tasks.find((task) => task.task_id === event.task_id)?.title ?? event.task_id ?? "Task";
  if (event.type === "patch.rejected") return `${title} needs a revision`;
  if (event.type === "task.blocked") return `${title} cannot continue`;
  if (event.type === "task.paused") return `${title} is waiting for capacity`;
  return `${title} stopped`;
}

function taskAttentionDetail(event: HivemindEvent, events: HivemindEvent[], plan: WorkspacePlanReview | null): string {
  if (event.type !== "task.failed" || event.task_id === null || plan === null) return plainEvidence(event);
  const failedTaskId = event.task_id;
  const group = plan.execution_groups.find((candidate) => candidate.task_ids.includes(failedTaskId));
  const continuing = (group?.task_ids ?? []).filter((taskId) => taskId !== failedTaskId && latestTaskRunState(events, taskId).state === "running").length;
  const continuity = continuing === 0
    ? "No other task in this group is currently working."
    : `${continuing} other task${continuing === 1 ? " is" : "s are"} continuing.`;
  return `${event.task_id} stopped; ${continuity} ${plainEvidence(event)}`;
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
