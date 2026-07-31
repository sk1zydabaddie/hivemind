import { invoke } from "@tauri-apps/api/core";

export type WorkspaceAction = {
  type:
    | "manager.start"
    | "manager.continue"
    | "guidance.record"
    | "plan.review"
    | "plan.ratify"
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
