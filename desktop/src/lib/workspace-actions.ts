import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceQueueItem {
  id: string;
  kind:
    | "plan_review"
    | "manager_approval"
    | "merge_blocked"
    | "task_attention"
    | "quality_cancel_failed"
    | "memory_review"
    | "quality_review"
    | "plan_amendment";
  title: string;
  detail: string;
  created_at: string;
  task_id: string | null;
  action: WorkspaceAction | null;
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
  active_spec_id: string | null;
  manager_session: null | {
    session_id: string;
    spec_id: string;
    created_at: string;
    status: "active" | "paused" | "stopped" | "complete";
    tool: string;
    call_count: number;
    blocked_reason: string | null;
  };
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
    characterizations: Array<{
      candidate_id: string;
      task_id: string;
      classification: "rejected" | "regression_signal" | "valid_characterization" | "indeterminate";
      reason: string;
      check_id: string;
      artifact_path: string;
    }>;
    warnings: string[];
  };
}

export type WorkspaceAction = {
  type:
    | "manager.start"
    | "manager.continue"
    | "guidance.record"
    | "plan.review"
    | "plan.ratify"
    | "manual_task.review"
    | "manual_task.authorize"
    | "plan.amend"
    | "manager.approve_pending"
    | "task.redirect"
    | "task.stop"
    | "status.inspect"
    | "change.inspect"
    | "verify.characterize"
    | "quality.best_of_n"
    | "quality.draft_refine"
    | "quality.cancel"
    | "memory.review_handoff";
  payload: Record<string, unknown>;
};

export function invokeWorkspaceAction<T>(projectPath: string, action: WorkspaceAction): Promise<T> {
  return invoke<T>("workspace_action", { projectPath, action });
}
