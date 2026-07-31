import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateBestOfN } from "./best-of-n.js";
import { generateCharacterizationCandidate } from "./characterization-generator.js";
import { generateDraftRefine } from "./draft-refine.js";
import { recordHumanGuidance } from "./human-guidance.js";
import { approvePendingManagerAction, continueAutonomousManagerLoop, startManagerSession } from "./manager.js";
import { queuePlanAmendment, ratifyPlan, reviewPlanForRatification } from "./plan.js";
import { cancelQualityRun } from "./quality-control.js";
import { findGitRoot } from "./repo.js";
import { getStatus } from "./status.js";
import { requestTaskRedirect } from "./supervision.js";
import { requestTaskStop } from "./task-control.js";

export const workspaceActionTypes = [
  "manager.start",
  "manager.continue",
  "guidance.record",
  "plan.review",
  "plan.ratify",
  "plan.amend",
  "manager.approve_pending",
  "task.redirect",
  "task.stop",
  "status.inspect",
  "change.inspect",
  "verify.characterize",
  "quality.best_of_n",
  "quality.draft_refine",
  "quality.cancel",
  "memory.review_handoff"
] as const;

export type WorkspaceActionType = (typeof workspaceActionTypes)[number];
type ActionResult = { ok: true; value: unknown } | { ok: false; reason: string };

export async function executeWorkspaceAction(repoRoot: string, raw: unknown): Promise<ActionResult> {
  if (!isRecord(raw) || typeof raw.type !== "string" || !workspaceActionTypes.includes(raw.type as WorkspaceActionType)) {
    return { ok: false, reason: "workspace action must have a supported typed action" };
  }
  const authorityFields = ["approved", "approval", "human", "force", "tier", "verdict", "gate_passed", "authorized"];
  const claimed = Object.keys(raw).find((key) => authorityFields.includes(key));
  if (claimed !== undefined) return { ok: false, reason: `workspace action cannot supply authority field: ${claimed}` };
  const payload = raw.payload;
  if (!isRecord(payload)) return { ok: false, reason: "workspace action payload must be an object" };

  if (raw.type === "guidance.record") return recordHumanGuidance(repoRoot, payload);
  if (raw.type === "plan.review") {
    const parsed = exactStrings(payload, ["spec_id"]);
    return parsed.ok ? reviewPlanForRatification(repoRoot, parsed.value.spec_id) : parsed;
  }
  if (raw.type === "plan.ratify") {
    const parsed = exactStrings(payload, ["spec_id", "expected_plan_hash"]);
    return parsed.ok ? ratifyPlan(repoRoot, parsed.value.spec_id, parsed.value.expected_plan_hash) : parsed;
  }
  if (raw.type === "plan.amend") {
    if (typeof payload.spec_id !== "string" || !isRecord(payload.amendment) || Object.keys(payload).some((key) => key !== "spec_id" && key !== "amendment")) {
      return { ok: false, reason: "plan.amend requires only spec_id and amendment" };
    }
    return queuePlanAmendment(repoRoot, payload.spec_id, payload.amendment);
  }
  if (raw.type === "manager.approve_pending") return approvePendingManagerAction(repoRoot, payload);
  if (raw.type === "task.redirect") {
    const parsed = exactStrings(payload, ["task_id", "correction"]);
    return parsed.ok
      ? requestTaskRedirect(repoRoot, { task_id: parsed.value.task_id, correction: parsed.value.correction, source: "human" })
      : parsed;
  }
  if (raw.type === "task.stop") return requestTaskStop(repoRoot, payload);
  if (raw.type === "quality.cancel") return cancelQualityRun(repoRoot, payload);
  if (raw.type === "status.inspect") {
    if (Object.keys(payload).length > 0) return { ok: false, reason: "status.inspect takes no fields" };
    return getStatus(repoRoot);
  }
  if (raw.type === "change.inspect") {
    const parsed = exactStrings(payload, ["task_id"]);
    if (!parsed.ok) return parsed;
    try {
      return { ok: true, value: { task_id: parsed.value.task_id, diff: await readFile(path.join(repoRoot, ".hivemind", "patches", parsed.value.task_id, "diff.patch"), "utf8") } };
    } catch {
      return { ok: false, reason: `change not found for ${parsed.value.task_id}` };
    }
  }
  if (raw.type === "manager.start") {
    const parsed = exactStrings(payload, ["message", "tool"]);
    return parsed.ok ? startManagerSession(repoRoot, parsed.value.message, { tool: parsed.value.tool }) : parsed;
  }
  if (raw.type === "manager.continue") {
    const parsed = parseManagerContinue(payload);
    return parsed.ok
      ? continueAutonomousManagerLoop(repoRoot, parsed.value.session_id, {
          tool: parsed.value.tool,
          maxSteps: parsed.value.max_steps
        })
      : parsed;
  }
  if (raw.type === "verify.characterize") {
    const parsed = exactStrings(payload, ["task_id", "tool", "check_id"], ["check_id"]);
    return parsed.ok ? generateCharacterizationCandidate(repoRoot, parsed.value.task_id, parsed.value.tool, parsed.value.check_id) : parsed;
  }
  if (raw.type === "quality.best_of_n") return generateBestOfN(repoRoot, payload);
  if (raw.type === "quality.draft_refine") return generateDraftRefine(repoRoot, payload);
  if (raw.type === "memory.review_handoff") {
    const parsed = exactStrings(payload, ["proposal_id"]);
    return parsed.ok
      ? { ok: true, value: { proposal_id: parsed.value.proposal_id, command: `hivemind memory review ${parsed.value.proposal_id}`, local_interactive_tty_required: true, promotion_performed: false } }
      : parsed;
  }
  return { ok: false, reason: "unsupported workspace action" };
}

function parseManagerContinue(
  value: Record<string, unknown>
): { ok: true; value: { session_id: string; tool: string; max_steps: number } } | { ok: false; reason: string } {
  if (Object.keys(value).some((key) => !["session_id", "tool", "max_steps"].includes(key))) {
    return { ok: false, reason: "manager.continue payload contains an unsupported field" };
  }
  if (typeof value.session_id !== "string" || value.session_id.trim() === "") {
    return { ok: false, reason: "session_id must be a non-empty string" };
  }
  if (typeof value.tool !== "string" || value.tool.trim() === "") {
    return { ok: false, reason: "tool must be a non-empty string" };
  }
  if (!Number.isSafeInteger(value.max_steps) || Number(value.max_steps) < 1 || Number(value.max_steps) > 100) {
    return { ok: false, reason: "max_steps must be an integer between 1 and 100" };
  }
  return { ok: true, value: { session_id: value.session_id, tool: value.tool, max_steps: Number(value.max_steps) } };
}

export async function workspaceActionCommand(cwd: string, args: string[]): Promise<number> {
  if (args.length !== 1) {
    console.error("error: usage: hivemind workspace <typed-action-json-file>");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.resolve(cwd, args[0]), "utf8"));
  } catch {
    console.error("error: workspace action file must contain valid JSON");
    return 1;
  }
  const result = await executeWorkspaceAction(repoRoot, raw);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function exactStrings(
  value: Record<string, unknown>,
  fields: string[],
  optional: string[] = []
): { ok: true; value: Record<string, string> } | { ok: false; reason: string } {
  if (Object.keys(value).some((key) => !fields.includes(key))) return { ok: false, reason: "workspace action payload contains an unsupported field" };
  const output: Record<string, string> = {};
  for (const field of fields) {
    if (value[field] === undefined && optional.includes(field)) continue;
    if (typeof value[field] !== "string" || value[field].trim() === "") return { ok: false, reason: `${field} must be a non-empty string` };
    output[field] = value[field];
  }
  return { ok: true, value: output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
