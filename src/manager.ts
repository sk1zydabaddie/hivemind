import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeTask } from "./analyze.js";
import { writeJsonAtomic } from "./atomic.js";
import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  recordAdapterUsage,
  runAdapterProcess
} from "./adapter.js";
import { loadConfig } from "./config.js";
import { createTaskContract, type CreateTaskContractResult } from "./contract.js";
import { loadAndValidateContract, normalizeContract, validateContract, type TaskContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { enqueueIntegrationPatch, integrateShadow, type EnqueueIntegrationPatchResult, type IntegrationStatus } from "./integrate.js";
import { checkWriteIntent, type WriteIntentPass } from "./intent.js";
import { extractJsonObject } from "./json.js";
import { markHumanGuidanceConsumed, readPendingHumanGuidance } from "./human-guidance.js";
import { applyOrchestratorContextBudget } from "./orchestrator-context.js";
import { requestLeaseForContract, type LeaseGrantResult } from "./lease.js";
import { evaluatePlanThrash, loadTentativePlan } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { inferTaskTier } from "./routing.js";
import { markRunFailed, runTask, type RunFailureMarkResult, type RunResult, type RunStartResult } from "./run.js";
import { latestTaskRunState } from "./run-state.js";
import { runScout, type ScoutResult } from "./scout.js";
import { requireActiveSpecRatified, type SpecResult } from "./spec.js";
import { loadSpecDocument } from "./spec-format.js";
import { getStatus, type HivemindStatus } from "./status.js";
import { submitTask, type SubmitResult } from "./submit.js";
import { requestTaskRedirect } from "./supervision.js";
import { admitValueQuality, type ValueQualityAdmission, type ValueQualityStrategy } from "./value-quality.js";
import { createTaskWorktree, type WorktreeResult } from "./worktree.js";

interface ManagerSession {
  version: 1;
  session_id: string;
  created_at: string;
  spec_id: string;
  working_set: ManagerWorkingSet;
  turns: ManagerTurn[];
  proposed_action: ManagerProposedAction;
  pending_action?: ManagerPendingAction;
  blocked_action?: ManagerBlockedAction;
  executed_actions: ManagerExecutedAction[];
}

interface ManagerWorkingSet {
  spec: {
    spec_id: string;
    title: string;
    status: "ratified";
    path: string;
  };
  status: {
    task_count: number;
    active_lease_count: number;
    integration_queue_count: number;
    integrated_task_count: number;
  };
}

interface ManagerTurn {
  role: "user" | "manager";
  content: string;
}

export interface ManagerProposedAction {
  type: "proposed_actions";
  source: "adapter-generated" | "scripted";
  reason: string;
  actions: ManagerAction[];
  human_approval_required_for: ManagerAction["type"][];
  tool?: string;
}

interface ManagerExecutedAction {
  id: string;
  ts: string;
  type: ManagerAction["type"];
  task_id?: string;
  result: ManagerActionExecutionRecord;
}

export interface ManagerPendingAction {
  pending_action_id: string;
  action: ManagerAction;
  action_type: ManagerAction["type"];
  subject: string;
  expected_state_hash: string;
  tier: "human_approval";
  reason: string;
  recommendation: string;
}

export interface ManagerWorkspaceSession {
  session_id: string;
  spec_id: string;
  created_at: string;
  status: "active" | "paused" | "stopped" | "complete";
  tool: string;
  call_count: number;
  pending_action: ManagerPendingAction | null;
  blocked_reason: string | null;
}

interface ManagerBlockedAction {
  action_type: ManagerAction["type"];
  result: Extract<ManagerActionExecutionRecord, { ok: false }>;
  stop: ManagerStopAdvice;
}

type ManagerActionExecutionRecord =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export type ManagerAction =
  | { type: "get_status" }
  | { type: "create_task_contract"; contract: Record<string, unknown> }
  | { type: "request_lease"; task_id: string }
  | { type: "check_write_intent"; task_id: string; intent: Record<string, unknown> }
  | { type: "create_worktree"; task_id: string }
  | { type: "scout_task"; task_id: string; tool: string }
  | { type: "run_worker"; task_id: string; tool?: string; allow_dangerous_adapter?: boolean }
  | { type: "submit_patch"; task_id: string }
  | { type: "analyze_patch"; task_id: string }
  | { type: "enqueue_patch"; task_id: string }
  | { type: "admit_value_quality"; task_id: string; strategy: ValueQualityStrategy; n?: number }
  | { type: "integrate_shadow" };

export interface ManagerSessionResult {
  session_id: string;
  session_path: string;
  spec_id: string;
  proposed_action: ManagerProposedAction;
}

export interface ManagerActionResult {
  session_id: string;
  session_path: string;
  action_type: ManagerAction["type"];
  result: ManagerActionExecutionRecord;
}

export interface ManagerLoopResult {
  session_id: string;
  session_path: string;
  status: "passed" | "failed";
  steps: Array<{
    index: number;
    action_type: ManagerAction["type"];
    result: ManagerActionExecutionRecord;
  }>;
  final_status: HivemindStatus;
}

export interface ManagerAutonomousLoopResult {
  session_id: string;
  session_path: string;
  status: "completed" | "paused" | "stopped" | "step_limit_reached";
  steps: Array<{
    index: number;
    action_type: ManagerAction["type"];
    tier: "autonomous" | "human_approval" | "gate_rejection" | "redirect";
    result?: ManagerActionExecutionRecord;
    pause?: ManagerPendingAction;
    stop?: ManagerStopAdvice;
    redirect?: ManagerRedirectStep;
  }>;
  final_status: HivemindStatus;
}

interface ManagerRedirectStep {
  attempt: number;
  max_attempts: number;
  correction: string;
  event_types: ["task.revision_requested", "task.redirected"];
}

interface ManagerStopAdvice {
  reason: string;
  diagnosis: string;
  options: string[];
  recommendation: string;
}

interface AutonomousLoopOptions {
  tool: string;
  maxSteps: number;
}

interface ActionClassification {
  tier: "autonomous" | "human_approval";
  reason: string;
  recommendation: string;
}

interface StartManagerSessionOptions {
  tool?: string;
  proposedAction?: ManagerProposedAction;
}

export async function managerCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseManagerArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await runParsedManagerCommand(repoRoot, parsed.value);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  if ("result" in result.value && !result.value.result.ok) {
    return 1;
  }
  if ("status" in result.value && result.value.status === "failed") {
    return 1;
  }
  if ("status" in result.value && result.value.status === "stopped") {
    return 1;
  }
  return 0;
}

async function runParsedManagerCommand(
  repoRoot: string,
  parsed:
    | { mode: "message"; message: string; tool?: string }
    | { mode: "auto-message"; message: string; tool: string; maxSteps: number }
    | { mode: "auto-session"; sessionId: string; tool: string; maxSteps: number }
    | { mode: "action"; sessionId: string; actionFile: string }
    | { mode: "fake-loop"; message: string; actionsFile: string }
): Promise<SpecResult<ManagerSessionResult | ManagerActionResult | ManagerLoopResult | ManagerAutonomousLoopResult>> {
  if (parsed.mode === "message") {
    return startManagerSession(repoRoot, parsed.message, { tool: parsed.tool });
  }
  if (parsed.mode === "auto-message") {
    return runAutonomousManagerLoop(repoRoot, parsed.message, {
      tool: parsed.tool,
      maxSteps: parsed.maxSteps
    });
  }
  if (parsed.mode === "auto-session") {
    return continueAutonomousManagerLoop(repoRoot, parsed.sessionId, {
      tool: parsed.tool,
      maxSteps: parsed.maxSteps
    });
  }
  if (parsed.mode === "action") {
    return executeManagerActionFromFile(repoRoot, parsed.sessionId, parsed.actionFile);
  }
  return runNoPaidManagerLoopFromFile(repoRoot, parsed.message, parsed.actionsFile);
}

export async function startManagerSession(
  repoRoot: string,
  message: string,
  options: StartManagerSessionOptions = {}
): Promise<SpecResult<ManagerSessionResult>> {
  if (message.trim() === "") {
    return { ok: false, reason: "manager message must not be empty" };
  }

  const spec = await requireActiveSpecRatified(repoRoot);
  if (!spec.ok) {
    return spec;
  }

  const loadedSpec = await loadSpecDocument(repoRoot, spec.value.spec_id);
  if (!loadedSpec.ok) {
    return loadedSpec;
  }
  if (loadedSpec.value.status !== "ratified") {
    return { ok: false, reason: `active spec ${spec.value.spec_id} is ${loadedSpec.value.status}; ratify it before starting manager chat` };
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }

  const sessionId = randomUUID();
  const proposedAction =
    options.proposedAction === undefined
      ? await generateManagerProposal(repoRoot, message.trim(), options.tool ?? "manager", spec.value.spec_id, sessionId)
      : ({ ok: true, value: options.proposedAction } as const);
  if (!proposedAction.ok) {
    return proposedAction;
  }
  const session: ManagerSession = {
    version: 1,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    spec_id: spec.value.spec_id,
    working_set: {
      spec: {
        spec_id: spec.value.spec_id,
        title: loadedSpec.value.title,
        status: "ratified",
        path: `.hivemind/spec/${spec.value.spec_id}.md`
      },
      status: {
        task_count: status.value.tasks.length,
        active_lease_count: Object.keys(status.value.leases).length,
        integration_queue_count: status.value.integration.queue.length,
        integrated_task_count: status.value.tasks.filter((task) => task.integrated).length
      }
    },
    turns: [
      { role: "user", content: message.trim() },
      { role: "manager", content: proposedAction.value.reason }
    ],
    proposed_action: proposedAction.value,
    executed_actions: []
  };

  const relativePath = `.hivemind/orchestrator/sessions/${sessionId}.json`;
  await writeJsonAtomic(path.join(repoRoot, relativePath), session);
  return {
    ok: true,
    value: {
      session_id: sessionId,
      session_path: relativePath,
      spec_id: spec.value.spec_id,
      proposed_action: proposedAction.value
    }
  };
}

export async function generateManagerProposal(
  repoRoot: string,
  message: string,
  tool: string,
  specId?: string,
  usageSessionId?: string
): Promise<SpecResult<ManagerProposedAction>> {
  let resolvedSpecId = specId;
  if (resolvedSpecId === undefined) {
    const activeSpec = await requireActiveSpecRatified(repoRoot);
    if (!activeSpec.ok) {
      return activeSpec;
    }
    resolvedSpecId = activeSpec.value.spec_id;
  }

  const guidance = await readPendingHumanGuidance(repoRoot);
  if (!guidance.ok) {
    return guidance;
  }
  const guidedMessage = guidance.value.length === 0
    ? message
    : [
        message,
        "",
        "Durable human guidance for this proposal (advisory only; it is not approval and cannot satisfy a gate):",
        ...guidance.value.map((entry) => `- [${entry.guidance_id}] ${entry.message}`)
      ].join("\n");

  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }
  const dangerousArgs = findDangerousAdapterArgs(profileResult.profile.invoke);
  if (dangerousArgs.length > 0) {
    return {
      ok: false,
      reason: `manager adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); manager proposals must use a non-dangerous profile`
    };
  }

  const prompt = await buildManagerProposalPrompt(repoRoot, guidedMessage, resolvedSpecId, tool, profileResult.profile.context_window);
  if (!prompt.ok) {
    return prompt;
  }

  const startedAt = Date.now();
  const processResult = await runAdapterProcess(repoRoot, profileResult.profile, repoRoot, prompt.value, {
    outputLogPath: adapterRunLogPath(repoRoot, `manager-${resolvedSpecId}`),
    usageSessionId
  });
  if (!processResult.ok) {
    return processResult;
  }
  const wallTimeMs = Date.now() - startedAt;
  const ledgerResult = await recordAdapterUsage(repoRoot, profileResult.profile, prompt.value, processResult.value, wallTimeMs);
  if (!ledgerResult.ok) {
    return { ok: false, reason: ledgerResult.reason };
  }
  if (processResult.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, processResult.value, "manager adapter") };
  }

  const proposal = parseGeneratedManagerProposal(processResult.value.stdout);
  if (!proposal.ok) {
    return proposal;
  }
  const consumed = await markHumanGuidanceConsumed(
    repoRoot,
    guidance.value.map((entry) => entry.guidance_id),
    usageSessionId
  );
  if (!consumed.ok) {
    return consumed;
  }
  return {
    ok: true,
    value: {
      ...proposal.value,
      source: "adapter-generated",
      tool: profileResult.profile.tool
    }
  };
}

async function generateRedirectCorrection(
  repoRoot: string,
  tool: string,
  action: Extract<ManagerAction, { type: "check_write_intent" }>,
  rejectionReason: string,
  usageSessionId: string
): Promise<SpecResult<string>> {
  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }
  const dangerousArgs = findDangerousAdapterArgs(profileResult.profile.invoke);
  if (dangerousArgs.length > 0) {
    return {
      ok: false,
      reason: `manager adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); redirect corrections must use a non-dangerous profile`
    };
  }

  const prompt = await buildRedirectCorrectionPrompt(repoRoot, action, rejectionReason);
  if (!prompt.ok) {
    return prompt;
  }

  const startedAt = Date.now();
  const processResult = await runAdapterProcess(repoRoot, profileResult.profile, repoRoot, prompt.value, {
    outputLogPath: adapterRunLogPath(repoRoot, `redirect-${action.task_id}`),
    usageSessionId
  });
  if (!processResult.ok) {
    return processResult;
  }
  const wallTimeMs = Date.now() - startedAt;
  const ledgerResult = await recordAdapterUsage(repoRoot, profileResult.profile, prompt.value, processResult.value, wallTimeMs);
  if (!ledgerResult.ok) {
    return { ok: false, reason: ledgerResult.reason };
  }
  if (processResult.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, processResult.value, "redirect correction adapter") };
  }

  const correction = parseRedirectCorrection(processResult.value.stdout);
  if (!correction.ok) {
    return correction;
  }
  return { ok: true, value: correction.value };
}

async function buildManagerProposalPrompt(repoRoot: string, message: string, specId: string, tool: string, contextWindowTokens: number): Promise<SpecResult<string>> {
  const fullPrompt = await buildFullManagerProposalPrompt(repoRoot, message, specId, tool);
  if (!fullPrompt.ok) {
    return fullPrompt;
  }
  const leanPrompt = await buildLeanManagerProposalPrompt(repoRoot, message, specId, tool);
  if (!leanPrompt.ok) {
    return leanPrompt;
  }
  const budgeted = await applyOrchestratorContextBudget({
    repoRoot,
    tool,
    specId,
    userMessage: message,
    fullPrompt: fullPrompt.value,
    leanPrompt: leanPrompt.value,
    contextWindowTokens
  });
  return budgeted.ok ? { ok: true, value: budgeted.value.prompt } : budgeted;
}

async function buildFullManagerProposalPrompt(repoRoot: string, message: string, specId: string, tool: string): Promise<SpecResult<string>> {
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) {
    return spec;
  }
  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }
  const plan = await loadTentativePlan(repoRoot, specId);
  const adapters = await listAdapterTools(repoRoot);
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const runStates = taskRunStatesForPrompt(status.value, events.value);

  return {
    ok: true,
    value: [
      "You are the Hivemind manager/orchestrator. You PROPOSE actions; deterministic Hivemind gates DISPOSE.",
      "",
      "Return exactly one JSON object and no prose outside it:",
      "{",
      "  \"reason\": \"short explanation of the next gated action sequence\",",
      "  \"human_approval_required_for\": [\"run_worker\", \"integrate_shadow\"],",
      "  \"actions\": [",
      "    {",
      "      \"type\": \"create_task_contract\",",
      "      \"contract\": {",
      "        \"task_id\": \"T-001\",",
      "        \"title\": \"Task title\",",
      "        \"agent_role\": \"builder\",",
      "        \"routing_task_type\": \"cli\",",
      "        \"base_commit\": \"exact plan base_commit\",",
      "        \"acceptance_criterion\": \"exact single criterion from the plan task\",",
      "        \"allowed_files\": [\"path/from/grounded_scope\"],",
      "        \"allowed_file_intents\": { \"path/from/grounded_scope\": \"create\" },",
      "        \"read_only_files\": [\"path/from/grounded_scope\"],",
      "        \"forbidden_files\": [],",
      "        \"allowed_symbols\": [],",
      "        \"forbidden_symbols\": [],",
      "        \"must_not_change\": [],",
      "        \"required_tests\": [\"test command from the plan task\"],",
      "        \"patch_requirements\": [\"requirement from the plan task\"]",
      "      }",
      "    },",
      "    { \"type\": \"request_lease\", \"task_id\": \"T-001\" },",
      "    { \"type\": \"check_write_intent\", \"task_id\": \"T-001\", \"intent\": { \"task_id\": \"T-001\", \"intended_files\": [\"...\"], \"intended_symbols\": [], \"possible_risks\": [], \"will_not_change\": [\"...\"] } },",
      "    { \"type\": \"create_worktree\", \"task_id\": \"T-001\" },",
      "    { \"type\": \"run_worker\", \"task_id\": \"T-001\", \"tool\": \"worker-tool\" },",
      "    { \"type\": \"submit_patch\", \"task_id\": \"T-001\" },",
      "    { \"type\": \"analyze_patch\", \"task_id\": \"T-001\" },",
      "    { \"type\": \"enqueue_patch\", \"task_id\": \"T-001\" },",
      "    { \"type\": \"integrate_shadow\" }",
      "  ]",
      "}",
      "",
      "Hard rules:",
      "- Do not mark anything ratified, approved, accepted, integrated, or passed. You are proposing actions only.",
      "- Do not output self_approved, ratified, gate_verdict, result, skip_gates, or any other proof-like field.",
      "- If the plan is missing or not ready, propose get_status and explain the blocking state in reason.",
      "- Every state-changing action must be one of the supported action JSON shapes listed above.",
      "- create_task_contract.contract must use the flat TaskContract schema exactly. Do not include mode, depends_on, scope, draft_scope, grounded_scope, grounding_evidence, scope_status, or critical_path_approved inside the contract.",
      "- For contract scopes, copy fields from the plan task's grounded_scope into allowed_files, allowed_file_intents, read_only_files, forbidden_files, and must_not_change.",
      "- Copy contract.routing_task_type exactly from the plan task's routing_task_type.",
      "- Set contract.base_commit to the tentative plan base_commit.",
      "- A run_worker action must be preceded by a check_write_intent action for that task in the proposed sequence unless the current durable status already proves a passed write-intent.",
      "- Patch status is event-derived. A present patch bundle is not submitted, analyzed, or accepted unless status.tasks[].patch.submitted/analyzed/accepted say so.",
      "- Never propose enqueue_patch unless durable status for that task shows patch.submitted === true, patch.analyzed === true, patch.accepted === true, and patch.verdict === \"accept\".",
      "- After a successful run_worker that creates a diff, the normal next actions are submit_patch, then analyze_patch, then enqueue_patch only if the analyzed accepted state appears in durable status.",
      "- Do not set allow_dangerous_adapter.",
      "- Put run_worker and integrate_shadow in human_approval_required_for whenever those actions appear.",
      "- Use only adapter tools that exist in the adapter_tools list.",
      "",
      `Manager adapter tool: ${tool}`,
      `User message: ${message}`,
      "",
      "Active ratified spec markdown:",
      spec.value.markdown,
      "",
      "Durable status JSON:",
      JSON.stringify(status.value, null, 2),
      "",
      "Durable task run states JSON:",
      JSON.stringify(runStates, null, 2),
      "",
      "Recent durable event trail JSON:",
      JSON.stringify(managerContextEvents(events.value).slice(-30), null, 2),
      "",
      "Tentative plan JSON or missing state:",
      plan.ok ? JSON.stringify(plan.value, null, 2) : JSON.stringify({ missing: true, reason: plan.reason }, null, 2),
      "",
      "Adapter tools JSON:",
      JSON.stringify(adapters, null, 2)
    ].join("\n")
  };
}

async function buildLeanManagerProposalPrompt(repoRoot: string, message: string, specId: string, tool: string): Promise<SpecResult<string>> {
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) {
    return spec;
  }
  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }
  const plan = await loadTentativePlan(repoRoot, specId);
  const adapters = await listAdapterTools(repoRoot);
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const runStates = taskRunStatesForPrompt(status.value, events.value);

  return {
    ok: true,
    value: [
      "You are the Hivemind manager/orchestrator. You PROPOSE actions; deterministic Hivemind gates DISPOSE.",
      "Context rehydration mode: lean.",
      "The previous working set exceeded the metered context budget, so Hivemind checkpointed a working-set manifest and rebuilt this prompt from disk.",
      "Never trust an orchestrator snapshot or conversation summary for authoritative state. Authoritative state below was freshly read from .hivemind/ for this invocation.",
      "",
      "Return exactly one JSON object and no prose outside it:",
      "{ \"reason\": \"short explanation of the next gated action sequence\", \"human_approval_required_for\": [], \"actions\": [{ \"type\": \"get_status\" }] }",
      "",
      "Hard rules:",
      "- Do not mark anything ratified, approved, accepted, integrated, or passed. You are proposing actions only.",
      "- Do not output self_approved, ratified, gate_verdict, result, skip_gates, or any other proof-like field.",
      "- Every state-changing action must be one of the supported action JSON shapes from the non-lean manager contract.",
      "- A present patch bundle is not submitted, analyzed, or accepted unless status.tasks[].patch.submitted/analyzed/accepted say so.",
      "- Never propose enqueue_patch unless durable status for that task shows patch.submitted === true, patch.analyzed === true, patch.accepted === true, and patch.verdict === \"accept\".",
      "- Put run_worker and integrate_shadow in human_approval_required_for whenever those actions appear.",
      "",
      `Manager adapter tool: ${tool}`,
      `User message: ${message}`,
      "",
      "Spec ref and title:",
      JSON.stringify({ spec_id: specId, title: spec.value.title, status: spec.value.status, path: `.hivemind/spec/${specId}.md` }, null, 2),
      "",
      "Durable status JSON (freshly read from .hivemind/):",
      JSON.stringify(status.value, null, 2),
      "",
      "Durable task run states JSON (freshly derived from .hivemind/log/events.jsonl):",
      JSON.stringify(runStates, null, 2),
      "",
      "Recent durable event trail JSON (freshly read from .hivemind/log/events.jsonl):",
      JSON.stringify(managerContextEvents(events.value).slice(-12), null, 2),
      "",
      "Tentative plan ref and task summary from disk:",
      plan.ok
        ? JSON.stringify(
            {
              path: `.hivemind/plans/${specId}.tentative.json`,
              base_commit: plan.value.base_commit,
              task_count: plan.value.tasks.length,
              tasks: plan.value.tasks.map((task) => ({
                task_id: task.task_id,
                title: task.title,
                depends_on: task.depends_on,
                acceptance_criterion: task.acceptance_criterion,
                required_tests: task.required_tests,
                grounded_scope: task.grounded_scope
              })),
              execution_groups: plan.value.execution_groups
            },
            null,
            2
          )
        : JSON.stringify({ missing: true, reason: plan.reason }, null, 2),
      "",
      "Adapter tools JSON:",
      JSON.stringify(adapters, null, 2)
    ].join("\n")
  };
}

function taskRunStatesForPrompt(status: HivemindStatus, events: HivemindEvent[]): Record<string, { state: string }> {
  return Object.fromEntries(status.tasks.map((task) => [task.task_id, { state: latestTaskRunState(events, task.task_id).state }]));
}

async function buildRedirectCorrectionPrompt(
  repoRoot: string,
  action: Extract<ManagerAction, { type: "check_write_intent" }>,
  rejectionReason: string
): Promise<SpecResult<string>> {
  const contract = await loadAndValidateContract(repoRoot, action.task_id);
  if (!contract.ok) {
    return { ok: false, reason: contract.reason };
  }
  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }

  return {
    ok: true,
    value: [
      "You are the Hivemind orchestrator acting as a COACH, not the safety referee.",
      "A deterministic write-intent gate has already refused the worker's out-of-scope intent.",
      "Your job is to propose a useful, drift-specific correction so the worker can re-declare an in-scope intent.",
      "",
      "Return exactly one JSON object and no prose outside it:",
      "{ \"correction\": \"specific coaching message for the worker\" }",
      "",
      "Hard rules:",
      "- Do not approve the intent, widen scope, change leases, change config, or claim a gate passed.",
      "- Do not tell the worker to touch files outside the contract.",
      "- Name the offending file(s) and point back to the allowed lease/scope when possible.",
      "- Be concrete enough that a worker can continue without a full cancel/restart.",
      "",
      `Task: ${action.task_id}`,
      `Deterministic rejection reason: ${rejectionReason}`,
      "",
      "Rejected write-intent JSON:",
      JSON.stringify(action.intent, null, 2),
      "",
      "Task contract JSON:",
      JSON.stringify(contract.contract, null, 2),
      "",
      "Current durable status JSON:",
      JSON.stringify(status.value, null, 2),
      "",
      "Recent durable event trail JSON:",
      JSON.stringify(events.value.filter((event) => event.task_id === action.task_id).slice(-20), null, 2)
    ].join("\n")
  };
}

function parseRedirectCorrection(stdout: string): SpecResult<string> {
  const extracted = extractJsonObject(stdout, "redirect correction");
  if (!extracted.ok) {
    return extracted;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted.value);
  } catch {
    return { ok: false, reason: "redirect correction output was not valid JSON" };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "redirect correction must be a JSON object" };
  }
  const allowedKeys = new Set(["correction"]);
  const unsupported = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    return { ok: false, reason: `redirect correction contains unsupported proof/control fields: ${unsupported.join(", ")}` };
  }
  if (typeof raw.correction !== "string" || raw.correction.trim() === "") {
    return { ok: false, reason: "redirect correction requires a non-empty correction" };
  }
  return { ok: true, value: raw.correction.trim() };
}

async function listAdapterTools(repoRoot: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(repoRoot, ".hivemind", "adapters"));
    return names
      .filter((name) => name.endsWith(".profile.json"))
      .map((name) => name.slice(0, -".profile.json".length))
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function parseGeneratedManagerProposal(stdout: string): SpecResult<ManagerProposedAction> {
  const extracted = extractJsonObject(stdout, "manager proposal");
  if (!extracted.ok) {
    return extracted;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted.value);
  } catch {
    return { ok: false, reason: "manager proposal output was not valid JSON" };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "manager proposal must be a JSON object" };
  }
  const allowedKeys = new Set(["reason", "actions", "human_approval_required_for"]);
  const unsupported = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    return { ok: false, reason: `manager proposal contains unsupported proof/control fields: ${unsupported.join(", ")}` };
  }
  if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
    return { ok: false, reason: "manager proposal requires a non-empty reason" };
  }
  const actions = parseManagerActionList(raw.actions, "manager proposal actions");
  if (!actions.ok) {
    return actions;
  }
  const approval = parseHumanApprovalList(raw.human_approval_required_for);
  if (!approval.ok) {
    return approval;
  }
  const actionValidation = validateGeneratedManagerActions(actions.value, approval.value);
  if (!actionValidation.ok) {
    return actionValidation;
  }
  return {
    ok: true,
    value: {
      type: "proposed_actions",
      source: "adapter-generated",
      reason: raw.reason.trim(),
      actions: actions.value,
      human_approval_required_for: approval.value
    }
  };
}

function parseHumanApprovalList(raw: unknown): SpecResult<ManagerAction["type"][]> {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "manager proposal requires human_approval_required_for array" };
  }
  const values: ManagerAction["type"][] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || !isManagerActionType(entry)) {
      return { ok: false, reason: `human_approval_required_for[${index}] must be a supported manager action type` };
    }
    if (!values.includes(entry)) {
      values.push(entry);
    }
  }
  return { ok: true, value: values };
}

function validateGeneratedManagerActions(actions: ManagerAction[], approvals: ManagerAction["type"][]): SpecResult<void> {
  for (const action of actions) {
    if (action.type === "admit_value_quality") {
      return { ok: false, reason: "autonomous manager must not propose value-quality admission; quality strategies are human-triggered on demand" };
    }
    if (action.type === "run_worker") {
      if (action.allow_dangerous_adapter === true) {
        return { ok: false, reason: "manager proposal must not set allow_dangerous_adapter" };
      }
      if (!approvals.includes("run_worker")) {
        return { ok: false, reason: "manager proposal with run_worker must list run_worker in human_approval_required_for" };
      }
    }
    if (action.type === "integrate_shadow" && !approvals.includes("integrate_shadow")) {
      return { ok: false, reason: "manager proposal with integrate_shadow must list integrate_shadow in human_approval_required_for" };
    }
  }
  return { ok: true, value: undefined };
}

function scriptedManagerProposal(actions: ManagerAction[]): ManagerProposedAction {
  return {
    type: "proposed_actions",
    source: "scripted",
    reason: "No-paid manager loop executing a pre-supplied action script through the deterministic manager executor.",
    actions,
    human_approval_required_for: []
  };
}

interface ManagerAutonomyRuntimePolicy {
  tier2Actions: Set<ManagerAction["type"]>;
  costThreshold: {
    estimated_requests: number;
    wall_time_ms?: number;
  };
  redirectLimit: number;
}

async function loadManagerAutonomyPolicy(repoRoot: string): Promise<SpecResult<ManagerAutonomyRuntimePolicy>> {
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }
  const configuredTier2 = config.config.manager_autonomy?.tier2_actions;
  const tier2Actions = configuredTier2 === undefined ? ["run_worker", "integrate_shadow"] : configuredTier2;
  const invalid = tier2Actions.find((action) => !isManagerActionType(action));
  if (invalid !== undefined) {
    return { ok: false, reason: `manager_autonomy.tier2_actions contains unsupported manager action type: ${invalid}` };
  }

  return {
    ok: true,
    value: {
      tier2Actions: new Set(tier2Actions as ManagerAction["type"][]),
      costThreshold: {
        estimated_requests: config.config.manager_autonomy?.cost_threshold?.estimated_requests ?? 0,
        ...("wall_time_ms" in (config.config.manager_autonomy?.cost_threshold ?? {})
          ? { wall_time_ms: config.config.manager_autonomy?.cost_threshold?.wall_time_ms }
          : {})
      },
      redirectLimit: config.config.manager_autonomy?.redirect_limit ?? 2
    }
  };
}

async function classifyManagerAction(
  repoRoot: string,
  action: ManagerAction,
  policy: ManagerAutonomyRuntimePolicy
): Promise<ActionClassification> {
  if (policy.tier2Actions.has(action.type)) {
    return humanApprovalClassification(action, `action ${action.type} is configured as high-risk/consequential`);
  }

  const cost = estimateManagerActionCost(action);
  if (cost.estimated_requests > policy.costThreshold.estimated_requests) {
    return humanApprovalClassification(
      action,
      `action ${action.type} estimated provider requests ${cost.estimated_requests} exceeds configured autonomous threshold ${policy.costThreshold.estimated_requests}`
    );
  }
  if (policy.costThreshold.wall_time_ms !== undefined && cost.wall_time_ms !== undefined && cost.wall_time_ms > policy.costThreshold.wall_time_ms) {
    return humanApprovalClassification(
      action,
      `action ${action.type} estimated wall time ${cost.wall_time_ms}ms exceeds configured autonomous threshold ${policy.costThreshold.wall_time_ms}ms`
    );
  }

  const critical = await actionTouchesCriticalScope(repoRoot, action);
  if (!critical.ok) {
    return humanApprovalClassification(action, critical.reason);
  }
  if (critical.value) {
    return humanApprovalClassification(action, `action ${action.type} touches Critical-tier scope`);
  }

  return {
    tier: "autonomous",
    reason: `action ${action.type} is Tier 1 and may run after deterministic checks pass`,
    recommendation: "Proceed through the deterministic manager executor."
  };
}

function humanApprovalClassification(action: ManagerAction, reason: string): ActionClassification {
  return {
    tier: "human_approval",
    reason,
    recommendation: `Pause and ask the human to approve, modify, or reject ${action.type}; do not execute it autonomously.`
  };
}

function estimateManagerActionCost(action: ManagerAction): { estimated_requests: number; wall_time_ms?: number } {
  return action.type === "run_worker" || action.type === "scout_task" ? { estimated_requests: 1 } : { estimated_requests: 0 };
}

async function actionTouchesCriticalScope(repoRoot: string, action: ManagerAction): Promise<SpecResult<boolean>> {
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }
  const contract = await contractForAction(repoRoot, action);
  if (!contract.ok) {
    return contract.reason === "no-contract-scope" ? { ok: true, value: false } : contract;
  }
  return { ok: true, value: inferTaskTier(contract.value, config.config) === "critical" };
}

async function contractForAction(repoRoot: string, action: ManagerAction): Promise<SpecResult<TaskContract> | { ok: false; reason: "no-contract-scope" }> {
  if (action.type === "create_task_contract") {
    const problems = validateContract(action.contract);
    if (problems.length > 0) {
      return { ok: false, reason: "no-contract-scope" };
    }
    return { ok: true, value: normalizeContract(action.contract) };
  }
  if ("task_id" in action) {
    const loaded = await loadAndValidateContract(repoRoot, action.task_id);
    if (!loaded.ok) {
      return { ok: false, reason: "no-contract-scope" };
    }
    return { ok: true, value: loaded.contract };
  }
  return { ok: false, reason: "no-contract-scope" };
}

function buildGateRejectionAdvice(action: ManagerAction, reason: string): ManagerStopAdvice {
  return {
    reason,
    diagnosis: `The deterministic gate rejected ${action.type}; this is a Tier 3 hard stop, not a prompt for autonomous retry.`,
    options: [
      "Change the work through a human-approved re-plan or narrower scope if the plan is wrong.",
      "Inspect the deterministic rejection reason and fix the underlying task, lease, intent, patch, or tests.",
      "Do not change provider tiers, risk config, safety rules, or approval policy inside the autonomous loop to force this action through."
    ],
    recommendation: "Stop the loop and ask the human which option to take."
  };
}

function isRedirectableWriteIntentRejection(action: ManagerAction, result: ManagerActionExecutionRecord): action is Extract<ManagerAction, { type: "check_write_intent" }> {
  return action.type === "check_write_intent" && result.ok === false && result.reason.startsWith("write intent rejected:");
}

async function handleWriteIntentRedirect(
  repoRoot: string,
  session: ManagerSession,
  action: Extract<ManagerAction, { type: "check_write_intent" }>,
  rejectionReason: string,
  tool: string,
  policy: ManagerAutonomyRuntimePolicy
): Promise<SpecResult<{ kind: "redirected"; step: ManagerRedirectStep } | { kind: "replan"; stop: ManagerStopAdvice }>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const priorRedirects = events.value.filter((event) => event.type === "task.redirected" && event.task_id === action.task_id).length;
  if (priorRedirects >= policy.redirectLimit) {
    const replan = await routeMutatingAction(repoRoot, "/plan/thrash", { spec_id: session.spec_id, task_id: action.task_id, budget: 1 }, () =>
      evaluatePlanThrash(repoRoot, session.spec_id, action.task_id, 1)
    );
    if (!replan.ok) {
      return replan;
    }
    return {
      ok: true,
      value: {
        kind: "replan",
        stop: {
          reason: `redirect limit exhausted for ${action.task_id}; re-plan status ${String(replan.value.status)}`,
          diagnosis:
            "Repeated write-intent rejections are treated as planning thrash, not a reason to coach forever or cancel immediately.",
          options: [
            "Re-scope the task so the needed file is explicitly accounted for.",
            "Split or re-sequence the task if the worker is reaching across dependency boundaries.",
            "Escalate to the human/spec owner if the existing scope is correct and the worker keeps ignoring it."
          ],
          recommendation: "Stop the loop and handle the re-plan record before retrying this task."
        }
      }
    };
  }

  const correction = await generateRedirectCorrection(repoRoot, tool, action, rejectionReason, session.session_id);
  if (!correction.ok) {
    return correction;
  }
  const attempt = priorRedirects + 1;
  const request = { task_id: action.task_id, correction: correction.value, source: "manager" as const };
  const recorded = await routeMutatingAction(repoRoot, "/supervision/redirect", request, () => requestTaskRedirect(repoRoot, request));
  if (!recorded.ok) {
    return recorded;
  }
  return {
    ok: true,
    value: {
      kind: "redirected",
      step: {
        attempt,
        max_attempts: policy.redirectLimit,
        correction: correction.value,
        event_types: ["task.revision_requested", "task.redirected"]
      }
    }
  };
}

function buildReactiveProposalMessage(session: ManagerSession): string {
  const last = session.executed_actions.at(-1);
  if (last === undefined) {
    return "Reactive manager loop: propose exactly the next single manager action from current durable state.";
  }
  return [
    "Reactive manager loop: propose exactly the next single manager action from current durable state.",
    `Last manager observation: action ${last.type} returned ${last.result.ok ? "ok" : "rejected"}.`,
    `Last result JSON: ${JSON.stringify(last.result)}`,
    "Run pipeline rule: run_worker returning started means only that the daemon accepted the worker job. Do not propose submit_patch until durable state has a task.completed event and a patch bundle.",
    "Patch pipeline rule: enqueue_patch is allowed only after a real submit_patch event and a real analyze_patch accepted event. If a task has a patch bundle but submitted/analyzed/accepted are not all true, propose submit_patch or analyze_patch as the next missing step.",
    "Redirect rule: if the last action was check_write_intent and durable events include task.redirected, propose a corrected in-scope check_write_intent. Do not repeat the rejected intent.",
    "If the task is done or blocked awaiting human action, return an empty actions array.",
    "Do not propose any action that changes config, provider tier metadata, safety rules, approval policy, or deterministic gates to get around a rejection."
  ].join("\n");
}

function appendProposalToSession(session: ManagerSession, proposal: ManagerProposedAction): ManagerSession {
  return {
    ...session,
    proposed_action: proposal,
    turns: [
      ...session.turns,
      {
        role: "manager",
        content: `proposed next action: ${proposal.actions[0]?.type ?? "none"} - ${proposal.reason}`
      }
    ]
  };
}

export async function executeManagerActionFromFile(
  repoRoot: string,
  sessionId: string,
  actionFile: string
): Promise<SpecResult<ManagerActionResult>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(actionFile, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "manager action file must contain valid JSON" };
    }
    throw error;
  }

  const action = parseManagerAction(raw);
  if (!action.ok) {
    return action;
  }
  return executeManagerAction(repoRoot, sessionId, action.value);
}

export async function runNoPaidManagerLoopFromFile(
  repoRoot: string,
  message: string,
  actionsFile: string
): Promise<SpecResult<ManagerLoopResult>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(actionsFile, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "fake-manager action file must contain valid JSON" };
    }
    throw error;
  }

  const actions = parseManagerActionList(raw);
  if (!actions.ok) {
    return actions;
  }
  return runNoPaidManagerLoop(repoRoot, message, actions.value);
}

export async function runNoPaidManagerLoop(
  repoRoot: string,
  message: string,
  actions: ManagerAction[]
): Promise<SpecResult<ManagerLoopResult>> {
  const session = await startManagerSession(repoRoot, message, { proposedAction: scriptedManagerProposal(actions) });
  if (!session.ok) {
    return session;
  }

  const steps: ManagerLoopResult["steps"] = [];
  for (const [index, action] of actions.entries()) {
    const result = await executeManagerAction(repoRoot, session.value.session_id, action);
    if (!result.ok) {
      return result;
    }
    steps.push({
      index,
      action_type: result.value.action_type,
      result: result.value.result
    });
    if (!result.value.result.ok) {
      const status = await getStatus(repoRoot);
      return status.ok
        ? {
            ok: true,
            value: {
              session_id: session.value.session_id,
              session_path: session.value.session_path,
              status: "failed",
              steps,
              final_status: status.value
            }
          }
        : status;
    }
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }
  return {
    ok: true,
    value: {
      session_id: session.value.session_id,
      session_path: session.value.session_path,
      status: "passed",
      steps,
      final_status: status.value
    }
  };
}

export async function runAutonomousManagerLoop(
  repoRoot: string,
  message: string,
  options: AutonomousLoopOptions
): Promise<SpecResult<ManagerAutonomousLoopResult>> {
  const session = await startManagerSession(repoRoot, message, { tool: options.tool });
  if (!session.ok) {
    return session;
  }
  return continueAutonomousManagerLoop(repoRoot, session.value.session_id, options, session.value.proposed_action);
}

export async function continueAutonomousManagerLoop(
  repoRoot: string,
  sessionId: string,
  options: AutonomousLoopOptions,
  initialProposal?: ManagerProposedAction
): Promise<SpecResult<ManagerAutonomousLoopResult>> {
  const policy = await loadManagerAutonomyPolicy(repoRoot);
  if (!policy.ok) {
    return policy;
  }

  const steps: ManagerAutonomousLoopResult["steps"] = [];
  let nextProposal = initialProposal;
  for (let index = 0; index < options.maxSteps; index += 1) {
    const session = await loadManagerSession(repoRoot, sessionId);
    if (!session.ok) {
      return session;
    }
    if (session.value.blocked_action !== undefined) {
      const status = await getStatus(repoRoot);
      if (!status.ok) return status;
      return {
        ok: true,
        value: {
          session_id: sessionId,
          session_path: managerSessionRelativePath(sessionId),
          status: "stopped",
          steps: [
            ...steps,
            {
              index,
              action_type: session.value.blocked_action.action_type,
              tier: "gate_rejection",
              result: session.value.blocked_action.result,
              stop: session.value.blocked_action.stop
            }
          ],
          final_status: status.value
        }
      };
    }
    let sessionForWrite = session.value;

    let action: ManagerAction;
    let classification: ActionClassification;
    if (session.value.pending_action !== undefined) {
      const status = await getStatus(repoRoot);
      if (!status.ok) {
        return status;
      }
      return {
        ok: true,
        value: {
          session_id: sessionId,
          session_path: managerSessionRelativePath(sessionId),
          status: "paused",
          steps: [
            ...steps,
            {
              index,
              action_type: session.value.pending_action.action_type,
              tier: "human_approval",
              pause: session.value.pending_action
            }
          ],
          final_status: status.value
        }
      };
    } else {
      if (nextProposal === undefined) {
        const generated = await generateManagerProposal(
          repoRoot,
          buildReactiveProposalMessage(session.value),
          options.tool,
          session.value.spec_id,
          session.value.session_id
        );
        if (!generated.ok) {
          return generated;
        }
        nextProposal = generated.value;
        sessionForWrite = appendProposalToSession(session.value, nextProposal);
        await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), sessionForWrite);
      }

      if (nextProposal.actions.length === 0) {
        const status = await getStatus(repoRoot);
        if (!status.ok) {
          return status;
        }
        return {
          ok: true,
          value: {
            session_id: sessionId,
            session_path: managerSessionRelativePath(sessionId),
            status: "completed",
            steps,
            final_status: status.value
          }
        };
      }

      action = nextProposal.actions[0];
      classification = await classifyManagerAction(repoRoot, action, policy.value);
      if (classification.tier === "human_approval") {
        const expectedState = await getStatus(repoRoot);
        if (!expectedState.ok) return expectedState;
        const pending: ManagerPendingAction = {
          pending_action_id: randomUUID(),
          action,
          action_type: action.type,
          subject: managerActionSubject(action),
          expected_state_hash: hashDurableState(expectedState.value),
          tier: "human_approval",
          reason: classification.reason,
          recommendation: classification.recommendation
        };
        await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), { ...sessionForWrite, proposed_action: nextProposal, pending_action: pending });
        const status = await getStatus(repoRoot);
        if (!status.ok) {
          return status;
        }
        return {
          ok: true,
          value: {
            session_id: sessionId,
            session_path: managerSessionRelativePath(sessionId),
            status: "paused",
            steps: [
              ...steps,
              {
                index,
                action_type: action.type,
                tier: "human_approval",
                pause: pending
              }
            ],
            final_status: status.value
          }
        };
      }
    }

    const result = await executeManagerAction(repoRoot, sessionId, action);
    if (!result.ok) {
      return result;
    }
    if (!result.value.result.ok) {
      if (isRedirectableWriteIntentRejection(action, result.value.result)) {
        const redirect = await handleWriteIntentRedirect(repoRoot, session.value, action, result.value.result.reason, options.tool, policy.value);
        if (!redirect.ok) {
          return redirect;
        }
        const status = await getStatus(repoRoot);
        if (!status.ok) {
          return status;
        }
        if (redirect.value.kind === "redirected") {
          steps.push({
            index,
            action_type: action.type,
            tier: "redirect",
            result: result.value.result,
            redirect: redirect.value.step
          });
          nextProposal = undefined;
          continue;
        }
        return {
          ok: true,
          value: {
            session_id: sessionId,
            session_path: managerSessionRelativePath(sessionId),
            status: "stopped",
            steps: [
              ...steps,
              {
                index,
                action_type: action.type,
                tier: "gate_rejection",
                result: result.value.result,
                stop: redirect.value.stop
              }
            ],
            final_status: status.value
          }
        };
      }
      const stop = buildGateRejectionAdvice(action, result.value.result.reason);
      const status = await getStatus(repoRoot);
      if (!status.ok) {
        return status;
      }
      return {
        ok: true,
        value: {
          session_id: sessionId,
          session_path: managerSessionRelativePath(sessionId),
          status: "stopped",
          steps: [
            ...steps,
            {
              index,
              action_type: action.type,
              tier: "gate_rejection",
              result: result.value.result,
              stop
            }
          ],
          final_status: status.value
        }
      };
    }

    steps.push({
      index,
      action_type: action.type,
      tier: classification.tier,
      result: result.value.result
    });
    nextProposal = undefined;
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }
  return {
    ok: true,
    value: {
      session_id: sessionId,
      session_path: managerSessionRelativePath(sessionId),
      status: "step_limit_reached",
      steps,
      final_status: status.value
    }
  };
}

export async function executeManagerAction(
  repoRoot: string,
  sessionId: string,
  action: ManagerAction
): Promise<SpecResult<ManagerActionResult>> {
  const sessionResult = await loadManagerSession(repoRoot, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }
  if (specResult.value.spec_id !== sessionResult.value.spec_id) {
    return { ok: false, reason: `manager session ${sessionId} belongs to spec ${sessionResult.value.spec_id}, not active spec ${specResult.value.spec_id}` };
  }

  const policy = await loadManagerAutonomyPolicy(repoRoot);
  if (!policy.ok) return policy;
  const classification = await classifyManagerAction(repoRoot, action, policy.value);
  if (classification.tier === "human_approval") {
    return {
      ok: false,
      reason: `manager action requires a daemon-issued pending action and exact typed approval: ${classification.reason}`
    };
  }

  return executeAuthorizedManagerAction(repoRoot, sessionResult.value, action);
}

async function executeAuthorizedManagerAction(
  repoRoot: string,
  session: ManagerSession,
  action: ManagerAction
): Promise<SpecResult<ManagerActionResult>> {

  const result = await executeDeterministicAction(repoRoot, session.session_id, action);
  const nextSession = appendActionToSession(session, action, result);
  const sessionPath = managerSessionPath(repoRoot, session.session_id);
  await writeJsonAtomic(sessionPath, nextSession);
  return {
    ok: true,
    value: {
      session_id: session.session_id,
      session_path: managerSessionRelativePath(session.session_id),
      action_type: action.type,
      result
    }
  };
}

export async function approvePendingManagerAction(
  repoRoot: string,
  request: unknown
): Promise<SpecResult<ManagerActionResult>> {
  if (!isRecord(request)) return { ok: false, reason: "manager approval must be a JSON object" };
  const allowed = new Set(["session_id", "pending_action_id", "action_type", "subject", "expected_state_hash"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { ok: false, reason: `manager approval contains unsupported authority field: ${extra[0]}` };
  for (const field of allowed) {
    if (typeof request[field] !== "string" || String(request[field]).trim() === "") {
      return { ok: false, reason: `manager approval ${field} must be a non-empty string` };
    }
  }
  const session = await loadManagerSession(repoRoot, request.session_id as string);
  if (!session.ok) return session;
  const pending = session.value.pending_action;
  if (pending === undefined) return { ok: false, reason: "manager approval refused: session has no pending action" };
  if (
    pending.pending_action_id !== request.pending_action_id ||
    pending.action_type !== request.action_type ||
    pending.subject !== request.subject ||
    pending.expected_state_hash !== request.expected_state_hash
  ) {
    return { ok: false, reason: "manager approval refused: typed action identity does not match the daemon-issued pending action" };
  }
  const parsedAction = parseManagerAction(pending.action);
  if (!parsedAction.ok || parsedAction.value.type !== pending.action_type || managerActionSubject(parsedAction.value) !== pending.subject) {
    return { ok: false, reason: "manager approval refused: pending action artifact is malformed or inconsistent" };
  }
  const status = await getStatus(repoRoot);
  if (!status.ok) return status;
  if (hashDurableState(status.value) !== pending.expected_state_hash) {
    return { ok: false, reason: "manager approval refused: durable state changed after the action was presented; review the refreshed action" };
  }
  const policy = await loadManagerAutonomyPolicy(repoRoot);
  if (!policy.ok) return policy;
  const classification = await classifyManagerAction(repoRoot, parsedAction.value, policy.value);
  if (classification.tier !== "human_approval") {
    return { ok: false, reason: "manager approval refused: pending action no longer requires human approval" };
  }
  const result = await executeAuthorizedManagerAction(repoRoot, session.value, parsedAction.value);
  if (!result.ok) return result;
  const refreshed = await loadManagerSession(repoRoot, session.value.session_id);
  if (!refreshed.ok) return refreshed;
  const blockedAction = result.value.result.ok
    ? undefined
    : {
        action_type: parsedAction.value.type,
        result: result.value.result,
        stop: buildGateRejectionAdvice(parsedAction.value, result.value.result.reason)
      };
  await writeJsonAtomic(managerSessionPath(repoRoot, session.value.session_id), {
    ...refreshed.value,
    pending_action: undefined,
    blocked_action: blockedAction
  });
  const recorded = await appendEvent(repoRoot, {
    type: "manager.action_approved",
    task_id: "task_id" in parsedAction.value ? parsedAction.value.task_id : null,
    data: {
      version: 1,
      pending_action_id: pending.pending_action_id,
      session_id: session.value.session_id,
      action_type: pending.action_type,
      subject: pending.subject,
      expected_state_hash: pending.expected_state_hash,
      result_ok: result.value.result.ok
    }
  });
  return recorded.ok ? result : recorded;
}

function hashDurableState(status: HivemindStatus): string {
  return createHash("sha256").update(JSON.stringify(status)).digest("hex");
}

function managerActionSubject(action: ManagerAction): string {
  return "task_id" in action ? action.task_id : action.type;
}

async function executeDeterministicAction(repoRoot: string, sessionId: string, action: ManagerAction): Promise<ManagerActionExecutionRecord> {
  if (action.type === "get_status") {
    return recordResult(await getStatus(repoRoot));
  }
  if (action.type === "create_task_contract") {
    return recordResult(await routeMutatingAction<CreateTaskContractResult>(repoRoot, "/contract/create", { contract: action.contract }, () => createTaskContract(repoRoot, action.contract)));
  }
  if (action.type === "request_lease") {
    return recordResult(await routeMutatingAction<LeaseGrantResult>(repoRoot, "/lease/request-contract", { task_id: action.task_id }, () => requestLeaseForContract(repoRoot, action.task_id)));
  }
  if (action.type === "check_write_intent") {
    return recordResult(
      await routeMutatingAction<WriteIntentPass>(
        repoRoot,
        "/intent/check",
        { task_id: action.task_id, intent: action.intent },
        () => checkWriteIntent(repoRoot, action.task_id, action.intent)
      )
    );
  }
  if (action.type === "create_worktree") {
    return recordResult(await routeMutatingAction<WorktreeResult>(repoRoot, "/worktree/create", { task_id: action.task_id }, () => createTaskWorktree(repoRoot, action.task_id)));
  }
  if (action.type === "run_worker") {
    const started = await routeMutatingAction<RunStartResult | RunResult>(
      repoRoot,
      "/run",
      {
        task_id: action.task_id,
        ...(action.tool === undefined ? {} : { tool: action.tool }),
        allow_dangerous_adapter: action.allow_dangerous_adapter === true,
        usage_session_id: sessionId
      },
      () =>
        runTask(repoRoot, action.task_id, action.tool, {
          allowDangerousAdapter: action.allow_dangerous_adapter === true,
          usageSessionId: sessionId
        })
    );
    if (!started.ok) {
      return recordResult(started);
    }
    return recordResult(await waitForTaskRunCompletion(repoRoot, action.task_id));
  }
  if (action.type === "scout_task") {
    return recordResult(
      await routeMutatingAction<ScoutResult>(
        repoRoot,
        "/scout/run",
        { task_id: action.task_id, tool: action.tool, usage_session_id: sessionId },
        () => runScout(repoRoot, action.task_id, action.tool, { usageSessionId: sessionId })
      )
    );
  }
  if (action.type === "submit_patch") {
    return recordResult(await routeMutatingAction<SubmitResult>(repoRoot, "/submit", { task_id: action.task_id }, () => submitTask(repoRoot, action.task_id)));
  }
  if (action.type === "analyze_patch") {
    return recordResult(await routeMutatingAction<unknown>(repoRoot, "/analyze", { task_id: action.task_id }, () => analyzeTask(repoRoot, action.task_id)));
  }
  if (action.type === "enqueue_patch") {
    return recordResult(
      await routeMutatingAction<EnqueueIntegrationPatchResult>(
        repoRoot,
        "/integration/enqueue",
        { task_id: action.task_id },
        () => enqueueIntegrationPatch(repoRoot, action.task_id)
      )
    );
  }
  if (action.type === "admit_value_quality") {
    return recordResult(
      await routeMutatingAction<ValueQualityAdmission>(
        repoRoot,
        "/quality/admit",
        {
          task_id: action.task_id,
          strategy: action.strategy,
          ...(action.n === undefined ? {} : { n: action.n })
        },
        () => admitValueQuality(repoRoot, action.task_id, {
          strategy: action.strategy,
          ...(action.n === undefined ? {} : { n: action.n })
        })
      )
    );
  }
  return recordResult(await routeMutatingAction<IntegrationStatus>(repoRoot, "/integrate/shadow", {}, () => integrateShadow(repoRoot)));
}

async function waitForTaskRunCompletion(repoRoot: string, taskId: string): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const timeoutMs = runWaitTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const events = await readEvents(repoRoot);
    if (!events.ok) {
      return events;
    }

    const state = latestTaskRunState(events.value, taskId);
    if (state.state === "completed") {
      const result = await runResultFromCompletedEvent(repoRoot, taskId, state.completed);
      if (!result.ok) {
        return result;
      }
      return { ok: true, value: result.value };
    }
    if (state.state === "failed") {
      const reason = typeof state.failed.data.reason === "string" ? state.failed.data.reason : "worker run failed";
      return { ok: false, reason: `task ${taskId} worker run failed: ${reason}` };
    }
    if (state.state === "cancelled") {
      const reason = typeof state.cancelled.data.reason === "string" ? state.cancelled.data.reason : "human stop requested";
      return { ok: false, reason: `task ${taskId} was cancelled: ${reason}` };
    }
    const quotaPause = latestQuotaPauseAfterLatestStart(events.value, taskId);
    if (quotaPause !== null) {
      const rerouteReason = typeof quotaPause.data.reroute_reason === "string" ? quotaPause.data.reroute_reason : "no eligible provider available";
      return { ok: false, reason: `task ${taskId} quota paused awaiting reset: ${rerouteReason}` };
    }

    await delay(500);
  }

  const reason = `timed out waiting for task.completed/task.failed for ${taskId} after ${timeoutMs}ms`;
  return recordRunWaitTimeout(repoRoot, taskId, reason);
}

async function recordRunWaitTimeout(repoRoot: string, taskId: string, reason: string): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const marked = await routeMutatingAction<RunFailureMarkResult>(
    repoRoot,
    "/run/mark-failed",
    { task_id: taskId, reason, source: "manager_wait_timeout" },
    () => markRunFailed(repoRoot, taskId, reason, { source: "manager_wait_timeout" })
  );
  if (!marked.ok) {
    return { ok: false, reason: `${reason}; failed to record durable task.failed event: ${marked.reason}` };
  }

  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const state = latestTaskRunState(events.value, taskId);
  if (state.state === "completed") {
    const result = await runResultFromCompletedEvent(repoRoot, taskId, state.completed);
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: result.value };
  }
  if (state.state === "failed") {
    const eventReason = typeof state.failed.data.reason === "string" ? state.failed.data.reason : reason;
    return { ok: false, reason: `task ${taskId} worker run failed: ${eventReason}` };
  }

  return { ok: false, reason: `${reason}; durable task.failed event was not observed after timeout reconciliation` };
}

function latestQuotaPauseAfterLatestStart(events: HivemindEvent[], taskId: string): HivemindEvent | null {
  let latestStartSeen = false;
  let pause: HivemindEvent | null = null;
  for (const event of events) {
    if (event.task_id !== taskId) {
      continue;
    }
    if (event.type === "task.started") {
      latestStartSeen = true;
      pause = null;
      continue;
    }
    if (!latestStartSeen) {
      continue;
    }
    if (event.type === "task.paused" && event.data.reason === "quota_exhausted") {
      pause = event;
      continue;
    }
    if (event.type === "task.completed" || event.type === "task.failed") {
      pause = null;
    }
  }
  return pause;
}

async function runResultFromCompletedEvent(
  repoRoot: string,
  taskId: string,
  event: HivemindEvent
): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const data = event.data;
  if (
    data.task_id !== taskId ||
    data.status !== "completed" ||
    typeof data.tool !== "string" ||
    typeof data.diff_path !== "string" ||
    typeof data.tool_exit !== "number" ||
    typeof data.changed_files !== "number"
  ) {
    return { ok: false, reason: `task.completed event for ${taskId} has invalid run result data` };
  }

  const diff = await statIfExists(data.diff_path);
  if (!diff.ok || !diff.value.isFile()) {
    return { ok: false, reason: `task.completed event for ${taskId} has no patch bundle diff.patch` };
  }

  return {
    ok: true,
    value: {
      task_id: taskId,
      status: "completed",
      tool: data.tool,
      diff_path: data.diff_path,
      tool_exit: data.tool_exit,
      changed_files: data.changed_files
    }
  };
}

function runWaitTimeoutMs(): number {
  const raw = process.env.HIVEMIND_RUN_WAIT_TIMEOUT_MS;
  if (raw === undefined) {
    return 30 * 60 * 1000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function statIfExists(filePath: string) {
  try {
    return { ok: true as const, value: await stat(filePath) };
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ok: false as const };
    }
    throw error;
  }
}

async function routeMutatingAction<T>(
  repoRoot: string,
  endpoint: string,
  body: Record<string, unknown>,
  direct: () => Promise<{ ok: true; value: T } | { ok: false; reason: string }>
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const daemonResult = await callDaemonIfConfigured<T>(repoRoot, endpoint, body);
  return daemonResult.routed ? daemonResult : direct();
}

function recordResult<T>(result: { ok: true; value: T } | { ok: false; reason: string }): ManagerActionExecutionRecord {
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
}

function appendActionToSession(session: ManagerSession, action: ManagerAction, result: ManagerActionExecutionRecord): ManagerSession {
  const actionRecord: ManagerExecutedAction = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: action.type,
    ...("task_id" in action ? { task_id: action.task_id } : {}),
    result
  };
  return {
    ...session,
    turns: [
      ...session.turns,
      {
        role: "manager",
        content: result.ok ? `executed ${action.type}: ok` : `executed ${action.type}: ${result.reason}`
      }
    ],
    executed_actions: [...session.executed_actions, actionRecord]
  };
}

export async function inspectLatestManagerSession(
  repoRoot: string,
  specId: string
): Promise<SpecResult<ManagerWorkspaceSession | null>> {
  let names: string[];
  try {
    names = await readdir(path.join(repoRoot, ".hivemind", "orchestrator", "sessions"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return { ok: true, value: null };
    throw error;
  }
  const sessions: ManagerSession[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const sessionId = name.slice(0, -".json".length);
    const loaded = await loadManagerSession(repoRoot, sessionId);
    if (!loaded.ok) return loaded;
    if (loaded.value.spec_id === specId) sessions.push(loaded.value);
  }
  const latest = sessions.sort((left, right) =>
    right.created_at.localeCompare(left.created_at) || right.session_id.localeCompare(left.session_id)
  )[0];
  if (latest === undefined) return { ok: true, value: null };
  const pending = latest.pending_action ?? null;
  const blockedReason = latest.blocked_action?.result.reason ?? null;
  return {
    ok: true,
    value: {
      session_id: latest.session_id,
      spec_id: latest.spec_id,
      created_at: latest.created_at,
      status: pending !== null ? "paused" : blockedReason !== null ? "stopped" : latest.proposed_action.actions.length === 0 ? "complete" : "active",
      tool: latest.proposed_action.tool ?? "manager",
      call_count: latest.turns.filter((turn) => turn.role === "manager").length,
      pending_action: pending,
      blocked_reason: blockedReason
    }
  };
}

async function loadManagerSession(repoRoot: string, sessionId: string): Promise<SpecResult<ManagerSession>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    return { ok: false, reason: "manager session id must be a UUID" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(managerSessionPath(repoRoot, sessionId), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `manager session not found: ${managerSessionRelativePath(sessionId)}` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${managerSessionRelativePath(sessionId)}` };
    }
    throw error;
  }

  return validateManagerSession(parsed, sessionId);
}

function validateManagerSession(value: unknown, sessionId: string): SpecResult<ManagerSession> {
  if (!isRecord(value)) {
    return { ok: false, reason: "manager session must be a JSON object" };
  }
  if (value.version !== 1) {
    return { ok: false, reason: "manager session version must be 1" };
  }
  if (value.session_id !== sessionId) {
    return { ok: false, reason: "manager session id does not match requested session" };
  }
  if (typeof value.spec_id !== "string" || value.spec_id.trim() === "") {
    return { ok: false, reason: "manager session spec_id must be a string" };
  }
  if (!Array.isArray(value.turns)) {
    return { ok: false, reason: "manager session turns must be an array" };
  }
  if (!Array.isArray(value.executed_actions)) {
    return { ok: false, reason: "manager session executed_actions must be an array" };
  }
  if (value.pending_action !== undefined) {
    if (!isRecord(value.pending_action)) return { ok: false, reason: "manager pending_action must be an object" };
    const pending = value.pending_action;
    const action = parseManagerAction(pending.action);
    if (
      !action.ok ||
      typeof pending.pending_action_id !== "string" ||
      typeof pending.action_type !== "string" ||
      pending.action_type !== action.value.type ||
      typeof pending.subject !== "string" ||
      pending.subject !== managerActionSubject(action.value) ||
      typeof pending.expected_state_hash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(pending.expected_state_hash) ||
      pending.tier !== "human_approval" ||
      typeof pending.reason !== "string" ||
      typeof pending.recommendation !== "string"
    ) {
      return { ok: false, reason: "manager pending_action is malformed or internally inconsistent" };
    }
  }
  if (value.blocked_action !== undefined) {
    if (!isRecord(value.blocked_action)) return { ok: false, reason: "manager blocked_action must be an object" };
    const blocked = value.blocked_action;
    if (
      typeof blocked.action_type !== "string" ||
      !isManagerActionType(blocked.action_type) ||
      !isRecord(blocked.result) ||
      blocked.result.ok !== false ||
      typeof blocked.result.reason !== "string" ||
      !isRecord(blocked.stop) ||
      typeof blocked.stop.reason !== "string" ||
      typeof blocked.stop.diagnosis !== "string" ||
      !Array.isArray(blocked.stop.options) ||
      !blocked.stop.options.every((entry) => typeof entry === "string") ||
      typeof blocked.stop.recommendation !== "string"
    ) {
      return { ok: false, reason: "manager blocked_action is malformed or internally inconsistent" };
    }
  }
  return { ok: true, value: value as unknown as ManagerSession };
}

function parseManagerAction(raw: unknown): SpecResult<ManagerAction> {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return { ok: false, reason: "manager action must be a JSON object with a string type" };
  }
  if (raw.type === "get_status" || raw.type === "integrate_shadow") {
    return Object.keys(raw).length === 1 ? { ok: true, value: { type: raw.type } } : { ok: false, reason: `${raw.type} action must not include extra fields` };
  }
  if (raw.type === "create_task_contract") {
    return isRecord(raw.contract) && Object.keys(raw).length === 2
      ? { ok: true, value: { type: "create_task_contract", contract: raw.contract } }
      : { ok: false, reason: "create_task_contract action requires only a contract object" };
  }
  if (raw.type === "check_write_intent") {
    return typeof raw.task_id === "string" && isRecord(raw.intent) && Object.keys(raw).every((key) => key === "type" || key === "task_id" || key === "intent")
      ? { ok: true, value: { type: "check_write_intent", task_id: raw.task_id, intent: raw.intent } }
      : { ok: false, reason: "check_write_intent action requires only task_id and intent object" };
  }
  if (raw.type === "admit_value_quality") {
    const allowedKeys = new Set(["type", "task_id", "strategy", "n"]);
    if (
      typeof raw.task_id !== "string" ||
      (raw.strategy !== "best_of_n" && raw.strategy !== "draft_refine") ||
      (raw.n !== undefined && !Number.isSafeInteger(raw.n)) ||
      Object.keys(raw).some((key) => !allowedKeys.has(key))
    ) {
      return { ok: false, reason: "admit_value_quality action accepts task_id, strategy, and optional integer n only" };
    }
    return {
      ok: true,
      value: {
        type: "admit_value_quality",
        task_id: raw.task_id,
        strategy: raw.strategy,
        ...(raw.n === undefined ? {} : { n: Number(raw.n) })
      }
    };
  }
  if (isTaskActionType(raw.type)) {
    if (typeof raw.task_id !== "string") {
      return { ok: false, reason: `${raw.type} action requires task_id` };
    }
    if (raw.type === "scout_task") {
      const allowedKeys = new Set(["type", "task_id", "tool"]);
      return typeof raw.tool === "string" && raw.tool.trim() !== "" && Object.keys(raw).every((key) => allowedKeys.has(key))
        ? { ok: true, value: { type: "scout_task", task_id: raw.task_id, tool: raw.tool } }
        : { ok: false, reason: "scout_task action accepts task_id and non-empty tool" };
    }
    if (raw.type === "run_worker") {
      if (!validOptionalString(raw.tool) || (raw.allow_dangerous_adapter !== undefined && typeof raw.allow_dangerous_adapter !== "boolean")) {
        return { ok: false, reason: "run_worker action accepts task_id, optional tool, and optional allow_dangerous_adapter" };
      }
      const allowedKeys = new Set(["type", "task_id", "tool", "allow_dangerous_adapter"]);
      return Object.keys(raw).every((key) => allowedKeys.has(key))
        ? { ok: true, value: { type: "run_worker", task_id: raw.task_id, ...(raw.tool === undefined ? {} : { tool: raw.tool }), allow_dangerous_adapter: raw.allow_dangerous_adapter === true } }
        : { ok: false, reason: "run_worker action contains an unsupported field" };
    }
    return Object.keys(raw).length === 2
      ? { ok: true, value: { type: raw.type, task_id: raw.task_id } }
      : { ok: false, reason: `${raw.type} action contains an unsupported field` };
  }
  return { ok: false, reason: `unknown manager action type: ${raw.type}` };
}

function parseManagerActionList(raw: unknown, label = "fake-manager action file"): SpecResult<ManagerAction[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${label} must contain a JSON array` };
  }
  const actions: ManagerAction[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseManagerAction(entry);
    if (!parsed.ok) {
      const prefix = label === "fake-manager action file" ? "fake-manager action" : label;
      return { ok: false, reason: `${prefix}[${index}]: ${parsed.reason}` };
    }
    actions.push(parsed.value);
  }
  return { ok: true, value: actions };
}

function isManagerActionType(value: string): value is ManagerAction["type"] {
  return value === "get_status" || value === "integrate_shadow" || value === "admit_value_quality" || isTaskActionType(value) || value === "create_task_contract" || value === "check_write_intent";
}

function isTaskActionType(value: string): value is "request_lease" | "create_worktree" | "scout_task" | "run_worker" | "submit_patch" | "analyze_patch" | "enqueue_patch" {
  return (
    value === "request_lease" ||
    value === "create_worktree" ||
    value === "scout_task" ||
    value === "run_worker" ||
    value === "submit_patch" ||
    value === "analyze_patch" ||
    value === "enqueue_patch"
  );
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function managerSessionPath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, managerSessionRelativePath(sessionId));
}

function managerSessionRelativePath(sessionId: string): string {
  return `.hivemind/orchestrator/sessions/${sessionId}.json`;
}

function parseManagerArgs(
  args: string[]
): SpecResult<
  | { mode: "message"; message: string; tool?: string }
  | { mode: "auto-message"; message: string; tool: string; maxSteps: number }
  | { mode: "auto-session"; sessionId: string; tool: string; maxSteps: number }
  | { mode: "action"; sessionId: string; actionFile: string }
  | { mode: "fake-loop"; message: string; actionsFile: string }
> {
  if (args[0] === "--message" && typeof args[1] === "string" && args[2] === "--tool" && typeof args[3] === "string" && args[4] === "--auto-loop") {
    const options = parseAutoLoopOptions(args.slice(5));
    if (!options.ok) {
      return options;
    }
    return {
      ok: true,
      value: {
        mode: "auto-message",
        message: args[1],
        tool: args[3],
        maxSteps: options.value.maxSteps
      }
    };
  }
  if (args[0] === "--message" && typeof args[1] === "string" && args.length === 2) {
    return { ok: true, value: { mode: "message", message: args[1] } };
  }
  if (args[0] === "--message" && typeof args[1] === "string" && args[2] === "--tool" && typeof args[3] === "string" && args.length === 4) {
    return { ok: true, value: { mode: "message", message: args[1], tool: args[3] } };
  }
  if (args[0] === "--message" && typeof args[1] === "string" && args[2] === "--fake-manager" && typeof args[3] === "string" && args.length === 4) {
    return { ok: true, value: { mode: "fake-loop", message: args[1], actionsFile: args[3] } };
  }
  if (args[0] === "--session" && typeof args[1] === "string" && args[2] === "--action" && typeof args[3] === "string" && args.length === 4) {
    return { ok: true, value: { mode: "action", sessionId: args[1], actionFile: args[3] } };
  }
  if (args[0] === "--session" && typeof args[1] === "string" && args[2] === "--auto-loop" && args[3] === "--tool" && typeof args[4] === "string") {
    const options = parseAutoLoopOptions(args.slice(5));
    if (!options.ok) {
      return options;
    }
    return {
      ok: true,
      value: {
        mode: "auto-session",
        sessionId: args[1],
        tool: args[4],
        maxSteps: options.value.maxSteps
      }
    };
  }
  return {
    ok: false,
    reason:
      "usage: hivemind manager --message <message> [--tool <tool>] [--fake-manager <actions-json-file>] | --message <message> --tool <tool> --auto-loop [--max-steps <n>] | --session <session_id> --auto-loop --tool <tool> [--max-steps <n>] | --session <session_id> --action <action-json-file>"
  };
}

function parseAutoLoopOptions(args: string[]): SpecResult<{ maxSteps: number }> {
  let maxSteps = 20;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--max-steps" && typeof value === "string") {
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { ok: false, reason: "--max-steps must be a positive safe integer" };
      }
      maxSteps = parsed;
      continue;
    }
    return { ok: false, reason: `unknown autonomous manager option: ${flag ?? ""}` };
  }
  return { ok: true, value: { maxSteps } };
}

function managerContextEvents(events: HivemindEvent[]): HivemindEvent[] {
  return events.filter((event) => event.type !== "human.guidance_recorded" && event.type !== "human.guidance_consumed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
