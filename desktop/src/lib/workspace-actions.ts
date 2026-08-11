import { invoke } from "@tauri-apps/api/core";
import type { TaskProjection } from "./projection";

export type AutonomyLevel = "auto" | "review_plan" | "review_everything";

export interface WorkspaceQueueItem {
  id: string;
  kind:
    | "plan_review"
    | "manager_approval"
    | "verification_blocked"
    | "reverification_required"
    | "run_stalled"
    | "task_attention"
    | "quality_cancel_failed"
    | "memory_review"
    | "quality_review"
    | "plan_amendment"
    | "adoption_ready";
  title: string;
  detail: string;
  created_at: string;
  task_id: string | null;
  action: WorkspaceAction | null;
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
  tier: "low" | "medium" | "high" | "critical";
  task_type: "generative" | "deterministic";
  routing_task_type: string;
  mode: "read_only" | "write" | "integration";
  agent_role: string;
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
  execution_groups: Array<{
    group_id: string;
    mode: "parallel" | "sequence";
    task_ids: string[];
  }>;
}

export interface WorkspaceInspection {
  tasks: TaskProjection[];
  execution_groups: Array<{
    group_id: string;
    mode: "parallel" | "sequence";
    task_ids: string[];
    label: string;
    counts: { working: number; waiting: number; needs_you: number; done: number };
    configured_cap: number | null;
    effective_concurrency: number | null;
    binding_limit: "configured_cap" | "budget" | "ready_count" | null;
    capacity_note: string | null;
  }>;
  task_titles: Record<string, string>;
  active_spec_id: string | null;
  active_spec_title: string | null;
  manager_session: null | {
    session_id: string;
    spec_id: string;
    created_at: string;
    last_activity_at: string;
    status: "active" | "paused" | "stopped" | "complete";
    tool: string;
    call_count: number;
    blocked_reason: string | null;
    blocked_action_type: string | null;
    continuation_available: boolean;
    autonomy_level: AutonomyLevel;
    autonomy_levels: AutonomyLevel[];
  };
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
    characterizations: Array<{
      candidate_id: string;
      task_id: string;
      classification: "rejected" | "regression_signal" | "valid_characterization" | "indeterminate";
      reason: string;
      check_id: string;
      artifact_path: string;
      patch: string;
      base_outcome: "pass" | "fail" | "unknown";
      post_change_outcome: "pass" | "fail" | "unknown";
    }>;
    warnings: string[];
  };
  memory: {
    pending_lessons: WorkspaceMemoryProposal[];
    routing_changes: WorkspaceRoutingChange[];
    draft_tests: WorkspaceCharacterization[];
    canon: Array<{
      canon_id: string;
      approved_at: string;
      title: string;
      lesson: string;
      evidence: string[];
    }>;
    active_routing: {
      status: "active" | "absent" | "stale" | "invalid";
      canon_id: string | null;
      reason: string | null;
      task_types: WorkspaceRoutingTaskType[];
    };
    warnings: string[];
  };
  history: {
    runs: WorkspaceHistoryRun[];
    run_ceiling_tokens: number;
    session_ceiling_tokens: number;
    warnings: string[];
  };
}

export type WorkspaceCharacterization = WorkspaceInspection["swarm"]["characterizations"][number];

export interface WorkspaceMemoryProposal {
  proposal_id: string;
  proposed_at: string;
  title: string;
  lesson: string;
  evidence: string[];
  task_id: string | null;
  review_command: string;
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

export interface WorkspaceRoutingTaskType {
  routing_task_type: string;
  providers: WorkspaceRoutingProvider[];
}

export interface WorkspaceRoutingChange extends WorkspaceMemoryProposal {
  change_kind: "routing_weights" | "quality_eligibility";
  task_types: WorkspaceRoutingTaskType[];
  error_prone_task_types: string[];
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
  stopped_tasks: Array<{
    task_id: string;
    state: "failed" | "blocked" | "cancelled" | "paused";
    reason: string;
  }>;
  calls: number;
  effective_tokens: number;
  provider_reported_tokens: number;
  self_measured_tokens: number;
  evidence_paths: string[];
  autonomy_levels: AutonomyLevel[];
}

/** What the one review shows. Read-only; `spec.adopt` is the signature. */
export interface SpecReview {
  spec_id: string;
  title: string;
  authorship: "human" | "drafted";
  status: "draft" | "ratified";
  goal: string;
  drafted_non_goals: string[];
  acceptance: string[];
  open_questions: string[];
  assumptions: string[];
  asked_for: string | null;
}

export type WorkspaceAction = {
  type:
    | "autonomy.set"
    | "manager.start"
    | "manager.continue"
    | "manager.retry_blocked"
    | "guidance.record"
    | "plan.prepare"
    | "plan.review"
    | "plan.ratify"
    | "spec.draft"
    | "spec.review"
    | "spec.adopt"
    | "manual_task.review"
    | "manual_task.authorize"
    | "plan.amend"
    | "manager.approve_pending"
    | "task.redirect"
    | "task.stop"
    | "run.stop"
    | "status.inspect"
    | "trail.inspect"
    | "change.inspect"
    | "verify.characterize"
    | "quality.best_of_n"
    | "quality.draft_refine"
    | "quality.cancel"
    | "memory.review_handoff"
    | "verification.rerun"
    | "adoption.review"
    | "adoption.execute";
  payload: Record<string, unknown>;
};

export function invokeWorkspaceAction<T>(projectPath: string, action: WorkspaceAction): Promise<T> {
  return invoke<T>("workspace_action", { projectPath, action });
}
