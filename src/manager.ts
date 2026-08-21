import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeTask } from "./analyze.js";
import { writeJsonAtomic } from "./atomic.js";
import { DEFAULT_AUTONOMY_LEVEL, isAutonomyLevel, type AutonomyLevel } from "./autonomy-level.js";
import { readProjectAutonomyLevel, recordAutonomyDecision } from "./autonomy.js";
import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  runAdapterProcess
} from "./adapter.js";
import { DEFAULT_MAX_CONCURRENT_WORKERS, loadConfig } from "./config.js";
import { createTaskContract, type CreateTaskContractResult } from "./contract.js";
import { loadAndValidateContract, normalizeAllowedFileIntents, normalizeContract, validateContract, type TaskContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { formatErrorDetail } from "./error-detail.js";
import {
  captureIntegrationQueueExpectation,
  enqueueIntegrationPatch,
  integrateShadow,
  type EnqueueIntegrationPatchResult,
  type IntegrationQueueExpectation,
  type IntegrationStatus
} from "./integrate.js";
import { checkWriteIntent, type WriteIntentPass } from "./intent.js";
import { requirePassedWriteIntent } from "./intent.js";
import { extractJsonObject } from "./json.js";
import { markHumanGuidanceConsumed, readPendingHumanGuidance } from "./human-guidance.js";
import { applyOrchestratorContextBudget } from "./orchestrator-context.js";
import { requestLeaseForContract, type LeaseGrantResult } from "./lease.js";
import { evaluatePlanThrash, loadCurrentRatifiedPlan, loadTentativePlan, readRatifiedWorkspacePlanSession, type TentativePlan, type TentativePlanTask } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { readMeteredBudgetCapacity } from "./resource-ledger.js";
import { inferTaskTier } from "./routing.js";
import { markRunFailed, startRunTaskJob, type RunFailureMarkResult, type RunResult, type RunStartResult } from "./run.js";
import { latestTaskRunState } from "./run-state.js";
import { integratedTaskIdsFromEvents } from "./integration-state.js";
import { runScout, type ScoutResult } from "./scout.js";
import { requireActiveSpecRatified, type SpecResult } from "./spec.js";
import { loadSpecDocument } from "./spec-format.js";
import { getStatus, type HivemindStatus } from "./status.js";
import { submitTask, type SubmitResult } from "./submit.js";
import { requestTaskRedirect } from "./supervision.js";
import { requestSystemTaskStop } from "./task-control.js";
import { admitValueQuality, type ValueQualityAdmission, type ValueQualityStrategy } from "./value-quality.js";
import { admitExecutionWave } from "./wave-admission.js";
import { createTaskWorktree, type WorktreeResult } from "./worktree.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";
import { hasFailureCode, isFailureCode, type FailureCode } from "./failure-code.js";

interface ManagerSession {
  version: 1;
  session_id: string;
  created_at: string;
  spec_id: string;
  execution_mode: "deterministic_happy_path" | "llm_reactive";
  autonomy_level_at_start?: AutonomyLevel;
  working_set: ManagerWorkingSet;
  turns: ManagerTurn[];
  proposed_action: ManagerProposedAction;
  proposal_state?: ManagerProposalState;
  pending_action?: ManagerPendingAction;
  blocked_action?: ManagerBlockedAction;
  executed_actions: ManagerExecutedAction[];
}

interface ManagerProposalState {
  proposal_id: string;
  status: "pending" | "consumed" | "discarded";
  next_action_index?: number;
  consumed_at?: string;
  discarded_at?: string;
  discard_reason?: string;
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
  source: "adapter-generated" | "deterministic" | "scripted";
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
  proposal_id: string;
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
  last_activity_at: string;
  status: "active" | "paused" | "stopped" | "complete";
  tool: string;
  call_count: number;
  pending_action: ManagerPendingAction | null;
  blocked_action_type: ManagerAction["type"] | null;
  blocked_reason: string | null;
  blocked_code: FailureCode | null;
  continuation_available: boolean;
  autonomy_level: AutonomyLevel;
  autonomy_levels: AutonomyLevel[];
}

export interface ManagerWorkspaceHistorySession extends ManagerWorkspaceSession {
  task_ids: string[];
  evidence_path: string;
}

interface ManagerBlockedAction {
  action_type: ManagerAction["type"];
  result: Extract<ManagerActionExecutionRecord, { ok: false }>;
  stop: ManagerStopAdvice;
}

type ManagerActionExecutionRecord =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; code?: FailureCode };

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
  | ({ type: "integrate_shadow" } & Partial<IntegrationQueueExpectation>);

const MANAGER_BATCH_MAX_ACTIONS = 5;
const PRE_WORKER_BATCH_SEQUENCE: ManagerAction["type"][] = [
  "create_task_contract",
  "request_lease",
  "check_write_intent",
  "create_worktree",
  "run_worker"
];

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
  deterministicHappyPath?: boolean;
}

interface ActionClassification {
  tier: "autonomous" | "human_approval";
  interruption: "none" | "configurable" | "escalation";
  reason: string;
  recommendation: string;
}

interface StartManagerSessionOptions {
  tool?: string;
  proposedAction?: ManagerProposedAction;
  deterministicHappyPath?: boolean;
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
      maxSteps: parsed.maxSteps,
      deterministicHappyPath: true
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
  return startManagerSessionWithId(repoRoot, message, options, randomUUID());
}

export async function startWorkspaceManagerSession(
  repoRoot: string,
  message: string,
  tool: string
): Promise<SpecResult<ManagerSessionResult>> {
  const activeSpec = await requireActiveSpecRatified(repoRoot);
  if (!activeSpec.ok) return activeSpec;
  const preparedSession = await readRatifiedWorkspacePlanSession(repoRoot, activeSpec.value.spec_id);
  if (!preparedSession.ok) return preparedSession;
  return startManagerSessionWithId(
    repoRoot,
    message,
    { tool, deterministicHappyPath: true },
    preparedSession.value.session_id
  );
}

async function startManagerSessionWithId(
  repoRoot: string,
  message: string,
  options: StartManagerSessionOptions,
  sessionId: string
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
  const autonomy = await readProjectAutonomyLevel(repoRoot);
  if (!autonomy.ok) return autonomy;

  try {
    await stat(managerSessionPath(repoRoot, sessionId));
    return { ok: false, reason: `manager session ${sessionId} already exists` };
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const proposedAction = options.proposedAction === undefined
    ? options.deterministicHappyPath === true
      ? await deriveOrGenerateManagerProposal(
          repoRoot,
          spec.value.spec_id,
          message.trim(),
          options.tool ?? "manager",
          sessionId
        )
      : await generateManagerProposal(repoRoot, message.trim(), options.tool ?? "manager", spec.value.spec_id, sessionId)
    : ({ ok: true, value: options.proposedAction } as const);
  if (!proposedAction.ok) {
    return recordManagerProposalFailure(repoRoot, sessionId, proposedAction);
  }
  const proposalValidation = validateAutonomousSessionProposal(proposedAction.value);
  if (!proposalValidation.ok) return proposalValidation;
  const session: ManagerSession = {
    version: 1,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    spec_id: spec.value.spec_id,
    execution_mode: options.deterministicHappyPath === true ? "deterministic_happy_path" : "llm_reactive",
    autonomy_level_at_start: autonomy.value,
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
    proposal_state: newProposalState(proposedAction.value),
    executed_actions: []
  };

  const relativePath = `.hivemind/orchestrator/sessions/${sessionId}.json`;
  await writeJsonAtomic(path.join(repoRoot, relativePath), session);
  const autonomyRecorded = await recordAutonomyDecision(repoRoot, {
    level: autonomy.value,
    session_id: sessionId,
    decision: "run_started",
    action_type: "manager.start",
    interruption: "not_applicable",
    authorization_source: "deterministic_pipeline",
    result: "started",
    reason: `Manager run started with project autonomy level ${autonomy.value}.`
  });
  if (!autonomyRecorded.ok) return autonomyRecorded;
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

  const processResult = await runAdapterProcess(repoRoot, profileResult.profile, repoRoot, prompt.value, {
    outputLogPath: adapterRunLogPath(repoRoot, `manager-${resolvedSpecId}`),
    usageSessionId,
    usageRunId: usageSessionId ?? resolvedSpecId
  });
  if (!processResult.ok) {
    return processResult;
  }
  if (processResult.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, processResult.value, "manager adapter") };
  }

  const proposal = parseGeneratedManagerProposal(processResult.value.modelOutput);
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

type DeterministicProposalDecision =
  | { kind: "proposal"; proposal: ManagerProposedAction }
  | { kind: "waiting"; task_id: string }
  | { kind: "judgment"; reason: string };

type DeterministicActionMode = "complete" | "start_worker";

interface ConcurrentWaveStep {
  action: ManagerAction;
  tier: "autonomous" | "human_approval";
  result: ManagerActionExecutionRecord;
}

type ConcurrentLaneStatus = "completed" | "failed" | "cancelled" | "paused" | "setup_refused";

interface ConcurrentLaneOutcome {
  task_id: string;
  status: ConcurrentLaneStatus;
  reason: string;
  /** Carried from the durable pause event, not parsed out of the reason. */
  code?: FailureCode;
}

type ConcurrentWaveDecision =
  | { kind: "not_applicable" }
  | {
      kind: "executed";
      group_id: string;
      binding_limit: "configured_cap" | "budget" | "ready_count";
      configured_cap: number;
      effective_concurrency: number;
      steps: ConcurrentWaveStep[];
      lane_outcomes: ConcurrentLaneOutcome[];
      failure?: { action: ManagerAction; result: Extract<ManagerActionExecutionRecord, { ok: false }> };
    }
  | { kind: "judgment"; reason: string };

async function deriveOrGenerateManagerProposal(
  repoRoot: string,
  specId: string,
  judgmentMessage: string,
  tool: string,
  usageSessionId: string,
  forcedJudgmentReason?: string
): Promise<SpecResult<ManagerProposedAction>> {
  if (forcedJudgmentReason !== undefined) {
    return generateManagerProposal(
      repoRoot,
      `${judgmentMessage}\n\nDeterministic happy-path execution stopped and requires judgment: ${forcedJudgmentReason}`,
      tool,
      specId,
      usageSessionId
    );
  }
  const guidance = await readPendingHumanGuidance(repoRoot);
  if (!guidance.ok) return guidance;
  if (guidance.value.length > 0) {
    return generateManagerProposal(repoRoot, judgmentMessage, tool, specId, usageSessionId);
  }

  let derived = await deriveDeterministicHappyPathProposal(repoRoot, specId);
  if (derived.kind === "waiting") {
    const observed = await waitForTaskRunCompletion(repoRoot, derived.task_id);
    if (!observed.ok) {
      return generateManagerProposal(
        repoRoot,
        `${judgmentMessage}\n\nDeterministic happy-path execution stopped while observing ${derived.task_id}: ${observed.reason}`,
        tool,
        specId,
        usageSessionId
      );
    }
    derived = await deriveDeterministicHappyPathProposal(repoRoot, specId);
  }
  if (derived.kind === "judgment") {
    return generateManagerProposal(
      repoRoot,
      `${judgmentMessage}\n\nDeterministic happy-path execution cannot prove the next action: ${derived.reason}`,
      tool,
      specId,
      usageSessionId
    );
  }
  if (derived.kind === "waiting") {
    return { ok: false, reason: `task ${derived.task_id} remained in progress after durable completion observation` };
  }
  return { ok: true, value: derived.proposal };
}

async function deriveDeterministicHappyPathProposal(
  repoRoot: string,
  specId: string
): Promise<DeterministicProposalDecision> {
  const plan = await loadCurrentRatifiedPlan(repoRoot, specId, "deterministic happy-path derivation");
  if (!plan.ok) return { kind: "judgment", reason: plan.reason };
  const status = await getStatus(repoRoot);
  if (!status.ok) return { kind: "judgment", reason: status.reason };
  const events = await readEvents(repoRoot);
  if (!events.ok) return { kind: "judgment", reason: events.reason };

  if (status.value.integration.status?.tests === "fail" || status.value.integration.status?.tests === "blocked") {
    return {
      kind: "judgment",
      reason: `the latest project verification is ${status.value.integration.status.tests}; deterministic execution will not retry or advance past it`
    };
  }

  const orderedTasks = orderedPlanTasks(plan.value);
  if (!orderedTasks.ok) return { kind: "judgment", reason: orderedTasks.reason };
  const integrated = integratedTaskIdsFromEvents(events.value);
  const settledParallelLanes = settledParallelLaneTaskIds(events.value);
  const taskStatus = new Map(status.value.tasks.map((task) => [task.task_id, task]));
  const planTaskIds = new Set(orderedTasks.value.map((task) => task.task_id));

  for (const task of orderedTasks.value) {
    if (integrated.has(task.task_id) || task.depends_on.some((dependency) => !integrated.has(dependency))) {
      continue;
    }
    const current = taskStatus.get(task.task_id);

    if (current === undefined) {
      const actions = await derivePreWorkerActions(repoRoot, plan.value, task, current);
      if (!actions.ok) return { kind: "judgment", reason: actions.reason };
      return deterministicProposal(
        actions.value,
        `Core derived the complete pre-worker pipeline for ${task.task_id} from the exact ratified plan and current durable state.`
      );
    }

    const runState = latestTaskRunState(events.value, task.task_id);
    if (runState.state === "failed" || runState.state === "cancelled") {
      if (settledParallelLanes.has(task.task_id)) continue;
      const terminal = runState.state === "failed" ? runState.failed : runState.cancelled;
      const reason = typeof terminal.data.reason === "string" ? terminal.data.reason : runState.state;
      return { kind: "judgment", reason: `${task.task_id} is ${runState.state}: ${reason}` };
    }
    if (current.queued) {
      if (runState.state !== "completed" || !current.patch.accepted || current.patch.verdict !== "accept") {
        return { kind: "judgment", reason: `${task.task_id} is queued without current completed and accepted patch evidence` };
      }
      continue;
    }
    if (task.mode === "read_only" && runState.state === "completed") {
      if (runState.completed.data.changed_files !== 0) {
        return { kind: "judgment", reason: `${task.task_id} is read-only but reported file changes` };
      }
      continue;
    }
    if (runState.state === "running") {
      if (latestQuotaPauseAfterLatestStart(events.value, task.task_id) !== null && settledParallelLanes.has(task.task_id)) continue;
      return { kind: "waiting", task_id: task.task_id };
    }

    if (runState.state === "completed") {
      if (!current.lease.held) {
        return { kind: "judgment", reason: `${task.task_id} completed but its canonical lease is no longer held` };
      }
      if (current.patch.bundle === "absent") {
        return { kind: "judgment", reason: `${task.task_id} completed without a durable patch bundle` };
      }
      if (!current.patch.submitted) {
        return deterministicProposal(
          [{ type: "submit_patch", task_id: task.task_id }, { type: "analyze_patch", task_id: task.task_id }],
          `Core observed ${task.task_id} completed with an unsubmitted patch and derived the existing submit/analyze pair.`
        );
      }
      if (!current.patch.analyzed) {
        return deterministicProposal(
          [{ type: "analyze_patch", task_id: task.task_id }],
          `Core observed a submitted, unanalyzed patch for ${task.task_id}.`
        );
      }
      if (!current.patch.accepted || current.patch.verdict !== "accept") {
        return {
          kind: "judgment",
          reason: `${task.task_id} analysis returned ${current.patch.verdict ?? "unknown"}: ${current.patch.reason}`
        };
      }
      return deterministicProposal(
        [{ type: "enqueue_patch", task_id: task.task_id }],
        `Core observed current submitted and accepted evidence for ${task.task_id}.`
      );
    }

    const actions = await derivePreWorkerActions(repoRoot, plan.value, task, current);
    if (!actions.ok) return { kind: "judgment", reason: actions.reason };
    return deterministicProposal(
      actions.value,
      `Core derived the remaining pre-worker pipeline for ${task.task_id} from current durable state.`
    );
  }

  const queuedForVerification = status.value.integration.queue.filter((taskId) => !integrated.has(taskId));
  const foreignQueuedTask = queuedForVerification.find((taskId) => !planTaskIds.has(taskId));
  if (foreignQueuedTask !== undefined) {
    return { kind: "judgment", reason: `integration queue contains ${foreignQueuedTask}, which is outside the exact ratified plan` };
  }
  if (queuedForVerification.length > 0) {
    return deterministicProposal(
      [{ type: "integrate_shadow" }],
      "Core observed accepted queued work and derived the existing shadow-verification action."
    );
  }
  if (orderedTasks.value.every((task) =>
    integrated.has(task.task_id) ||
    (task.mode === "read_only" && latestTaskRunState(events.value, task.task_id).state === "completed")
  )) {
    return deterministicProposal([], "Every task in the exact ratified plan has current durable verification evidence.");
  }
  const blocked = orderedTasks.value
    .filter((task) => !integrated.has(task.task_id) && !(task.mode === "read_only" && latestTaskRunState(events.value, task.task_id).state === "completed"))
    .map((task) => `${task.task_id} waits for ${task.depends_on.filter((dependency) => !integrated.has(dependency)).join(", ") || "unknown state"}`);
  return { kind: "judgment", reason: `no task has a provable next happy-path action: ${blocked.join("; ")}` };
}

async function derivePreWorkerActions(
  repoRoot: string,
  plan: TentativePlan,
  task: TentativePlanTask,
  current: HivemindStatus["tasks"][number] | undefined
): Promise<SpecResult<ManagerAction[]>> {
  if (current === undefined) {
    const contract = contractFromRatifiedPlanTask(plan, task);
    if (!contract.ok) return contract;
    return {
      ok: true,
      value: [
        { type: "create_task_contract", contract: contract.value },
        { type: "request_lease", task_id: task.task_id },
        { type: "check_write_intent", task_id: task.task_id, intent: writeIntentFromContract(contract.value) },
        { type: "create_worktree", task_id: task.task_id },
        { type: "run_worker", task_id: task.task_id }
      ]
    };
  }

  const contract = await loadAndValidateContract(repoRoot, task.task_id);
  if (!contract.ok) return contract;
  const actions: ManagerAction[] = [];
  if (!current.lease.held) actions.push({ type: "request_lease", task_id: task.task_id });
  const intent = await requirePassedWriteIntent(repoRoot, task.task_id);
  if (!intent.ok) {
    if (!hasFailureCode(intent, "write_intent_not_found")) return intent;
    actions.push({
      type: "check_write_intent",
      task_id: task.task_id,
      intent: writeIntentFromContract(contract.contract)
    });
  }
  if (current.worktree === "missing") actions.push({ type: "create_worktree", task_id: task.task_id });
  actions.push({ type: "run_worker", task_id: task.task_id });
  return { ok: true, value: actions };
}

async function tryExecuteConcurrentWorkerWave(
  repoRoot: string,
  session: ManagerSession,
  policy: ManagerAutonomyRuntimePolicy
): Promise<SpecResult<ConcurrentWaveDecision>> {
  if (session.pending_action !== undefined || session.blocked_action !== undefined) {
    return { ok: true, value: { kind: "not_applicable" } };
  }
  if (session.proposal_state?.status === "pending") {
    const cursor = proposalCursor(session);
    if (
      !cursor.ok ||
      cursor.value !== 0 ||
      session.proposed_action.source !== "deterministic"
    ) {
      return { ok: true, value: { kind: "not_applicable" } };
    }
  }

  const plan = await loadCurrentRatifiedPlan(repoRoot, session.spec_id, "concurrent deterministic scheduling");
  if (!plan.ok) return { ok: true, value: { kind: "not_applicable" } };
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const integrated = integratedTaskIdsFromEvents(events.value);
  const settledParallelLanes = settledParallelLaneTaskIds(events.value);
  const group = plan.value.execution_groups.find((entry) =>
    entry.task_ids.some((taskId) => !integrated.has(taskId) && !settledParallelLanes.has(taskId))
  );
  if (group === undefined || group.mode !== "parallel") {
    return { ok: true, value: { kind: "not_applicable" } };
  }

  const admission = await admitExecutionWave(repoRoot, session.spec_id, group.group_id);
  if (!admission.ok) return { ok: true, value: { kind: "judgment", reason: admission.reason } };
  if (admission.value.admitted_task_ids.length < 2) {
    return { ok: true, value: { kind: "not_applicable" } };
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) return status;
  if (status.value.integration.queue.length > 0) {
    return { ok: true, value: { kind: "not_applicable" } };
  }
  const statusByTask = new Map(status.value.tasks.map((task) => [task.task_id, task]));
  const taskById = new Map(plan.value.tasks.map((task) => [task.task_id, task]));
  const runnable: Array<{ task: TentativePlanTask; actions: ManagerAction[] }> = [];
  const config = await loadConfig(repoRoot);
  if (!config.ok) return config;

  for (const taskId of admission.value.admitted_task_ids) {
    const task = taskById.get(taskId);
    if (task === undefined) {
      return { ok: true, value: { kind: "judgment", reason: `concurrent scheduler could not resolve admitted task ${taskId}` } };
    }
    const current = statusByTask.get(taskId);
    const runState = latestTaskRunState(events.value, taskId);
    if (current?.queued || runState.state === "running" || runState.state === "completed" || runState.state === "failed" || runState.state === "cancelled") {
      continue;
    }
    const contract = contractFromRatifiedPlanTask(plan.value, task);
    if (!contract.ok) return { ok: true, value: { kind: "judgment", reason: contract.reason } };
    if (inferTaskTier(normalizeContract(contract.value), config.config) === "critical") {
      return { ok: true, value: { kind: "not_applicable" } };
    }
    const actions = await derivePreWorkerActions(repoRoot, plan.value, task, current);
    if (!actions.ok) return { ok: true, value: { kind: "judgment", reason: actions.reason } };
    if (actions.value.at(-1)?.type !== "run_worker") {
      return { ok: true, value: { kind: "judgment", reason: `concurrent scheduler derived no terminal worker action for ${taskId}` } };
    }
    if (actions.value.some((action) => action.type !== "run_worker" && policy.tier2Actions.has(action.type))) {
      return { ok: true, value: { kind: "not_applicable" } };
    }
    runnable.push({ task, actions: actions.value });
  }
  if (runnable.length < 2) return { ok: true, value: { kind: "not_applicable" } };

  const runClassification = await classifyManagerAction(
    repoRoot,
    { type: "run_worker", task_id: runnable[0].task.task_id },
    policy
  );
  if (runClassification.tier === "human_approval" && !shouldSuppressManagerInterruption(policy.level, runClassification, { type: "run_worker", task_id: runnable[0].task.task_id })) {
    return { ok: true, value: { kind: "not_applicable" } };
  }

  const capacity = await readMeteredBudgetCapacity(repoRoot, session.session_id);
  if (!capacity.ok) return { ok: true, value: { kind: "judgment", reason: capacity.reason } };
  const configuredCap = config.config.execution?.max_concurrent_workers ?? DEFAULT_MAX_CONCURRENT_WORKERS;
  const effectiveConcurrency = Math.min(configuredCap, capacity.value.available_reservations, runnable.length);
  if (effectiveConcurrency < 1) {
    return {
      ok: true,
      value: {
        kind: "judgment",
        reason: `concurrent worker scheduling stopped: session token budget permits 0 additional metered calls under ceiling ${capacity.value.session_ceiling_tokens}`
      }
    };
  }
  const bindingLimit = capacity.value.available_reservations < Math.min(configuredCap, runnable.length)
    ? "budget"
    : configuredCap < runnable.length
      ? "configured_cap"
      : "ready_count";

  const waveStarted = await appendEvent(repoRoot, {
    type: "scheduler.wave_started",
    task_id: null,
    data: {
      version: 1,
      session_id: session.session_id,
      group_id: group.group_id,
      task_ids: runnable.map((entry) => entry.task.task_id),
      configured_cap: configuredCap,
      effective_concurrency: effectiveConcurrency,
      binding_limit: bindingLimit,
      budget_available_reservations: capacity.value.available_reservations
    }
  });
  if (!waveStarted.ok) return waveStarted;

  const steps: ConcurrentWaveStep[] = [];
  const laneOutcomes = new Map<string, ConcurrentLaneOutcome>();
  const active = new Map<string, Promise<{ taskId: string; action: ManagerAction; tier: ConcurrentWaveStep["tier"]; result: ManagerActionExecutionRecord }>>();
  let nextIndex = 0;
  let stopNewLaunches: { action: ManagerAction; result: Extract<ManagerActionExecutionRecord, { ok: false }> } | undefined;

  while (nextIndex < runnable.length || active.size > 0) {
    while (stopNewLaunches === undefined && active.size < effectiveConcurrency && nextIndex < runnable.length) {
      const entry = runnable[nextIndex++];
      if (await runCancellationRequested(repoRoot, session.session_id)) {
        stopNewLaunches = {
          action: { type: "run_worker", task_id: entry.task.task_id },
          result: { ok: false, reason: `run ${session.session_id} was cancelled before ${entry.task.task_id} launched` }
        };
        break;
      }
      const currentAdmission = await admitExecutionWave(repoRoot, session.spec_id, group.group_id);
      if (!currentAdmission.ok || !currentAdmission.value.admitted_task_ids.includes(entry.task.task_id)) {
        const reason = currentAdmission.ok
          ? `concurrent scheduler re-admission no longer permits ${entry.task.task_id}`
          : currentAdmission.reason;
        laneOutcomes.set(entry.task.task_id, { task_id: entry.task.task_id, status: "setup_refused", reason });
        continue;
      }

      const refreshedStatus = await getStatus(repoRoot);
      if (!refreshedStatus.ok) return refreshedStatus;
      const refreshedCurrent = refreshedStatus.value.tasks.find((task) => task.task_id === entry.task.task_id);
      const refreshedActions = await derivePreWorkerActions(repoRoot, plan.value, entry.task, refreshedCurrent);
      if (!refreshedActions.ok) {
        laneOutcomes.set(entry.task.task_id, { task_id: entry.task.task_id, status: "setup_refused", reason: refreshedActions.reason });
        continue;
      }

      const setupActions = refreshedActions.value.slice(0, -1);
      let setupFailure: Extract<ManagerActionExecutionRecord, { ok: false }> | undefined;
      for (const action of setupActions) {
        const executed = await executeScheduledWaveAction(repoRoot, session.session_id, action, policy, "complete");
        if (!executed.ok) return executed;
        steps.push({ action, tier: executed.value.tier, result: executed.value.result });
        if (!executed.value.result.ok) {
          setupFailure = executed.value.result;
          break;
        }
      }
      if (setupFailure !== undefined) {
        laneOutcomes.set(entry.task.task_id, { task_id: entry.task.task_id, status: "setup_refused", reason: setupFailure.reason });
        await cleanupRefusedConcurrentLane(repoRoot, entry.task.task_id, setupFailure.reason);
        continue;
      }

      const runAction: ManagerAction = { type: "run_worker", task_id: entry.task.task_id };
      const started = await executeScheduledWaveAction(repoRoot, session.session_id, runAction, policy, "start_worker");
      if (!started.ok) return started;
      if (!started.value.result.ok) {
        steps.push({ action: runAction, tier: started.value.tier, result: started.value.result });
        const outcome = await classifyConcurrentLaneOutcome(repoRoot, entry.task.task_id, started.value.result.reason);
        laneOutcomes.set(entry.task.task_id, outcome);
        if (hasFailureCode(started.value.result, "session_reservation_refused")) {
          stopNewLaunches = { action: runAction, result: started.value.result };
        } else if (outcome.status !== "paused") {
          await cleanupRefusedConcurrentLane(repoRoot, entry.task.task_id, started.value.result.reason);
        }
        continue;
      }
      active.set(
        entry.task.task_id,
        waitForTaskRunCompletion(repoRoot, entry.task.task_id)
          .then((result) => ({ taskId: entry.task.task_id, action: runAction, tier: started.value.tier, result: recordResult(result) }))
          .catch((error: unknown) => ({
            taskId: entry.task.task_id,
            action: runAction,
            tier: started.value.tier,
            result: { ok: false as const, reason: formatErrorDetail(error, `unexpected concurrent worker observation failure for ${entry.task.task_id}`) }
          }))
      );
    }

    if (active.size === 0) break;
    const completed = await Promise.race(active.values());
    active.delete(completed.taskId);
    steps.push({ action: completed.action, tier: completed.tier, result: completed.result });
    const outcome = completed.result.ok
      ? { task_id: completed.taskId, status: "completed" as const, reason: "worker completed" }
      : await classifyConcurrentLaneOutcome(repoRoot, completed.taskId, completed.result.reason);
    laneOutcomes.set(completed.taskId, outcome);
    if (
      stopNewLaunches === undefined &&
      outcome.status === "paused" &&
      hasFailureCode({ ok: false, code: outcome.code }, "session_reservation_refused")
    ) {
      // Carry the code onto the recorded stop. A later check asks this same
      // result whether the wave stopped for budget, and rebuilding it without
      // the code is exactly how the distinction got lost before.
      stopNewLaunches = {
        action: completed.action,
        result: completed.result.ok
          ? { ok: false, reason: outcome.reason, code: outcome.code }
          : { ...completed.result, code: completed.result.code ?? outcome.code }
      };
    }
  }

  if (stopNewLaunches === undefined && await runCancellationRequested(repoRoot, session.session_id)) {
    stopNewLaunches = {
      action: { type: "run_worker", task_id: runnable.find((entry) => !laneOutcomes.has(entry.task.task_id))?.task.task_id ?? runnable[0].task.task_id },
      result: { ok: false, reason: `run ${session.session_id} was cancelled; no new lane or verification action will start` }
    };
  }

  const settledTaskIds = runnable.map((entry) => entry.task.task_id).filter((taskId) => laneOutcomes.has(taskId));
  const workerSurvivors = runnable
    .map((entry) => entry.task.task_id)
    .filter((taskId) => laneOutcomes.get(taskId)?.status === "completed");
  const waveSettled = await appendEvent(repoRoot, {
    type: "scheduler.wave_settled",
    task_id: null,
    data: {
      version: 1,
      session_id: session.session_id,
      group_id: group.group_id,
      expected_task_ids: runnable.map((entry) => entry.task.task_id),
      settled_task_ids: settledTaskIds,
      worker_survivor_task_ids: workerSurvivors,
      lane_outcomes: runnable.map((entry) => laneOutcomes.get(entry.task.task_id) ?? {
        task_id: entry.task.task_id,
        status: "not_launched",
        reason: stopNewLaunches?.result.reason ?? "launching stopped"
      })
    }
  });
  if (!waveSettled.ok) return waveSettled;

  const acceptedSurvivors: string[] = [];
  for (const taskId of workerSurvivors) {
    let survivorAccepted = true;
    for (const action of [
      { type: "submit_patch", task_id: taskId },
      { type: "analyze_patch", task_id: taskId }
    ] as ManagerAction[]) {
      const executed = await executeScheduledWaveAction(repoRoot, session.session_id, action, policy, "complete");
      if (!executed.ok) return executed;
      steps.push({ action, tier: executed.value.tier, result: executed.value.result });
      if (!executed.value.result.ok) {
        survivorAccepted = false;
        laneOutcomes.set(taskId, { task_id: taskId, status: "failed", reason: executed.value.result.reason });
        break;
      }
    }
    if (!survivorAccepted) continue;
    const analyzedStatus = await getStatus(repoRoot);
    if (!analyzedStatus.ok) return analyzedStatus;
    const analyzedTask = analyzedStatus.value.tasks.find((task) => task.task_id === taskId);
    if (analyzedTask?.patch.accepted !== true || analyzedTask.patch.verdict !== "accept") {
      laneOutcomes.set(taskId, {
        task_id: taskId,
        status: "failed",
        reason: analyzedTask?.patch.reason ?? "patch analysis did not accept the survivor"
      });
      continue;
    }
    const enqueueAction: ManagerAction = { type: "enqueue_patch", task_id: taskId };
    const enqueued = await executeScheduledWaveAction(repoRoot, session.session_id, enqueueAction, policy, "complete");
    if (!enqueued.ok) return enqueued;
    steps.push({ action: enqueueAction, tier: enqueued.value.tier, result: enqueued.value.result });
    if (!enqueued.value.result.ok) {
      laneOutcomes.set(taskId, { task_id: taskId, status: "failed", reason: enqueued.value.result.reason });
      continue;
    }
    acceptedSurvivors.push(taskId);
  }

  const budgetStoppedLaunches = stopNewLaunches !== undefined && hasFailureCode(stopNewLaunches.result, "session_reservation_refused");
  if (acceptedSurvivors.length > 0 && (stopNewLaunches === undefined || budgetStoppedLaunches)) {
    const expectation = await captureIntegrationQueueExpectation(repoRoot, acceptedSurvivors);
    if (!expectation.ok) {
      stopNewLaunches = { action: { type: "integrate_shadow" }, result: { ok: false, reason: expectation.reason } };
    } else {
      const integrateAction: ManagerAction = { type: "integrate_shadow", ...expectation.value };
      const integratedResult = await executeScheduledWaveAction(repoRoot, session.session_id, integrateAction, policy, "complete");
      if (!integratedResult.ok) return integratedResult;
      steps.push({ action: integrateAction, tier: integratedResult.value.tier, result: integratedResult.value.result });
      if (!integratedResult.value.result.ok) {
        stopNewLaunches = { action: integrateAction, result: integratedResult.value.result };
      }
    }
  }
  if (stopNewLaunches === undefined) {
    const firstUnsuccessfulLane = runnable
      .map((entry) => laneOutcomes.get(entry.task.task_id))
      .find((entry) => entry !== undefined && entry.status !== "completed");
    if (firstUnsuccessfulLane !== undefined) {
      stopNewLaunches = {
        action: { type: "run_worker", task_id: firstUnsuccessfulLane.task_id },
        result: {
          ok: false,
          reason: `${firstUnsuccessfulLane.task_id} settled as ${firstUnsuccessfulLane.status}: ${firstUnsuccessfulLane.reason}; independent survivors completed and were verified before the run stopped for judgment`
        }
      };
    }
  }

  const waveFinished = await appendEvent(repoRoot, {
    type: stopNewLaunches === undefined ? "scheduler.wave_completed" : "scheduler.wave_stopped",
    task_id: null,
    data: {
      version: 1,
      session_id: session.session_id,
      group_id: group.group_id,
      task_ids: runnable.map((entry) => entry.task.task_id),
      binding_limit: bindingLimit,
      result: stopNewLaunches === undefined ? "settled" : "stopped",
      accepted_survivor_task_ids: acceptedSurvivors,
      lane_outcomes: runnable.map((entry) => laneOutcomes.get(entry.task.task_id) ?? {
        task_id: entry.task.task_id,
        status: "not_launched",
        reason: stopNewLaunches?.result.reason ?? "launching stopped"
      }),
      ...(stopNewLaunches === undefined ? {} : { reason: stopNewLaunches.result.reason })
    }
  });
  if (!waveFinished.ok) return waveFinished;

  return {
    ok: true,
    value: {
      kind: "executed",
      group_id: group.group_id,
      binding_limit: bindingLimit,
      configured_cap: configuredCap,
      effective_concurrency: effectiveConcurrency,
      steps,
      lane_outcomes: runnable.map((entry) => laneOutcomes.get(entry.task.task_id)).filter((entry): entry is ConcurrentLaneOutcome => entry !== undefined),
      ...(stopNewLaunches === undefined ? {} : { failure: stopNewLaunches })
    }
  };
}

async function classifyConcurrentLaneOutcome(
  repoRoot: string,
  taskId: string,
  fallbackReason: string
): Promise<ConcurrentLaneOutcome> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return { task_id: taskId, status: "failed", reason: `${fallbackReason}; ${events.reason}` };
  const pause = latestQuotaPauseAfterLatestStart(events.value, taskId);
  if (pause !== null) {
    return {
      task_id: taskId,
      status: "paused",
      reason: typeof pause.data.reroute_reason === "string" ? pause.data.reroute_reason : fallbackReason,
      // Carried on the durable event, not parsed out of the reason. The
      // scheduler reads the lane outcome back from the trail, so a code that
      // stopped at a function boundary would not survive the trip.
      code: typeof pause.data.reroute_code === "string" ? (pause.data.reroute_code as FailureCode) : undefined
    };
  }
  const state = latestTaskRunState(events.value, taskId);
  if (state.state === "cancelled") {
    return {
      task_id: taskId,
      status: "cancelled",
      reason: typeof state.cancelled.data.reason === "string" ? state.cancelled.data.reason : fallbackReason
    };
  }
  if (state.state === "failed") {
    return {
      task_id: taskId,
      status: "failed",
      reason: typeof state.failed.data.reason === "string" ? state.failed.data.reason : fallbackReason
    };
  }
  return { task_id: taskId, status: "failed", reason: fallbackReason };
}

async function cleanupRefusedConcurrentLane(repoRoot: string, taskId: string, reason: string): Promise<void> {
  const contract = await loadAndValidateContract(repoRoot, taskId);
  if (!contract.ok) return;
  const stopped = await requestSystemTaskStop(repoRoot, {
    task_id: taskId,
    reason: `Concurrent lane stopped after an independently gated action was refused: ${reason}`
  });
  if (!stopped.ok && !/already terminal/u.test(stopped.reason)) {
    console.error(`warning: concurrent lane cleanup remains retryable for ${taskId}: ${stopped.reason}`);
  }
}


function settledParallelLaneTaskIds(events: HivemindEvent[]): Set<string> {
  const settled = new Set<string>();
  for (const event of events) {
    if (!["scheduler.wave_settled", "scheduler.wave_completed", "scheduler.wave_stopped"].includes(event.type) || !Array.isArray(event.data.lane_outcomes)) continue;
    for (const raw of event.data.lane_outcomes) {
      if (!isRecord(raw) || typeof raw.task_id !== "string" || typeof raw.status !== "string") continue;
      if (["failed", "cancelled", "paused", "setup_refused"].includes(raw.status)) settled.add(raw.task_id);
    }
  }
  return settled;
}

async function runCancellationRequested(repoRoot: string, sessionId: string): Promise<boolean> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return true;
  let requested = false;
  for (const event of events.value) {
    if (event.data.session_id !== sessionId) continue;
    if (event.type === "scheduler.run_cancel_requested" || event.type === "scheduler.run_cancelled") requested = true;
  }
  return requested;
}

export async function cancelManagerRun(
  repoRoot: string,
  request: unknown
): Promise<SpecResult<{ session_id: string; stopped_task_ids: string[]; status: "cancelled" }>> {
  if (!isRecord(request)) return { ok: false, reason: "run stop request must be a JSON object" };
  if (Object.keys(request).some((key) => key !== "session_id" && key !== "reason")) {
    return { ok: false, reason: "run stop request contains an unsupported authority field" };
  }
  if (typeof request.session_id !== "string" || request.session_id.trim() === "") {
    return { ok: false, reason: "run stop session_id is required" };
  }
  if (typeof request.reason !== "string" || request.reason.trim() === "" || request.reason.length > 2000) {
    return { ok: false, reason: "run stop reason must be a non-empty string of at most 2000 characters" };
  }
  const sessionId = request.session_id.trim();
  const session = await loadManagerSession(repoRoot, sessionId);
  if (!session.ok) return session;
  const plan = await loadCurrentRatifiedPlan(repoRoot, session.value.spec_id, "run cancellation");
  if (!plan.ok) return plan;
  const requested = await appendEvent(repoRoot, {
    type: "scheduler.run_cancel_requested",
    task_id: null,
    data: {
      version: 1,
      session_id: sessionId,
      reason: request.reason.trim(),
      requested_by: "human",
      new_launches_permitted: false
    }
  });
  if (!requested.ok) return requested;

  const stoppedTaskIds: string[] = [];
  const failures: string[] = [];
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const status = await getStatus(repoRoot);
  if (!status.ok) return status;
  const statusByTask = new Map(status.value.tasks.map((task) => [task.task_id, task]));
  for (const task of plan.value.tasks) {
    const state = latestTaskRunState(events.value, task.task_id);
    const current = statusByTask.get(task.task_id);
    const hasCanonicalResources = current !== undefined && (current.lease.held === true || current.worktree !== "missing");
    if (
      state.state !== "running" &&
      !(state.state === "failed" && state.failed.data.stop_retryable === true) &&
      !(state.state === "not_started" && hasCanonicalResources)
    ) continue;
    const stopped = await requestSystemTaskStop(repoRoot, { task_id: task.task_id, reason: request.reason.trim() });
    if (stopped.ok) stoppedTaskIds.push(task.task_id);
    else failures.push(`${task.task_id}: ${stopped.reason}`);
  }
  const terminal = await appendEvent(repoRoot, {
    type: failures.length === 0 ? "scheduler.run_cancelled" : "scheduler.run_cancel_failed",
    task_id: null,
    data: {
      version: 1,
      session_id: sessionId,
      reason: request.reason.trim(),
      stopped_task_ids: stoppedTaskIds,
      failures,
      terminal: true,
      retryable: failures.length > 0
    }
  });
  if (!terminal.ok) return terminal;
  return failures.length === 0
    ? { ok: true, value: { session_id: sessionId, stopped_task_ids: stoppedTaskIds, status: "cancelled" } }
    : { ok: false, reason: `run cancellation incomplete and retryable: ${failures.join("; ")}` };
}

async function executeScheduledWaveAction(
  repoRoot: string,
  sessionId: string,
  action: ManagerAction,
  policy: ManagerAutonomyRuntimePolicy,
  mode: DeterministicActionMode
): Promise<SpecResult<{ tier: ConcurrentWaveStep["tier"]; result: ManagerActionExecutionRecord }>> {
  const session = await loadManagerSession(repoRoot, sessionId);
  if (!session.ok) return session;
  const decision = deterministicProposal([action], `Core scheduled ${action.type} as one independently gated member of an admitted concurrent wave.`);
  if (decision.kind !== "proposal") {
    const reason = decision.kind === "judgment" ? decision.reason : `unexpected wait for ${decision.task_id}`;
    return { ok: false, reason: `concurrent scheduler could not form an independently gated ${action.type} action: ${reason}` };
  }
  const proposed = appendProposalToSession(session.value, decision.proposal);
  await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), proposed);
  const proposalId = proposed.proposal_state!.proposal_id;
  const classification = await classifyManagerAction(repoRoot, action, policy);

  if (classification.tier === "human_approval") {
    if (!shouldSuppressManagerInterruption(policy.level, classification, action)) {
      return { ok: false, reason: `concurrent scheduler reached an action that still requires human attention: ${classification.reason}` };
    }
    const expectedState = await getStatus(repoRoot);
    if (!expectedState.ok) return expectedState;
    const pending: ManagerPendingAction = {
      pending_action_id: randomUUID(),
      proposal_id: proposalId,
      action,
      action_type: action.type,
      subject: managerActionSubject(action),
      expected_state_hash: hashDurableState(expectedState.value),
      tier: "human_approval",
      reason: classification.reason,
      recommendation: classification.recommendation
    };
    await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), { ...proposed, pending_action: pending });
    const authorized = await authorizePendingManagerAction(
      repoRoot,
      pendingRequest(sessionId, pending),
      "autonomy_policy",
      policy.level,
      mode
    );
    return authorized.ok
      ? { ok: true, value: { tier: "human_approval", result: authorized.value.result } }
      : authorized;
  }

  const executed = await executeProposedManagerAction(repoRoot, sessionId, proposalId, action, mode);
  return executed.ok
    ? { ok: true, value: { tier: "autonomous", result: executed.value.result } }
    : executed;
}

function orderedPlanTasks(plan: TentativePlan): SpecResult<TentativePlanTask[]> {
  const byId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const ordered: TentativePlanTask[] = [];
  const seen = new Set<string>();
  for (const group of plan.execution_groups) {
    for (const taskId of group.task_ids) {
      const task = byId.get(taskId);
      if (task === undefined || seen.has(taskId)) {
        return { ok: false, reason: `ratified execution groups do not identify each task exactly once: ${taskId}` };
      }
      seen.add(taskId);
      ordered.push(task);
    }
  }
  return seen.size === plan.tasks.length
    ? { ok: true, value: ordered }
    : { ok: false, reason: "ratified execution groups omit one or more plan tasks" };
}

function contractFromRatifiedPlanTask(
  plan: TentativePlan,
  task: TentativePlanTask
): SpecResult<Record<string, unknown>> {
  const scope = task.grounded_scope;
  if (scope === undefined) return { ok: false, reason: `ratified task ${task.task_id} has no grounded scope` };
  return {
    ok: true,
    value: {
      task_id: task.task_id,
      title: task.title,
      agent_role: task.agent_role,
      routing_task_type: task.routing_task_type,
      base_commit: plan.base_commit,
      acceptance_criterion: task.acceptance_criterion,
      ...(task.deterministic_validity_check === undefined
        ? {}
        : { deterministic_validity_check: task.deterministic_validity_check }),
      allowed_files: scope.allowed_files,
      allowed_file_intents: normalizeAllowedFileIntents(scope.allowed_files, scope.allowed_file_intents),
      read_only_files: scope.read_only_files,
      forbidden_files: scope.forbidden_files,
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: scope.must_not_change,
      required_tests: task.required_tests,
      patch_requirements: task.patch_requirements
    }
  };
}

function writeIntentFromContract(contract: Record<string, unknown> | TaskContract): Record<string, unknown> {
  const allowedFiles = Array.isArray(contract.allowed_files)
    ? contract.allowed_files.filter((entry): entry is string => typeof entry === "string")
    : [];
  const patchRequirements = Array.isArray(contract.patch_requirements)
    ? contract.patch_requirements.filter((entry): entry is string => typeof entry === "string")
    : [];
  const mustNotChange = Array.isArray(contract.must_not_change)
    ? contract.must_not_change.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    task_id: String(contract.task_id),
    intended_files: allowedFiles,
    intended_symbols: [],
    possible_risks: patchRequirements,
    will_not_change: mustNotChange
  };
}

function deterministicProposal(actions: ManagerAction[], reason: string): DeterministicProposalDecision {
  const canonicalActions = parseManagerActionList(actions, "deterministic manager actions");
  if (!canonicalActions.ok) return { kind: "judgment", reason: canonicalActions.reason };
  const proposal: ManagerProposedAction = {
    type: "proposed_actions",
    source: "deterministic",
    reason,
    actions: canonicalActions.value,
    human_approval_required_for: canonicalActions.value
      .map((action) => action.type)
      .filter((type): type is "run_worker" | "integrate_shadow" => type === "run_worker" || type === "integrate_shadow")
  };
  const validated = validateGeneratedManagerActions(proposal.actions, proposal.human_approval_required_for);
  return validated.ok ? { kind: "proposal", proposal } : { kind: "judgment", reason: validated.reason };
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

  const processResult = await runAdapterProcess(repoRoot, profileResult.profile, repoRoot, prompt.value, {
    outputLogPath: adapterRunLogPath(repoRoot, `redirect-${action.task_id}`),
    usageSessionId,
    usageRunId: usageSessionId,
    usageTaskId: action.task_id
  });
  if (!processResult.ok) {
    return processResult;
  }
  if (processResult.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, processResult.value, "redirect correction adapter") };
  }

  const correction = parseRedirectCorrection(processResult.value.modelOutput);
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
      "Choose the next action or one bounded safe action batch from current durable state.",
      "The actions array MUST contain zero to five action objects and MUST match one of the safe batch shapes below.",
      "Hivemind executes each member sequentially through its own gate and stops at the first refusal or failure.",
      "",
      "Return exactly one JSON object and no prose outside it:",
      "{",
      "  \"reason\": \"short explanation of the next gated action or safe mechanical batch\",",
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
      "        \"deterministic_validity_check\": \"exact executable conformance command from the plan task, when present\",",
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
      "    }",
      "  ]",
      "}",
      "",
      "Supported action object references:",
      "{ \"type\": \"get_status\" }",
      "{ \"type\": \"request_lease\", \"task_id\": \"T-001\" }",
      "{ \"type\": \"check_write_intent\", \"task_id\": \"T-001\", \"intent\": { \"task_id\": \"T-001\", \"intended_files\": [\"...\"], \"intended_symbols\": [], \"possible_risks\": [], \"will_not_change\": [\"...\"] } }",
      "{ \"type\": \"create_worktree\", \"task_id\": \"T-001\" }",
      "{ \"type\": \"run_worker\", \"task_id\": \"T-001\", \"tool\": \"worker-tool\" }",
      "{ \"type\": \"submit_patch\", \"task_id\": \"T-001\" }",
      "{ \"type\": \"analyze_patch\", \"task_id\": \"T-001\" }",
      "{ \"type\": \"enqueue_patch\", \"task_id\": \"T-001\" }",
      "{ \"type\": \"integrate_shadow\" }",
      "",
      "Hard rules:",
      "- The actions array must contain at most five actions. More than five is invalid and will be refused before any action executes.",
      "- Multi-action proposals are allowed ONLY for one task and in one of these shapes:",
      "  1. A contiguous segment of create_task_contract -> request_lease -> check_write_intent -> create_worktree -> run_worker. Never skip or reorder a step. run_worker, when present, is last.",
      "  2. Exactly submit_patch -> analyze_patch for one task. analyze_patch is last.",
      "- Every other action is single-only: get_status, scout_task, enqueue_patch, integrate_shadow, quality admission, redirect/replan decisions, and anything result-dependent.",
      "- Never put an action after run_worker or analyze_patch. Their real outcome must be observed in durable state before another proposal.",
      "- A batch is prediction, not authority: Hivemind independently gates each member and discards the remainder after the first refusal, failure, timeout, crash, escalation, or unexpected result.",
      "- Do not mark anything ratified, approved, accepted, integrated, or passed. You are proposing actions only.",
      "- Do not output self_approved, ratified, gate_verdict, result, skip_gates, or any other proof-like field.",
      "- If the plan is missing or not ready, propose get_status and explain the blocking state in reason.",
      "- Every state-changing action must be one of the supported action JSON shapes listed above.",
      "- create_task_contract.contract must use the flat TaskContract schema exactly. Do not include mode, depends_on, scope, draft_scope, grounded_scope, grounding_evidence, scope_status, or critical_path_approved inside the contract.",
      "- For contract scopes, copy fields from the plan task's grounded_scope into allowed_files, allowed_file_intents, read_only_files, forbidden_files, and must_not_change.",
      "- Copy contract.routing_task_type exactly from the plan task's routing_task_type.",
      "- Set contract.base_commit to the tentative plan base_commit.",
      "- Propose run_worker only when current durable status already proves a passed write-intent for that task.",
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
      "Choose the next action or one bounded safe action batch from current durable state.",
      "The actions array MUST contain zero to five action objects and MUST match the same safe batch shapes as the full manager contract.",
      "Hivemind executes each member sequentially through its own gate and stops at the first refusal or failure.",
      "",
      "Return exactly one JSON object and no prose outside it:",
      "{ \"reason\": \"short explanation of the next gated action or safe mechanical batch\", \"human_approval_required_for\": [], \"actions\": [{ \"type\": \"get_status\" }] }",
      "",
      "Hard rules:",
      "- The actions array contains at most five actions. Multi-action proposals are one-task contiguous segments of create_task_contract -> request_lease -> check_write_intent -> create_worktree -> run_worker, or exactly submit_patch -> analyze_patch.",
      "- run_worker and analyze_patch are terminal. Every other result-dependent action remains single. Stop predicting after any action whose result must be observed.",
      "- Hivemind gates every member independently and discards the remainder after the first refusal or failure.",
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
  if (actions.length > MANAGER_BATCH_MAX_ACTIONS) {
    return {
      ok: false,
      reason: `manager proposal exceeds the ${MANAGER_BATCH_MAX_ACTIONS}-action safe batch bound; no action was consumed`
    };
  }
  if (actions.length > 1) {
    const batch = validateManagerBatchShape(actions);
    if (!batch.ok) return batch;
  }
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

function validateAutonomousSessionProposal(proposal: ManagerProposedAction): SpecResult<void> {
  if (proposal.source === "adapter-generated" || proposal.source === "deterministic") {
    return validateGeneratedManagerActions(proposal.actions, proposal.human_approval_required_for);
  }
  return proposal.actions.length <= 1
    ? { ok: true, value: undefined }
    : { ok: false, reason: "scripted multi-action proposals are not valid autonomous-session input" };
}

function validateManagerBatchShape(actions: ManagerAction[]): SpecResult<void> {
  const taskIds = actions.map(managerActionTaskId);
  if (taskIds.some((taskId) => taskId === null)) {
    return { ok: false, reason: "manager multi-action proposal contains a single-only or taskless action; no action was consumed" };
  }
  const distinctTaskIds = new Set(taskIds as string[]);
  if (distinctTaskIds.size !== 1) {
    return { ok: false, reason: "manager multi-action proposal must target exactly one task; no action was consumed" };
  }

  const types = actions.map((action) => action.type);
  if (types.length === 2 && types[0] === "submit_patch" && types[1] === "analyze_patch") {
    return { ok: true, value: undefined };
  }

  const start = PRE_WORKER_BATCH_SEQUENCE.indexOf(types[0]);
  if (start < 0 || start + types.length > PRE_WORKER_BATCH_SEQUENCE.length) {
    return { ok: false, reason: "manager multi-action proposal is not a safe fixed-pipeline segment; no action was consumed" };
  }
  for (const [index, type] of types.entries()) {
    if (PRE_WORKER_BATCH_SEQUENCE[start + index] !== type) {
      return { ok: false, reason: "manager multi-action proposal skips or reorders the safe fixed pipeline; no action was consumed" };
    }
  }
  return { ok: true, value: undefined };
}

function managerActionTaskId(action: ManagerAction): string | null {
  if ("task_id" in action) return action.task_id;
  if (action.type === "create_task_contract") {
    return typeof action.contract.task_id === "string" && action.contract.task_id.trim() !== "" ? action.contract.task_id : null;
  }
  return null;
}

function scriptedManagerProposal(): ManagerProposedAction {
  return {
    type: "proposed_actions",
    source: "scripted",
    reason: "No-paid manager loop executing a pre-supplied action script through the deterministic manager executor.",
    actions: [],
    human_approval_required_for: []
  };
}

interface ManagerAutonomyRuntimePolicy {
  level: AutonomyLevel;
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
      level: config.config.manager_autonomy?.level ?? DEFAULT_AUTONOMY_LEVEL,
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
  const critical = await actionTouchesCriticalScope(repoRoot, action);
  if (!critical.ok) return humanApprovalClassification(action, critical.reason, "escalation");
  if (critical.value) {
    return humanApprovalClassification(action, `action ${action.type} touches Critical-tier scope`, "escalation");
  }

  if (policy.tier2Actions.has(action.type)) {
    return humanApprovalClassification(
      action,
      `action ${action.type} is configured as high-risk/consequential`,
      isConfigurableAutonomyAction(action.type) ? "configurable" : "escalation"
    );
  }

  const cost = estimateManagerActionCost(action);
  if (cost.estimated_requests > policy.costThreshold.estimated_requests) {
    return humanApprovalClassification(
      action,
      `action ${action.type} estimated provider requests ${cost.estimated_requests} exceeds configured autonomous threshold ${policy.costThreshold.estimated_requests}`,
      isConfigurableAutonomyAction(action.type) ? "configurable" : "escalation"
    );
  }
  if (policy.costThreshold.wall_time_ms !== undefined && cost.wall_time_ms !== undefined && cost.wall_time_ms > policy.costThreshold.wall_time_ms) {
    return humanApprovalClassification(
      action,
      `action ${action.type} estimated wall time ${cost.wall_time_ms}ms exceeds configured autonomous threshold ${policy.costThreshold.wall_time_ms}ms`,
      isConfigurableAutonomyAction(action.type) ? "configurable" : "escalation"
    );
  }

  return {
    tier: "autonomous",
    interruption: "none",
    reason: `action ${action.type} is Tier 1 and may run after deterministic checks pass`,
    recommendation: "Proceed through the deterministic manager executor."
  };
}

function humanApprovalClassification(
  action: ManagerAction,
  reason: string,
  interruption: "configurable" | "escalation"
): ActionClassification {
  return {
    tier: "human_approval",
    interruption,
    reason,
    recommendation: `Pause and ask the human to approve, modify, or reject ${action.type}; do not execute it autonomously.`
  };
}

function isConfigurableAutonomyAction(action: ManagerAction["type"]): action is "run_worker" | "integrate_shadow" {
  return action === "run_worker" || action === "integrate_shadow";
}

function shouldSuppressManagerInterruption(
  level: AutonomyLevel,
  classification: ActionClassification,
  action: ManagerAction
): boolean {
  return level !== "review_everything" &&
    classification.tier === "human_approval" &&
    classification.interruption === "configurable" &&
    isConfigurableAutonomyAction(action.type);
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
  return action.type === "check_write_intent" && hasFailureCode(result, "write_intent_lease_conflict");
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
    return "Reactive manager loop: propose the next action or one validated safe mechanical batch from current durable state.";
  }
  return [
    "Reactive manager loop: propose the next action or one validated safe mechanical batch from current durable state.",
    `Last manager observation: action ${last.type} returned ${last.result.ok ? "ok" : "rejected"}.`,
    `Last result JSON: ${JSON.stringify(last.result)}`,
    "Safe batching rule: use only a one-task contiguous segment of create_task_contract -> request_lease -> check_write_intent -> create_worktree -> run_worker, or exactly submit_patch -> analyze_patch. Maximum five actions.",
    "Reactivity rule: run_worker and analyze_patch end a batch. Keep enqueue_patch, integrate_shadow, Scout, redirect/replan, cross-task, and every other result-dependent decision single.",
    "Run pipeline rule: run_worker returning started means only that the daemon accepted the worker job. Do not propose submit_patch until durable state has a task.completed event and a patch bundle.",
    "Patch pipeline rule: enqueue_patch is allowed only after a real submit_patch event and a real analyze_patch accepted event. If a task has a patch bundle but submitted/analyzed/accepted are not all true, propose submit_patch or analyze_patch as the next missing step.",
    "Redirect rule: if the last action was check_write_intent and durable events include task.redirected, propose a corrected in-scope check_write_intent. Do not repeat the rejected intent.",
    "If the task is done or blocked awaiting human action, return an empty actions array.",
    "Do not propose any action that changes config, provider tier metadata, safety rules, approval policy, or deterministic gates to get around a rejection."
  ].join("\n");
}

function newProposalState(proposal: ManagerProposedAction): ManagerProposalState {
  return proposal.actions.length === 0
    ? { proposal_id: randomUUID(), status: "consumed", next_action_index: 0, consumed_at: new Date().toISOString() }
    : { proposal_id: randomUUID(), status: "pending", next_action_index: 0 };
}

function appendProposalToSession(session: ManagerSession, proposal: ManagerProposedAction): ManagerSession {
  return {
    ...session,
    proposed_action: proposal,
    proposal_state: newProposalState(proposal),
    turns: [
      ...session.turns,
      {
        role: "manager",
        content: `proposed next actions: ${proposal.actions.map((action) => action.type).join(" -> ") || "none"} - ${proposal.reason}`
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
  const session = await startManagerSession(repoRoot, message, { proposedAction: scriptedManagerProposal() });
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
  const session = await startManagerSession(repoRoot, message, {
    tool: options.tool,
    deterministicHappyPath: options.deterministicHappyPath === true
  });
  if (!session.ok) {
    return session;
  }
  return continueAutonomousManagerLoop(repoRoot, session.value.session_id, options);
}

export async function continueAutonomousManagerLoop(
  repoRoot: string,
  sessionId: string,
  options: AutonomousLoopOptions
): Promise<SpecResult<ManagerAutonomousLoopResult>> {
  const steps: ManagerAutonomousLoopResult["steps"] = [];
  for (let index = 0; index < options.maxSteps; index += 1) {
    const policy = await loadManagerAutonomyPolicy(repoRoot);
    if (!policy.ok) return policy;
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

    if (session.value.execution_mode === "deterministic_happy_path") {
      const wave = await tryExecuteConcurrentWorkerWave(repoRoot, session.value, policy.value);
      if (!wave.ok) return wave;
      if (wave.value.kind === "judgment") {
        return recordManagerProposalFailure(repoRoot, sessionId, { reason: wave.value.reason });
      }
      if (wave.value.kind === "executed") {
        for (const waveStep of wave.value.steps) {
          steps.push({
            index: steps.length,
            action_type: waveStep.action.type,
            tier: waveStep.result.ok ? waveStep.tier : "gate_rejection",
            result: waveStep.result,
            ...(waveStep.result.ok ? {} : { stop: buildGateRejectionAdvice(waveStep.action, waveStep.result.reason) })
          });
        }
        if (wave.value.failure !== undefined) {
          const stop = buildGateRejectionAdvice(wave.value.failure.action, wave.value.failure.result.reason);
          const blocked = await recordBlockedManagerAction(
            repoRoot,
            sessionId,
            wave.value.failure.action,
            wave.value.failure.result,
            stop
          );
          if (!blocked.ok) return blocked;
          const status = await getStatus(repoRoot);
          if (!status.ok) return status;
          return {
            ok: true,
            value: {
              session_id: sessionId,
              session_path: managerSessionRelativePath(sessionId),
              status: "stopped",
              steps,
              final_status: status.value
            }
          };
        }
        continue;
      }
    }

    let action: ManagerAction;
    let classification: ActionClassification;
    let proposalId: string;
    if (session.value.pending_action !== undefined) {
      const pendingAction = parseManagerAction(session.value.pending_action.action);
      if (!pendingAction.ok) return pendingAction;
      const pendingClassification = await classifyManagerAction(repoRoot, pendingAction.value, policy.value);
      if (shouldSuppressManagerInterruption(policy.value.level, pendingClassification, pendingAction.value)) {
        const authorized = await authorizePendingManagerAction(
          repoRoot,
          pendingRequest(session.value.session_id, session.value.pending_action),
          "autonomy_policy",
          policy.value.level
        );
        if (!authorized.ok) return authorized;
        steps.push({
          index,
          action_type: pendingAction.value.type,
          tier: "human_approval",
          result: authorized.value.result
        });
        continue;
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
      let nextProposal: ManagerProposedAction;
      if (session.value.proposal_state?.status === "pending") {
        const guidance = session.value.execution_mode === "deterministic_happy_path" && session.value.proposed_action.source === "deterministic"
          ? await readPendingHumanGuidance(repoRoot)
          : { ok: true as const, value: [] };
        if (!guidance.ok) return guidance;
        if (guidance.value.length > 0) {
          const generated = await generateManagerProposal(
            repoRoot,
            `${buildReactiveProposalMessage(session.value)}\n\nPending human guidance requires judgment before the unexecuted deterministic proposal may advance.`,
            options.tool,
            session.value.spec_id,
            session.value.session_id
          );
          if (!generated.ok) return recordManagerProposalFailure(repoRoot, sessionId, generated);
          nextProposal = generated.value;
          sessionForWrite = appendProposalToSession(
            {
              ...session.value,
              turns: [
                ...session.value.turns,
                { role: "manager", content: "superseded an unexecuted Core-derived proposal because durable human guidance required judgment first" }
              ]
            },
            nextProposal
          );
          await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), sessionForWrite);
          proposalId = sessionForWrite.proposal_state!.proposal_id;
        } else {
          nextProposal = session.value.proposed_action;
          proposalId = session.value.proposal_state.proposal_id;
        }
      } else {
        if (session.value.proposal_state === undefined && session.value.proposed_action.actions.length > 0) {
          return {
            ok: false,
            reason: "manager session predates durable proposal tracking; start a new session instead of guessing whether its stored proposal was consumed"
          };
        }
        const lastExecution = session.value.executed_actions.at(-1);
        const forcedJudgmentReason = lastExecution !== undefined && !lastExecution.result.ok
          ? lastExecution.result.reason
          : undefined;
        const generated = session.value.execution_mode === "deterministic_happy_path"
          ? await deriveOrGenerateManagerProposal(
              repoRoot,
              session.value.spec_id,
              buildReactiveProposalMessage(session.value),
              options.tool,
              session.value.session_id,
              forcedJudgmentReason
            )
          : await generateManagerProposal(
              repoRoot,
              buildReactiveProposalMessage(session.value),
              options.tool,
              session.value.spec_id,
              session.value.session_id
            );
        if (!generated.ok) return recordManagerProposalFailure(repoRoot, sessionId, generated);
        nextProposal = generated.value;
        sessionForWrite = appendProposalToSession(session.value, nextProposal);
        await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), sessionForWrite);
        proposalId = sessionForWrite.proposal_state!.proposal_id;
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

      const pendingProposalAction = currentPendingProposalAction(sessionForWrite, proposalId);
      if (!pendingProposalAction.ok) return pendingProposalAction;
      action = pendingProposalAction.value;
      classification = await classifyManagerAction(repoRoot, action, policy.value);
      if (classification.tier === "human_approval") {
        const expectedState = await getStatus(repoRoot);
        if (!expectedState.ok) return expectedState;
        const pending: ManagerPendingAction = {
          pending_action_id: randomUUID(),
          proposal_id: proposalId,
          action,
          action_type: action.type,
          subject: managerActionSubject(action),
          expected_state_hash: hashDurableState(expectedState.value),
          tier: "human_approval",
          reason: classification.reason,
          recommendation: classification.recommendation
        };
        await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), { ...sessionForWrite, proposed_action: nextProposal, pending_action: pending });
        if (shouldSuppressManagerInterruption(policy.value.level, classification, action)) {
          const authorized = await authorizePendingManagerAction(
            repoRoot,
            pendingRequest(sessionId, pending),
            "autonomy_policy",
            policy.value.level
          );
          if (!authorized.ok) return authorized;
          if (!authorized.value.result.ok) {
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
                    action_type: action.type,
                    tier: "gate_rejection",
                    result: authorized.value.result,
                    stop: buildGateRejectionAdvice(action, authorized.value.result.reason)
                  }
                ],
                final_status: status.value
              }
            };
          }
          steps.push({ index, action_type: action.type, tier: "human_approval", result: authorized.value.result });
          continue;
        }
        const decision = await recordAutonomyDecision(repoRoot, {
          level: policy.value.level,
          session_id: sessionId,
          decision: "manager_action",
          action_type: action.type,
          interruption: "required",
          authorization_source: "human",
          pending_action_id: pending.pending_action_id,
          result: "paused",
          reason: classification.reason
        });
        if (!decision.ok) return decision;
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

    const result = await executeProposedManagerAction(repoRoot, sessionId, proposalId, action);
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
      const blocked = await recordBlockedManagerAction(repoRoot, sessionId, action, result.value.result, stop);
      if (!blocked.ok) return blocked;
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

async function recordBlockedManagerAction(
  repoRoot: string,
  sessionId: string,
  action: ManagerAction,
  result: Extract<ManagerActionExecutionRecord, { ok: false }>,
  stop: ManagerStopAdvice
): Promise<SpecResult<void>> {
  const session = await loadManagerSession(repoRoot, sessionId);
  if (!session.ok) return session;
  await writeJsonAtomic(managerSessionPath(repoRoot, sessionId), {
    ...session.value,
    blocked_action: { action_type: action.type, result, stop }
  });
  return { ok: true, value: undefined };
}

async function recordManagerProposalFailure(
  repoRoot: string,
  sessionId: string,
  failure: { reason: string; code?: FailureCode }
): Promise<SpecResult<never>> {
  if (
    hasFailureCode({ ok: false, code: failure.code }, "token_budget_exceeded") ||
    hasFailureCode({ ok: false, code: failure.code }, "session_reservation_refused")
  ) {
    const recorded = await appendEvent(repoRoot, {
      type: "quota.exhausted",
      task_id: null,
      data: { version: 1, session_id: sessionId, reason: failure.reason, source: "token_ceiling" }
    });
    if (!recorded.ok) return recorded;
  }
  return { ok: false, reason: failure.reason, ...(failure.code === undefined ? {} : { code: failure.code }) };
}

export async function retryBlockedManagerAction(
  repoRoot: string,
  sessionId: string
): Promise<SpecResult<{ session_id: string; action_type: ManagerAction["type"]; status: "judgment_pending" | "retry_pending" }>> {
  const session = await loadManagerSession(repoRoot, sessionId);
  if (!session.ok) return session;
  if (session.value.blocked_action === undefined) {
    return { ok: false, reason: "manager retry refused: session has no blocked action" };
  }
  if (session.value.pending_action !== undefined) {
    return { ok: false, reason: "manager retry refused: session already has a pending action" };
  }
  if (session.value.proposal_state?.status !== "consumed" && session.value.proposal_state?.status !== "discarded") {
    return { ok: false, reason: "manager retry refused: blocked action does not come from a consumed proposal" };
  }
  const retryIndex = lastConsumedProposalActionIndex(session.value);
  if (!retryIndex.ok) return { ok: false, reason: `manager retry refused: ${retryIndex.reason}` };
  const action = session.value.proposed_action.actions[retryIndex.value];
  const blocked = session.value.blocked_action;
  const lastExecution = session.value.executed_actions.at(-1);
  if (
    action.type !== blocked.action_type ||
    lastExecution?.type !== blocked.action_type ||
    lastExecution.result.ok !== false ||
    lastExecution.result.reason !== blocked.result.reason
  ) {
    return { ok: false, reason: "manager retry refused: blocked action identity is inconsistent with durable execution history" };
  }

  if (session.value.execution_mode === "llm_reactive") {
    const proposalId = randomUUID();
    const recorded = await appendEvent(repoRoot, {
      type: "manager.action_retry_requested",
      task_id: "task_id" in action ? action.task_id : null,
      data: {
        version: 1,
        session_id: session.value.session_id,
        action_type: action.type,
        previous_reason: blocked.result.reason,
        proposal_id: proposalId
      }
    });
    if (!recorded.ok) return recorded;
    await writeJsonAtomic(managerSessionPath(repoRoot, session.value.session_id), {
      ...session.value,
      blocked_action: undefined,
      proposal_state: {
        proposal_id: proposalId,
        status: "pending",
        next_action_index: retryIndex.value
      },
      turns: [...session.value.turns, { role: "user", content: `retry requested for blocked action ${action.type}` }]
    });
    return {
      ok: true,
      value: { session_id: session.value.session_id, action_type: action.type, status: "retry_pending" }
    };
  }

  const recorded = await appendEvent(repoRoot, {
    type: "manager.judgment_requested",
    task_id: "task_id" in action ? action.task_id : null,
    data: {
      version: 1,
      session_id: session.value.session_id,
      action_type: action.type,
      previous_reason: blocked.result.reason,
      next_step: "manager_proposal"
    }
  });
  if (!recorded.ok) return recorded;

  await writeJsonAtomic(managerSessionPath(repoRoot, session.value.session_id), {
    ...session.value,
    blocked_action: undefined,
    turns: [
      ...session.value.turns,
      { role: "user", content: `judgment requested after blocked action ${action.type}: ${blocked.result.reason}` }
    ]
  });
  return {
    ok: true,
    value: {
      session_id: session.value.session_id,
      action_type: action.type,
      status: "judgment_pending"
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

async function executeProposedManagerAction(
  repoRoot: string,
  sessionId: string,
  proposalId: string,
  action: ManagerAction,
  mode: DeterministicActionMode = "complete"
): Promise<SpecResult<ManagerActionResult>> {
  const sessionResult = await loadManagerSession(repoRoot, sessionId);
  if (!sessionResult.ok) return sessionResult;
  const proposal = requirePendingProposal(sessionResult.value, proposalId, action);
  if (!proposal.ok) return proposal;

  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) return specResult;
  if (specResult.value.spec_id !== sessionResult.value.spec_id) {
    return { ok: false, reason: `manager session ${sessionId} belongs to spec ${sessionResult.value.spec_id}, not active spec ${specResult.value.spec_id}` };
  }
  const policy = await loadManagerAutonomyPolicy(repoRoot);
  if (!policy.ok) return policy;
  const classification = await classifyManagerAction(repoRoot, action, policy.value);
  if (classification.tier === "human_approval") {
    return { ok: false, reason: "proposed manager action requires its daemon-issued pending action and exact typed approval" };
  }
  return executeAuthorizedManagerAction(repoRoot, sessionResult.value, action, proposalId, false, mode);
}

async function executeAuthorizedManagerAction(
  repoRoot: string,
  session: ManagerSession,
  action: ManagerAction,
  proposalId?: string,
  clearPendingAction = false,
  mode: DeterministicActionMode = "complete"
): Promise<SpecResult<ManagerActionResult>> {

  if (proposalId !== undefined) {
    const proposal = requirePendingProposal(session, proposalId, action);
    if (!proposal.ok) return proposal;
  }

  let result: ManagerActionExecutionRecord;
  try {
    result = await executeDeterministicAction(repoRoot, session.session_id, action, mode);
  } catch (error: unknown) {
    result = { ok: false, reason: formatErrorDetail(error, `unexpected ${action.type} failure`) };
  }
  const recordedSession = appendActionToSession(session, action, result, proposalId);
  const nextSession = clearPendingAction ? { ...recordedSession, pending_action: undefined } : recordedSession;
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
  const autonomy = await readProjectAutonomyLevel(repoRoot);
  if (!autonomy.ok) return autonomy;
  return authorizePendingManagerAction(repoRoot, request, "human", autonomy.value);
}

async function authorizePendingManagerAction(
  repoRoot: string,
  request: unknown,
  authorizationSource: "human" | "autonomy_policy",
  autonomyLevel: AutonomyLevel,
  mode: DeterministicActionMode = "complete"
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
  const proposal = requirePendingProposal(session.value, pending.proposal_id, parsedAction.value);
  if (!proposal.ok) return { ok: false, reason: `manager approval refused: ${proposal.reason}` };
  const status = await getStatus(repoRoot);
  if (!status.ok) return status;
  if (hashDurableState(status.value) !== pending.expected_state_hash) {
    return { ok: false, reason: "manager approval refused: durable state changed after the action was presented; review the refreshed action" };
  }
  const policy = await loadManagerAutonomyPolicy(repoRoot);
  if (!policy.ok) return policy;
  if (authorizationSource === "autonomy_policy" && policy.value.level !== autonomyLevel) {
    return { ok: false, reason: "manager policy authorization refused: autonomy level changed after the pending action was classified" };
  }
  const classification = await classifyManagerAction(repoRoot, parsedAction.value, policy.value);
  if (classification.tier !== "human_approval") {
    return { ok: false, reason: "manager approval refused: pending action no longer requires human approval" };
  }
  if (authorizationSource === "autonomy_policy" && !shouldSuppressManagerInterruption(autonomyLevel, classification, parsedAction.value)) {
    return { ok: false, reason: "manager policy authorization refused: this action or escalation still requires a human at the active autonomy level" };
  }
  if (mode === "start_worker" && (authorizationSource !== "autonomy_policy" || parsedAction.value.type !== "run_worker")) {
    return { ok: false, reason: "start-only worker execution is confined to autonomy-policy scheduling" };
  }
  const result = await executeAuthorizedManagerAction(repoRoot, session.value, parsedAction.value, pending.proposal_id, true, mode);
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
    blocked_action: blockedAction
  });
  const decision = await recordAutonomyDecision(repoRoot, {
    level: policy.value.level,
    session_id: session.value.session_id,
    decision: "manager_action",
    action_type: parsedAction.value.type,
    interruption: authorizationSource === "autonomy_policy" ? "suppressed" : "required",
    authorization_source: authorizationSource,
    pending_action_id: pending.pending_action_id,
    result: result.value.result.ok ? "authorized" : "refused",
    reason: result.value.result.ok ? classification.reason : result.value.result.reason
  });
  if (!decision.ok) return decision;
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
      result_ok: result.value.result.ok,
      authorization_source: authorizationSource,
      autonomy_level: policy.value.level
    }
  });
  return recorded.ok ? result : recorded;
}

function pendingRequest(sessionId: string, pending: ManagerPendingAction): Record<string, string> {
  return {
    session_id: sessionId,
    pending_action_id: pending.pending_action_id,
    action_type: pending.action_type,
    subject: pending.subject,
    expected_state_hash: pending.expected_state_hash
  };
}

function hashDurableState(status: HivemindStatus): string {
  return createHash("sha256").update(JSON.stringify(status)).digest("hex");
}

function managerActionSubject(action: ManagerAction): string {
  return "task_id" in action ? action.task_id : action.type;
}

async function executeDeterministicAction(
  repoRoot: string,
  sessionId: string,
  action: ManagerAction,
  mode: DeterministicActionMode = "complete"
): Promise<ManagerActionExecutionRecord> {
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
        startRunTaskJob(repoRoot, action.task_id, action.tool, {
          allowDangerousAdapter: action.allow_dangerous_adapter === true,
          usageSessionId: sessionId
        })
    );
    if (!started.ok) {
      return recordResult(started);
    }
    if (mode === "start_worker") {
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
  const expectation = action.expected_task_ids === undefined || action.expected_queue_sha256 === undefined
    ? undefined
    : { expected_task_ids: action.expected_task_ids, expected_queue_sha256: action.expected_queue_sha256 };
  return recordResult(
    await routeMutatingAction<IntegrationStatus>(
      repoRoot,
      "/integrate/shadow",
      expectation ?? {},
      () => integrateShadow(repoRoot, expectation)
    )
  );
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
  const contract = await loadAndValidateContract(repoRoot, taskId);
  if (contract.ok) {
    const stopped = await requestSystemTaskStop(repoRoot, {
      task_id: taskId,
      reason: `Bounded worker observation timed out: ${reason}`
    });
    if (!stopped.ok) {
      return { ok: false, reason: `${reason}; cleanup remains retryable with the lease held: ${stopped.reason}` };
    }
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
  direct: () => Promise<{ ok: true; value: T } | { ok: false; reason: string; code?: FailureCode }>
): Promise<{ ok: true; value: T } | { ok: false; reason: string; code?: FailureCode }> {
  const daemonResult = await callDaemonIfConfigured<T>(repoRoot, endpoint, body);
  return daemonResult.routed ? daemonResult : direct();
}

function recordResult<T>(
  result: { ok: true; value: T } | { ok: false; reason: string; code?: FailureCode }
): ManagerActionExecutionRecord {
  // Forward the code. Dropping it here is precisely what forced the scheduler
  // to reconstruct the run-vs-session distinction from a sentence.
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, reason: result.reason, ...(result.code === undefined ? {} : { code: result.code }) };
}

function requirePendingProposal(
  session: ManagerSession,
  proposalId: string,
  action: ManagerAction
): SpecResult<void> {
  if (session.proposal_state === undefined) {
    return { ok: false, reason: "manager session has no durable proposal identity; start a new session" };
  }
  if (session.proposal_state.proposal_id !== proposalId || session.proposal_state.status !== "pending") {
    return { ok: false, reason: "manager proposal is not the current unconsumed proposal" };
  }
  const current = currentPendingProposalAction(session, proposalId);
  if (!current.ok) return current;
  if (JSON.stringify(current.value) !== JSON.stringify(action)) {
    return { ok: false, reason: "manager proposal action does not match the current stored proposal" };
  }
  return { ok: true, value: undefined };
}

function currentPendingProposalAction(session: ManagerSession, proposalId: string): SpecResult<ManagerAction> {
  if (session.proposal_state === undefined || session.proposal_state.proposal_id !== proposalId || session.proposal_state.status !== "pending") {
    return { ok: false, reason: "manager proposal is not the current unconsumed proposal" };
  }
  const cursor = proposalCursor(session);
  if (!cursor.ok) return cursor;
  const action = session.proposed_action.actions[cursor.value];
  return action === undefined
    ? { ok: false, reason: "manager proposal cursor does not identify an unconsumed action" }
    : { ok: true, value: action };
}

function proposalCursor(session: ManagerSession): SpecResult<number> {
  const state = session.proposal_state;
  if (state === undefined) return { ok: false, reason: "manager session has no durable proposal identity" };
  if (state.next_action_index === undefined) {
    if (session.proposed_action.actions.length <= 1) {
      return { ok: true, value: state.status === "pending" ? 0 : session.proposed_action.actions.length };
    }
    return { ok: false, reason: "manager batch proposal has no durable next-action cursor" };
  }
  return { ok: true, value: state.next_action_index };
}

function lastConsumedProposalActionIndex(session: ManagerSession): SpecResult<number> {
  const cursor = proposalCursor(session);
  if (!cursor.ok) return cursor;
  const index = cursor.value - 1;
  return index >= 0 && session.proposed_action.actions[index] !== undefined
    ? { ok: true, value: index }
    : { ok: false, reason: "consumed proposal does not identify its last executed action" };
}

function appendActionToSession(
  session: ManagerSession,
  action: ManagerAction,
  result: ManagerActionExecutionRecord,
  proposalId?: string
): ManagerSession {
  const actionRecord: ManagerExecutedAction = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: action.type,
    ...("task_id" in action ? { task_id: action.task_id } : {}),
    result
  };
  let proposalState = session.proposal_state;
  if (proposalId !== undefined) {
    const cursor = proposalCursor(session);
    if (!cursor.ok) throw new Error(cursor.reason);
    const nextActionIndex = cursor.value + 1;
    const hasRemainder = nextActionIndex < session.proposed_action.actions.length;
    const now = new Date().toISOString();
    proposalState = !result.ok && hasRemainder
      ? {
          proposal_id: proposalId,
          status: "discarded",
          next_action_index: nextActionIndex,
          discarded_at: now,
          discard_reason: `action ${action.type} at index ${cursor.value} failed: ${result.reason}`
        }
      : hasRemainder
        ? { proposal_id: proposalId, status: "pending", next_action_index: nextActionIndex }
        : { proposal_id: proposalId, status: "consumed", next_action_index: nextActionIndex, consumed_at: now };
  }
  return {
    ...session,
    turns: [
      ...session.turns,
      {
        role: "manager",
        content: result.ok ? `executed ${action.type}: ok` : `executed ${action.type}: ${result.reason}`
      }
    ],
    executed_actions: [...session.executed_actions, actionRecord],
    ...(proposalState === undefined ? {} : { proposal_state: proposalState })
  };
}

export async function inspectLatestManagerSession(
  repoRoot: string,
  specId: string
): Promise<SpecResult<ManagerWorkspaceSession | null>> {
  const history = await inspectManagerSessionHistory(repoRoot);
  if (!history.ok) return history;
  const latest = history.value
    .filter((session) => session.spec_id === specId)
    .sort((left, right) =>
      right.created_at.localeCompare(left.created_at) || right.session_id.localeCompare(left.session_id)
    )[0];
  if (latest === undefined) return { ok: true, value: null };
  const { task_ids: _taskIds, evidence_path: _evidencePath, ...current } = latest;
  return { ok: true, value: current };
}

export async function inspectManagerSessionHistory(
  repoRoot: string
): Promise<SpecResult<ManagerWorkspaceHistorySession[]>> {
  let names: string[];
  try {
    names = await readdir(path.join(repoRoot, ".hivemind", "orchestrator", "sessions"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return { ok: true, value: [] };
    throw error;
  }
  const sessions: ManagerWorkspaceHistorySession[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const sessionId = name.slice(0, -".json".length);
    const loaded = await loadManagerSession(repoRoot, sessionId);
    if (!loaded.ok) return loaded;
    sessions.push(presentManagerWorkspaceHistorySession(loaded.value));
  }
  return {
    ok: true,
    value: sessions.sort((left, right) =>
      right.created_at.localeCompare(left.created_at) || right.session_id.localeCompare(left.session_id)
    )
  };
}

function presentManagerWorkspaceHistorySession(session: ManagerSession): ManagerWorkspaceHistorySession {
  const pending = session.pending_action ?? null;
  const blockedReason = session.blocked_action?.result.reason ?? null;
  const blockedCode = session.blocked_action?.result.code ?? null;
  const actionTimes = session.executed_actions
    .map((action) => action.ts)
    .filter((value) => !Number.isNaN(Date.parse(value)));
  const taskIds = session.executed_actions
    .map((action) => action.task_id)
    .filter((taskId): taskId is string => typeof taskId === "string");
  const status = pending !== null ? "paused" : blockedReason !== null ? "stopped" : session.proposed_action.actions.length === 0 ? "complete" : "active";
  const autonomyLevel = session.autonomy_level_at_start ?? "review_everything";
  return {
    session_id: session.session_id,
    spec_id: session.spec_id,
    created_at: session.created_at,
    last_activity_at: [...actionTimes, session.created_at].sort().at(-1) ?? session.created_at,
    status,
    tool: session.proposed_action.tool ?? "manager",
    call_count: session.turns.filter((turn) => turn.role === "manager").length,
    pending_action: pending,
    blocked_action_type: session.blocked_action?.action_type ?? null,
    blocked_reason: blockedReason,
    blocked_code: blockedCode,
    continuation_available: status === "active" && session.proposal_state !== undefined,
    autonomy_level: autonomyLevel,
    autonomy_levels: [autonomyLevel],
    task_ids: [...new Set(taskIds)].sort(),
    evidence_path: managerSessionRelativePath(session.session_id)
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
  const gated = checkFormatVersion(value, formatVersions.managerSession, "manager session");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (value.session_id !== sessionId) {
    return { ok: false, reason: "manager session id does not match requested session" };
  }
  if (typeof value.spec_id !== "string" || value.spec_id.trim() === "") {
    return { ok: false, reason: "manager session spec_id must be a string" };
  }
  if (value.execution_mode !== "deterministic_happy_path" && value.execution_mode !== "llm_reactive") {
    return { ok: false, reason: "manager session execution_mode is invalid" };
  }
  if (value.autonomy_level_at_start !== undefined && !isAutonomyLevel(value.autonomy_level_at_start)) {
    return { ok: false, reason: "manager session autonomy_level_at_start is invalid" };
  }
  if (!Array.isArray(value.turns)) {
    return { ok: false, reason: "manager session turns must be an array" };
  }
  if (!Array.isArray(value.executed_actions)) {
    return { ok: false, reason: "manager session executed_actions must be an array" };
  }
  if (!isRecord(value.proposed_action) || !Array.isArray(value.proposed_action.actions)) {
    return { ok: false, reason: "manager session proposed_action must contain an actions array" };
  }
  const storedActions = parseManagerActionList(value.proposed_action.actions, "manager session proposed actions");
  if (!storedActions.ok) return storedActions;
  const storedApprovals = parseHumanApprovalList(value.proposed_action.human_approval_required_for);
  if (!storedApprovals.ok) return { ok: false, reason: `manager session ${storedApprovals.reason}` };
  if (
    (value.proposed_action.source !== "adapter-generated" &&
      value.proposed_action.source !== "deterministic" &&
      value.proposed_action.source !== "scripted") ||
    typeof value.proposed_action.reason !== "string" ||
    value.proposed_action.reason.trim() === ""
  ) {
    return { ok: false, reason: "manager session proposed_action metadata is malformed" };
  }
  const storedProposalValidation = validateAutonomousSessionProposal({
    type: "proposed_actions",
    source: value.proposed_action.source,
    reason: value.proposed_action.reason,
    actions: storedActions.value,
    human_approval_required_for: storedApprovals.value
  });
  if (!storedProposalValidation.ok) {
    return { ok: false, reason: `manager session stored proposal is unsafe: ${storedProposalValidation.reason}` };
  }
  const proposedActionCount = value.proposed_action.actions.length;
  if (value.proposal_state !== undefined) {
    if (!isRecord(value.proposal_state)) return { ok: false, reason: "manager proposal_state must be an object" };
    const proposalState = value.proposal_state;
    if (
      typeof proposalState.proposal_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(proposalState.proposal_id) ||
      (proposalState.status !== "pending" && proposalState.status !== "consumed" && proposalState.status !== "discarded") ||
      (proposalState.next_action_index !== undefined &&
        (!Number.isSafeInteger(proposalState.next_action_index) ||
          Number(proposalState.next_action_index) < 0 ||
          Number(proposalState.next_action_index) > proposedActionCount)) ||
      (proposalState.next_action_index === undefined && proposedActionCount > 1) ||
      (proposalState.status === "pending" && proposalState.next_action_index === proposedActionCount) ||
      (proposalState.status === "consumed" && proposalState.next_action_index !== undefined && proposalState.next_action_index !== proposedActionCount) ||
      (proposalState.status === "pending" && proposalState.consumed_at !== undefined) ||
      (proposalState.status === "consumed" && (typeof proposalState.consumed_at !== "string" || Number.isNaN(Date.parse(proposalState.consumed_at)))) ||
      (proposalState.status === "discarded" &&
        (proposalState.next_action_index === undefined ||
          Number(proposalState.next_action_index) <= 0 ||
          Number(proposalState.next_action_index) >= proposedActionCount ||
          proposalState.consumed_at !== undefined ||
          typeof proposalState.discarded_at !== "string" ||
          Number.isNaN(Date.parse(proposalState.discarded_at)) ||
          typeof proposalState.discard_reason !== "string" ||
          proposalState.discard_reason.trim() === "")) ||
      (proposalState.status !== "discarded" && (proposalState.discarded_at !== undefined || proposalState.discard_reason !== undefined))
    ) {
      return { ok: false, reason: "manager proposal_state is malformed" };
    }
  }
  if (value.pending_action !== undefined) {
    if (!isRecord(value.pending_action)) return { ok: false, reason: "manager pending_action must be an object" };
    const pending = value.pending_action;
    const action = parseManagerAction(pending.action);
    if (
      !action.ok ||
      typeof pending.pending_action_id !== "string" ||
      typeof pending.proposal_id !== "string" ||
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
    if (
      !isRecord(value.proposal_state) ||
      value.proposal_state.status !== "pending" ||
      value.proposal_state.proposal_id !== pending.proposal_id
    ) {
      return { ok: false, reason: "manager pending_action does not identify the current unconsumed proposal" };
    }
    const pendingIndex = Number(value.proposal_state.next_action_index ?? 0);
    if (JSON.stringify(value.proposed_action.actions[pendingIndex]) !== JSON.stringify(action.value)) {
      return { ok: false, reason: "manager pending_action does not match the proposal's current action" };
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
      (blocked.result.code !== undefined && !isFailureCode(blocked.result.code)) ||
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
  if (raw.type === "get_status") {
    return Object.keys(raw).length === 1 ? { ok: true, value: { type: raw.type } } : { ok: false, reason: `${raw.type} action must not include extra fields` };
  }
  if (raw.type === "integrate_shadow") {
    const keys = Object.keys(raw);
    if (keys.length === 1) return { ok: true, value: { type: "integrate_shadow" } };
    if (
      keys.some((key) => !["type", "expected_task_ids", "expected_queue_sha256"].includes(key)) ||
      !Array.isArray(raw.expected_task_ids) ||
      !raw.expected_task_ids.every((entry) => typeof entry === "string") ||
      typeof raw.expected_queue_sha256 !== "string"
    ) {
      return { ok: false, reason: "integrate_shadow expectation requires only expected_task_ids and expected_queue_sha256" };
    }
    return {
      ok: true,
      value: {
        type: "integrate_shadow",
        expected_task_ids: raw.expected_task_ids,
        expected_queue_sha256: raw.expected_queue_sha256
      }
    };
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
