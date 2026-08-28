import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findDangerousAdapterArgs, invokeAgent, type InvokeAgentResult } from "./adapter.js";
import type { DurableProcessIdentity } from "./process-control.js";
import { writeFileAtomic } from "./atomic.js";
import { checkpointTask, loadTaskCheckpointResumeState } from "./checkpoint.js";
import { loadConfig, type HivemindConfig, type RunCeiling } from "./config.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { formatErrorDetail } from "./error-detail.js";
import { appendEvent, readEvents, type HivemindEvent, type HivemindEventInput } from "./events.js";
import { releaseLease, verifyLeaseCoverage } from "./lease.js";
import { appendRoutingObservation, diffByteSize } from "./learned-routing.js";
import { appendTaskOutput, type TaskOutputRecord, type TaskOutputInput } from "./output-stream.js";
import { requireTaskDependenciesIntegrated } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { requirePassedWriteIntent } from "./intent.js";
import { readQuotaLedger } from "./resource-ledger.js";
import { routeTaskProvider } from "./routing.js";
import { latestTaskRunState } from "./run-state.js";
import { taskCancellationRequested } from "./task-control.js";
import { resolveTaskAuthoringBase } from "./task-authoring-base.js";
import { requireActiveSpecRatified } from "./spec.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.js";
import type { FailureCode } from "./failure-code.js";

const execFileAsync = promisify(execFile);
const agentLogPath = "agent.log";
const quotaExhaustedPauseReason = "quota_exhausted";

export interface RunResult {
  task_id: string;
  status: "completed";
  tool: string;
  diff_path: string;
  tool_exit: number;
  changed_files: number;
}

export interface RunStartResult {
  task_id: string;
  status: "started";
  tool: string;
  worktree: string;
}

export interface RunFailureMarkResult {
  task_id: string;
  status: "failed" | "already_completed" | "already_cancelled";
  reason?: string;
}

export interface RunTaskOptions {
  allowDangerousAdapter?: boolean;
  predictiveQuotaRecovery?: boolean;
  usageSessionId?: string;
  onEvent?: (event: HivemindEvent) => void;
  onOutput?: (record: TaskOutputRecord) => void;
}

interface PreparedRun {
  runId: string;
  taskId: string;
  tool: string;
  worktree: string;
  baseCommit: string;
  contract: TaskContract;
  config: HivemindConfig;
  ceiling: RunCeiling | undefined;
  handoffFrom: string | null;
  allowDangerousAdapter?: boolean;
  usageSessionId?: string;
  onEvent?: (event: HivemindEvent) => void;
  onOutput?: (record: TaskOutputRecord) => void;
}

export async function runCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<RunStartResult>(repoRoot, "/run", {
    task_id: parsed.value.taskId,
    ...(parsed.value.tool === undefined ? {} : { tool: parsed.value.tool }),
    allow_dangerous_adapter: parsed.value.allowDangerousAdapter
  });
  const result = daemonResult.routed
    ? daemonResult
    : await runTask(repoRoot, parsed.value.taskId, parsed.value.tool, { allowDangerousAdapter: parsed.value.allowDangerousAdapter });
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function runTask(
  repoRoot: string,
  taskId: string,
  tool?: string,
  options: RunTaskOptions = {}
): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const prepared = await prepareRunTask(repoRoot, taskId, tool, options);
  if (!prepared.ok) {
    return prepared;
  }
  return finishPreparedRun(repoRoot, prepared.value);
}

export async function startRunTaskJob(
  repoRoot: string,
  taskId: string,
  tool: string | undefined,
  options: RunTaskOptions = {}
): Promise<{ ok: true; value: RunStartResult } | { ok: false; reason: string }> {
  const prepared = await prepareRunTask(repoRoot, taskId, tool, options);
  if (!prepared.ok) {
    return prepared;
  }

  void finishPreparedRun(repoRoot, prepared.value).catch(async (error: unknown) => {
    const failed = await emitRunFailure(repoRoot, prepared.value, formatErrorDetail(error, "unexpected run failure"));
    if (!failed.ok) {
      console.error(`error: ${failed.reason}`);
    }
  });

  return {
    ok: true,
    value: {
      task_id: taskId,
      status: "started",
      tool: prepared.value.tool,
      worktree: prepared.value.worktree
    }
  };
}

export async function markRunFailed(
  repoRoot: string,
  taskId: string,
  reason: string,
  data: Record<string, unknown> = {}
): Promise<{ ok: true; value: RunFailureMarkResult } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const state = latestTaskRunState(events.value, taskId);
  if (state.state === "completed") {
    return { ok: true, value: { task_id: taskId, status: "already_completed" } };
  }
  if (state.state === "cancelled") {
    return { ok: true, value: { task_id: taskId, status: "already_cancelled" } };
  }
  if (state.state === "failed") {
    const existingReason = typeof state.failed.data.reason === "string" ? state.failed.data.reason : undefined;
    return { ok: true, value: { task_id: taskId, status: "failed", ...(existingReason === undefined ? {} : { reason: existingReason }) } };
  }

  const event = await appendEvent(repoRoot, {
    type: "task.failed",
    task_id: taskId,
    data: {
      reason,
      lease_released: [],
      lease_held_for_retry: true,
      stop_retryable: true,
      cleanup_complete: false,
      terminal: true,
      ...data
    }
  });
  if (!event.ok) {
    return event;
  }
  return { ok: true, value: { task_id: taskId, status: "failed", reason } };
}

async function prepareRunTask(
  repoRoot: string,
  taskId: string,
  tool: string | undefined,
  options: RunTaskOptions
): Promise<{ ok: true; value: PreparedRun } | { ok: false; reason: string }> {
  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }

  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const leaseResult = await verifyLeaseCoverage(repoRoot, taskId, contractResult.contract.allowed_files, {
    baseCommit: contractResult.contract.base_commit,
    allowedFileIntents: contractResult.contract.allowed_file_intents
  });
  if (!leaseResult.ok) {
    return leaseResult;
  }

  // See lease.ts: the callee already handles a planless project, and never
  // returns this reason, so the string check here was an unreachable
  // fail-open.
  const dependencyResult = await requireTaskDependenciesIntegrated(repoRoot, specResult.value.spec_id, taskId);
  if (!dependencyResult.ok) {
    return dependencyResult;
  }

  const intentResult = await requirePassedWriteIntent(repoRoot, taskId);
  if (!intentResult.ok) {
    return intentResult;
  }

  const routeResult = await routeTaskProvider(repoRoot, contractResult.contract, configResult.config, tool);
  if (!routeResult.ok) {
    return routeResult;
  }
  let selectedTool = routeResult.value.tool;
  const dangerousArgs = findDangerousAdapterArgs(routeResult.value.profile.invoke);
  if (dangerousArgs.length > 0 && options.allowDangerousAdapter !== true) {
    return {
      ok: false,
      reason: `adapter profile "${selectedTool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); rerun with --allow-dangerous-adapter only for approved disposable gate runs`
    };
  }

  const ceiling = configResult.config.resource_policy?.run_ceiling;
  const preflightResult = checkRunCeilingPreflight(ceiling, routeResult.value.profile);
  if (!preflightResult.ok) {
    return preflightResult;
  }

  const worktreeResult = await createTaskWorktree(repoRoot, taskId);
  if (!worktreeResult.ok) {
    return worktreeResult;
  }
  const authoringBase = await resolveTaskAuthoringBase(repoRoot, contractResult.contract);
  if (!authoringBase.ok) {
    return authoringBase;
  }

  const quotaPauseResume = await loadQuotaPauseResumeState(repoRoot, taskId);
  if (!quotaPauseResume.ok) {
    return quotaPauseResume;
  }
  if (quotaPauseResume.value === null) {
    const cleanResult = await verifyRunWorktreeClean(worktreeResult.value.worktree, taskId);
    if (!cleanResult.ok) {
      return cleanResult;
    }
  } else {
    const resumedEvent = await emitRunEvent(
      repoRoot,
      {
        type: "task.resumed",
        task_id: taskId,
        data: {
          tool: selectedTool,
          snapshot_path: quotaPauseResume.value.snapshot_path,
          source: "quota-reset-resume"
        }
      },
      options.onEvent
    );
    if (!resumedEvent.ok) {
      return resumedEvent;
    }
  }

  if (options.predictiveQuotaRecovery !== false && (await providerHasObservedQuotaWall(repoRoot, selectedTool))) {
    const predictive = await checkpointAndRerouteTask(repoRoot, {
      taskId,
      fromTool: selectedTool,
      excludeTools: [selectedTool],
      contract: contractResult.contract,
      config: configResult.config,
      ceiling,
      mode: "predictive",
      onEvent: options.onEvent
    });
    if (predictive.ok) {
      if (predictive.value.status === "paused") {
        return {
          ok: false,
          reason: `task paused awaiting quota reset: ${predictive.value.reason}`
        };
      }
      selectedTool = predictive.value.tool;
    }
  }

  const runId = randomUUID();
  const acceptedEvent = await emitRunEvent(
    repoRoot,
    {
      type: "task.run_accepted",
      task_id: taskId,
      data: {
        run_id: runId,
        tool: selectedTool,
        routing_task_type: contractResult.contract.routing_task_type,
        worktree: worktreeResult.value.worktree,
        contract_base_commit: contractResult.contract.base_commit,
        authoring_base_commit: authoringBase.value.commit,
        dependency_verification_id: authoringBase.value.verification_id
      }
    },
    options.onEvent
  );
  if (!acceptedEvent.ok) {
    return acceptedEvent;
  }

  const startedEvent = await emitRunEvent(
    repoRoot,
    {
      type: "task.started",
      task_id: taskId,
      data: {
        run_id: runId,
        tool: selectedTool,
        routing_task_type: contractResult.contract.routing_task_type,
        worktree: worktreeResult.value.worktree,
        contract_base_commit: contractResult.contract.base_commit,
        authoring_base_commit: authoringBase.value.commit,
        dependency_verification_id: authoringBase.value.verification_id
      }
    },
    options.onEvent
  );
  if (!startedEvent.ok) {
    return startedEvent;
  }

  return {
    ok: true,
    value: {
      runId,
      taskId,
      tool: selectedTool,
      worktree: worktreeResult.value.worktree,
      baseCommit: authoringBase.value.commit,
      contract: contractResult.contract,
      config: configResult.config,
      ceiling,
      handoffFrom: null,
      allowDangerousAdapter: options.allowDangerousAdapter,
      usageSessionId: options.usageSessionId,
      onEvent: options.onEvent,
      onOutput: options.onOutput
    }
  };
}

async function finishPreparedRun(
  repoRoot: string,
  prepared: PreparedRun
): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const exhaustedTools: string[] = [];
  let active = prepared;
  while (true) {
    const attempt = await finishPreparedRunAttempt(repoRoot, active);
    if (!attempt.ok && attempt.throttled) {
      exhaustedTools.push(active.tool);
      const reroute = await checkpointAndRerouteTask(repoRoot, {
        taskId: active.taskId,
        fromTool: active.tool,
        excludeTools: exhaustedTools,
        contract: active.contract,
        config: active.config,
        ceiling: active.ceiling,
        mode: "reactive",
        onEvent: active.onEvent
      });
      if (!reroute.ok) {
        const reason = `${attempt.reason}; quota-wall recovery failed: ${reroute.reason}`;
        const failed = await emitRunFailure(repoRoot, active, reason, attempt.toolExit, attempt.diffPath, attempt.changedFiles);
        return failed.ok ? { ok: false, reason } : failed;
      }
      if (reroute.value.status === "paused") {
        const reason = `${attempt.reason}; task paused awaiting quota reset: ${reroute.value.reason}`;
        return { ok: false, reason };
      }
      const rerouteRunId = randomUUID();
      const startedEvent = await emitRunEvent(
        repoRoot,
        {
          type: "task.started",
          task_id: active.taskId,
          data: {
            run_id: rerouteRunId,
            tool: reroute.value.tool,
            routing_task_type: active.contract.routing_task_type,
            worktree: active.worktree,
            resumed_from_checkpoint: reroute.value.snapshot_path
          }
        },
        active.onEvent
      );
      if (!startedEvent.ok) {
        const failed = await emitRunFailure(repoRoot, active, startedEvent.reason, attempt.toolExit, attempt.diffPath, attempt.changedFiles);
        return failed.ok ? startedEvent : failed;
      }
      active = {
        ...active,
        runId: rerouteRunId,
        handoffFrom: active.tool,
        tool: reroute.value.tool
      };
      continue;
    }
    return attempt.ok ? { ok: true, value: attempt.value } : { ok: false, reason: attempt.reason };
  }
}

async function finishPreparedRunAttempt(
  repoRoot: string,
  prepared: PreparedRun
): Promise<
  | { ok: true; value: RunResult }
  | { ok: false; reason: string; throttled?: boolean; toolExit?: number; diffPath?: string; changedFiles?: number }
> {
  const streamOutputWrites: Array<Promise<{ ok: true } | { ok: false; reason: string }>> = [];
  let streamOutputTail: Promise<{ ok: true } | { ok: false; reason: string }> = Promise.resolve({ ok: true });
  const workerProcessIdentities: DurableProcessIdentity[] = [];
  const invokeResult = await invokeAgent(repoRoot, prepared.taskId, prepared.tool, {
    allowDangerousAdapter: prepared.allowDangerousAdapter,
    usageSessionId: prepared.usageSessionId,
    shouldCancel: () => taskCancellationRequested(repoRoot, prepared.taskId),
    onProcessStart: async (identity) => {
      const recorded = await emitRunEvent(
        repoRoot,
        {
          type: "task.worker_process_started",
          task_id: prepared.taskId,
          data: {
            version: 1,
            run_id: prepared.runId,
            tool: prepared.tool,
            pid: identity.pid,
            process_instance_id: identity.process_instance_id,
            // Recorded so a later stop can prove the whole TREE dead. Without
            // it the trail cannot say what group the worker led, and a stop
            // has to refuse rather than kill one process and call it done.
            process_group_id: identity.process_group_id ?? null
          }
        },
        prepared.onEvent
      );
      if (recorded.ok) workerProcessIdentities.push(identity);
      return recorded.ok ? { ok: true as const } : recorded;
    },
    onStreamChunk: (chunk) => {
      streamOutputTail = streamOutputTail.then((previous) =>
        previous.ok
          ? emitTaskOutput(
              repoRoot,
              {
                task_id: prepared.taskId,
                tool: prepared.tool,
                stream: chunk.stream,
                text: chunk.text
              },
              prepared.onOutput
            )
          : previous
      );
      streamOutputWrites.push(streamOutputTail);
    }
  });
  const workerProcessIdentity = workerProcessIdentities.at(-1);
  if (workerProcessIdentity !== undefined) {
    const stopped = await emitRunEvent(
      repoRoot,
      {
        type: "task.worker_process_stopped",
        task_id: prepared.taskId,
        data: {
          version: 1,
          run_id: prepared.runId,
          pid: workerProcessIdentity.pid,
          process_instance_id: workerProcessIdentity.process_instance_id,
          adapter_result: invokeResult.ok ? "closed" : "failed_after_start"
        }
      },
      prepared.onEvent
    );
    if (!stopped.ok) return stopped;
  }
  const streamOutputResults = await Promise.all(streamOutputWrites);
  const failedStreamOutput = streamOutputResults.find((result) => !result.ok);
  if (failedStreamOutput !== undefined && !failedStreamOutput.ok) {
    const failed = await emitRunFailure(repoRoot, prepared, failedStreamOutput.reason);
    return failed.ok ? failedStreamOutput : failed;
  }
  if (!invokeResult.ok) {
    if (invokeResult.budget_exceeded === true) {
      const paused = await emitRunQuotaPause(repoRoot, prepared, invokeResult.reason, invokeResult.code);
      return paused.ok ? invokeResult : paused;
    }
    const failed = await emitRunFailure(
      repoRoot,
      prepared,
      invokeResult.reason,
      invokeResult.exitCode,
      undefined,
      undefined,
      { preserveWorktree: false }
    );
    return failed.ok ? invokeResult : failed;
  }

  if (invokeResult.value.cancelled === true || await taskCancellationRequested(repoRoot, prepared.taskId)) {
    const terminal = await readEvents(repoRoot);
    if (!terminal.ok) return terminal;
    const stopState = latestTaskRunState(terminal.value, prepared.taskId);
    const reason = stopState.state === "failed" && stopState.failed.data.stop_attempt === true && typeof stopState.failed.data.reason === "string"
      ? stopState.failed.data.reason
      : `task ${prepared.taskId} cancelled by durable human request`;
    return { ok: false, reason, toolExit: invokeResult.value.exitCode };
  }

  if (invokeResult.value.throttled) {
    await recordRoutingObservationBestEffort(repoRoot, prepared, invokeResult.value, 0);
    return {
      ok: false,
      reason:
        invokeResult.value.failureReason === null
          ? `worker ${prepared.tool} hit a quota wall`
          : `worker ${prepared.tool} hit a quota wall; ${invokeResult.value.failureReason}`,
      throttled: true,
      toolExit: invokeResult.value.exitCode
    };
  }

  const postRunResult = checkRunCeilingPostRun(
    prepared.ceiling,
    invokeResult.value.wallTimeMs,
    invokeResult.value.effectiveTokens
  );
  if (!postRunResult.ok) {
    await recordRoutingObservationBestEffort(repoRoot, prepared, invokeResult.value, 0);
    const paused = await emitRunQuotaPause(repoRoot, prepared, postRunResult.reason);
    return paused.ok ? postRunResult : paused;
  }

  const diffResult = await captureDiff(repoRoot, prepared.worktree, prepared.taskId, prepared.baseCommit);
  if (!diffResult.ok) {
    await recordRoutingObservationBestEffort(repoRoot, prepared, invokeResult.value, 0);
    const failed = await emitRunFailure(repoRoot, prepared, diffResult.reason, invokeResult.value.exitCode);
    return failed.ok ? diffResult : failed;
  }

  if (invokeResult.value.exitCode !== 0) {
    await recordRoutingObservationBestEffort(
      repoRoot,
      prepared,
      invokeResult.value,
      await diffByteSize(diffResult.value.diffPath)
    );
    const processFailure =
      invokeResult.value.failureReason ?? `worker "${prepared.tool}" exited ${invokeResult.value.exitCode}`;
    const reason = `${processFailure}; diff captured at .hivemind/patches/${prepared.taskId}/diff.patch with ${diffResult.value.changedFiles} changed file(s)`;
    const failed = await emitRunFailure(repoRoot, prepared, reason, invokeResult.value.exitCode, diffResult.value.diffPath, diffResult.value.changedFiles);
    return failed.ok
      ? {
          ok: false,
          reason
        }
      : failed;
  }

  const value: RunResult = {
    task_id: prepared.taskId,
    status: "completed",
    tool: prepared.tool,
    diff_path: diffResult.value.diffPath,
    tool_exit: invokeResult.value.exitCode,
    changed_files: diffResult.value.changedFiles
  };
  await recordRoutingObservationBestEffort(
    repoRoot,
    prepared,
    invokeResult.value,
    await diffByteSize(diffResult.value.diffPath)
  );
  const terminal = await readEvents(repoRoot);
  if (!terminal.ok) {
    return terminal;
  }
  const terminalState = latestTaskRunState(terminal.value, prepared.taskId);
  if (terminalState.state === "failed") {
    const reason = typeof terminalState.failed.data.reason === "string" ? terminalState.failed.data.reason : "worker run already marked failed";
    return { ok: false, reason: `task ${prepared.taskId} already has terminal task.failed event: ${reason}` };
  }
  const completed = await emitRunEvent(
    repoRoot,
    {
      type: "task.completed",
      task_id: prepared.taskId,
      data: {
        ...value,
        run_id: prepared.runId,
        routing_task_type: prepared.contract.routing_task_type
      }
    },
    prepared.onEvent
  );
  return completed.ok ? { ok: true, value } : completed;
}

interface RerouteInput {
  taskId: string;
  fromTool: string;
  excludeTools: string[];
  contract: TaskContract;
  config: HivemindConfig;
  ceiling: RunCeiling | undefined;
  mode: "predictive" | "reactive";
  onEvent?: (event: HivemindEvent) => void;
}

async function checkpointAndRerouteTask(
  repoRoot: string,
  input: RerouteInput
): Promise<
  | { ok: true; value: { status: "rerouted"; tool: string; snapshot_path: string } }
  | { ok: true; value: { status: "paused"; snapshot_path: string; reason: string } }
  | { ok: false; reason: string }
> {
  const checkpoint = await checkpointTask(repoRoot, input.taskId);
  if (!checkpoint.ok) {
    return checkpoint;
  }
  const resumeState = await loadTaskCheckpointResumeState(repoRoot, input.taskId);
  if (!resumeState.ok) {
    return resumeState;
  }
  const route = await routeTaskProvider(repoRoot, input.contract, input.config, undefined, { excludeTools: input.excludeTools });
  if (!route.ok) {
    const paused = await emitRunEvent(
      repoRoot,
      {
        type: "task.paused",
        task_id: input.taskId,
        data: {
          reason: quotaExhaustedPauseReason,
          source: "quota-wall-recovery",
          mode: input.mode,
          from_tool: input.fromTool,
          exhausted_tools: input.excludeTools,
          providers_walled: input.excludeTools,
          snapshot_path: checkpoint.value.snapshot_path,
          reroute_reason: route.reason,
          awaiting: "quota_reset_or_provider_available"
        }
      },
      input.onEvent
    );
    if (!paused.ok) {
      return paused;
    }
    return { ok: true, value: { status: "paused", snapshot_path: checkpoint.value.snapshot_path, reason: route.reason } };
  }
  const ceiling = checkRunCeilingPreflight(input.ceiling, route.value.profile);
  if (!ceiling.ok) {
    return ceiling;
  }
  const rerouted = await emitRunEvent(
    repoRoot,
    {
      type: "task.rerouted",
      task_id: input.taskId,
      data: {
        mode: input.mode,
        from_tool: input.fromTool,
        to_tool: route.value.tool,
        snapshot_path: checkpoint.value.snapshot_path,
        context_pack_ref: resumeState.value.context_pack.path,
        task_knowledge_ref: resumeState.value.task_knowledge.path
      }
    },
    input.onEvent
  );
  if (!rerouted.ok) {
    return rerouted;
  }
  const resumed = await emitRunEvent(
    repoRoot,
    {
      type: "task.resumed",
      task_id: input.taskId,
      data: {
        tool: route.value.tool,
        snapshot_path: checkpoint.value.snapshot_path,
        source: "quota-wall-recovery"
      }
    },
    input.onEvent
  );
  if (!resumed.ok) {
    return resumed;
  }
  return { ok: true, value: { status: "rerouted", tool: route.value.tool, snapshot_path: checkpoint.value.snapshot_path } };
}

async function loadQuotaPauseResumeState(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: null | { snapshot_path: string } } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }

  let pause: HivemindEvent | null = null;
  for (const event of events.value) {
    if (event.task_id !== taskId) {
      continue;
    }
    if (event.type === "task.paused" && event.data.reason === quotaExhaustedPauseReason) {
      pause = event;
      continue;
    }
    if (pause !== null && (event.type === "task.started" || event.type === "task.completed" || event.type === "task.failed")) {
      pause = null;
    }
  }

  if (pause === null) {
    return { ok: true, value: null };
  }

  const resumeState = await loadTaskCheckpointResumeState(repoRoot, taskId);
  if (!resumeState.ok) {
    return resumeState;
  }
  const snapshotPath = typeof pause.data.snapshot_path === "string" ? pause.data.snapshot_path : `.hivemind/resource/checkpoints/${taskId}.snapshot.json`;
  return { ok: true, value: { snapshot_path: snapshotPath } };
}

async function providerHasObservedQuotaWall(repoRoot: string, tool: string): Promise<boolean> {
  const ledger = await readQuotaLedger(repoRoot);
  if (!ledger.ok) {
    return false;
  }
  const entry = ledger.value[tool];
  return entry?.observed_limit !== null && entry?.observed_limit !== undefined && entry.unmetered !== true;
}

async function emitRunEvent(
  repoRoot: string,
  input: HivemindEventInput,
  onEvent: ((event: HivemindEvent) => void) | undefined
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const eventResult = await appendEvent(repoRoot, input);
  if (!eventResult.ok) {
    return eventResult;
  }
  onEvent?.(eventResult.value);
  return { ok: true };
}

async function emitTaskOutput(
  repoRoot: string,
  input: TaskOutputInput,
  onOutput: ((record: TaskOutputRecord) => void) | undefined
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const outputResult = await appendTaskOutput(repoRoot, input);
  if (!outputResult.ok) {
    return outputResult;
  }
  onOutput?.(outputResult.value);
  return { ok: true };
}

async function emitRunFailure(
  repoRoot: string,
  prepared: PreparedRun,
  reason: string,
  toolExit?: number,
  diffPath?: string,
  changedFiles?: number,
  options: { preserveWorktree?: boolean } = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (options.preserveWorktree !== true) {
    const archived = await archiveFailedRunLog(repoRoot, prepared.taskId, prepared.worktree);
    if (!archived.ok) {
      return emitRunEvent(
        repoRoot,
        {
          type: "task.failed",
          task_id: prepared.taskId,
          data: {
            run_id: prepared.runId,
            tool: prepared.tool,
            routing_task_type: prepared.contract.routing_task_type,
            reason: `${reason}; failed-task log archival incomplete: ${archived.reason}`,
            lease_released: [],
            worktree_removed: false,
            lease_held_for_retry: true,
            stop_retryable: true,
            cleanup_complete: false,
            failure_stage: "log_archival",
            terminal: true
          }
        },
        prepared.onEvent
      );
    }
    const worktree = await removeTaskWorktree(repoRoot, prepared.taskId, { discardChanges: true });
    if (!worktree.ok) {
      return emitRunEvent(
        repoRoot,
        {
          type: "task.failed",
          task_id: prepared.taskId,
          data: {
            run_id: prepared.runId,
            tool: prepared.tool,
            routing_task_type: prepared.contract.routing_task_type,
            reason: `${reason}; failed-task worktree cleanup incomplete: ${worktree.reason}`,
            lease_released: [],
            worktree_removed: false,
            lease_held_for_retry: true,
            stop_retryable: true,
            cleanup_complete: false,
            failure_stage: "worktree_cleanup",
            terminal: true,
            ...(toolExit === undefined ? {} : { tool_exit: toolExit }),
            ...(diffPath === undefined ? {} : { diff_path: diffPath }),
            ...(changedFiles === undefined ? {} : { changed_files: changedFiles })
          }
        },
        prepared.onEvent
      );
    }
  }
  let releasedFiles: string[] | undefined;
  if (options.preserveWorktree !== true) {
    const released = await releaseLease(repoRoot, prepared.taskId);
    if (!released.ok) {
      return emitRunEvent(
        repoRoot,
        {
          type: "task.failed",
          task_id: prepared.taskId,
          data: {
            run_id: prepared.runId,
            tool: prepared.tool,
            routing_task_type: prepared.contract.routing_task_type,
            reason: `${reason}; failed-task lease release incomplete: ${released.reason}`,
            lease_released: [],
            worktree_removed: true,
            lease_held_for_retry: true,
            stop_retryable: true,
            cleanup_complete: false,
            failure_stage: "lease_release",
            terminal: true
          }
        },
        prepared.onEvent
      );
    }
    releasedFiles = released.value.released;
  }

  return emitRunEvent(
    repoRoot,
    {
      type: "task.failed",
      task_id: prepared.taskId,
      data: {
        run_id: prepared.runId,
        tool: prepared.tool,
        routing_task_type: prepared.contract.routing_task_type,
        reason,
        ...(releasedFiles === undefined ? {} : { lease_released: releasedFiles }),
        worktree_removed: options.preserveWorktree !== true,
        lease_held_for_retry: options.preserveWorktree === true,
        cleanup_complete: options.preserveWorktree !== true,
        terminal: true,
        ...(toolExit === undefined ? {} : { tool_exit: toolExit }),
        ...(diffPath === undefined ? {} : { diff_path: diffPath }),
        ...(changedFiles === undefined ? {} : { changed_files: changedFiles })
      }
    },
    prepared.onEvent
  );
}

async function emitRunQuotaPause(
  repoRoot: string,
  prepared: PreparedRun,
  reason: string,
  code?: FailureCode
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return emitRunEvent(
    repoRoot,
    {
      type: "task.paused",
      task_id: prepared.taskId,
      data: {
        version: 1,
        run_id: prepared.runId,
        tool: prepared.tool,
        routing_task_type: prepared.contract.routing_task_type,
        reason: "quota_exhausted",
        reroute_reason: reason,
        // The scheduler reads this to decide whether a whole wave stops for
        // budget or one lane failed. It used to regex reroute_reason.
        reroute_code: code ?? null,
        checkpoint_preserved: true,
        worktree_preserved: true,
        lease_preserved: true,
        terminal: true
      }
    },
    prepared.onEvent
  );
}

async function archiveFailedRunLog(
  repoRoot: string,
  taskId: string,
  worktreePath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const destinationDir = path.join(repoRoot, ".hivemind", "patches", taskId);
    await mkdir(destinationDir, { recursive: true });
    await copyFile(path.join(worktreePath, agentLogPath), path.join(destinationDir, agentLogPath));
    return { ok: true };
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ok: true };
    }
    return { ok: false, reason: formatErrorDetail(error, "unknown log archival failure") };
  }
}

async function recordRoutingObservationBestEffort(
  repoRoot: string,
  prepared: PreparedRun,
  result: InvokeAgentResult,
  diffBytes: number
): Promise<void> {
  const recorded = await appendRoutingObservation(repoRoot, prepared.taskId, {
    version: 1,
    run_id: prepared.runId,
    provider: prepared.tool,
    routing_task_type: prepared.contract.routing_task_type,
    request_count: 1,
    wall_time_ms: result.wallTimeMs,
    self_measured_tokens: result.selfMeasuredTokens,
    provider_reported_tokens: result.providerReportedTokens,
    effective_tokens: result.effectiveTokens,
    cost_source: result.accountingSource,
    diff_bytes: diffBytes,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    handoff_from: prepared.handoffFrom
  });
  if (!recorded.ok) {
    console.error(`warning: routing observation was not recorded for ${prepared.taskId}: ${recorded.reason}`);
  }
}

function parseRunArgs(
  args: string[]
): { ok: true; value: { taskId: string; tool?: string; allowDangerousAdapter: boolean } } | { ok: false; reason: string } {
  const [taskId, ...rest] = args;
  if (!taskId) {
    return { ok: false, reason: "usage: hivemind run <id> [--tool <tool>] [--allow-dangerous-adapter]" };
  }

  let tool: string | undefined;
  let allowDangerousAdapter = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--tool") {
      const value = rest[index + 1];
      if (!value || tool !== undefined) {
        return { ok: false, reason: "usage: hivemind run <id> [--tool <tool>] [--allow-dangerous-adapter]" };
      }
      tool = value;
      index += 1;
      continue;
    }
    if (arg === "--allow-dangerous-adapter") {
      allowDangerousAdapter = true;
      continue;
    }
    return { ok: false, reason: "usage: hivemind run <id> [--tool <tool>] [--allow-dangerous-adapter]" };
  }

  return { ok: true, value: { taskId, ...(tool === undefined ? {} : { tool }), allowDangerousAdapter } };
}

function checkRunCeilingPreflight(
  ceiling: RunCeiling | undefined,
  profile: { tool: string; timeout_ms?: number }
): { ok: true } | { ok: false; reason: string } {
  if (ceiling?.requests !== undefined && ceiling.requests < 1) {
    return { ok: false, reason: `run paused: request ceiling ${ceiling.requests} would be exceeded before invoking ${profile.tool}` };
  }
  if (ceiling?.tokens !== undefined && ceiling.tokens < 1) {
    return { ok: false, reason: `run paused: token ceiling ${ceiling.tokens} forbids invoking ${profile.tool}` };
  }
  if (ceiling?.wall_time_ms !== undefined && profile.timeout_ms !== undefined && profile.timeout_ms > ceiling.wall_time_ms) {
    return {
      ok: false,
      reason: `run paused: ${profile.tool} timeout ${profile.timeout_ms}ms exceeds wall-time ceiling ${ceiling.wall_time_ms}ms`
    };
  }
  return { ok: true };
}

function checkRunCeilingPostRun(
  ceiling: RunCeiling | undefined,
  wallTimeMs: number,
  effectiveTokens: number
): { ok: true } | { ok: false; reason: string } {
  if (ceiling?.wall_time_ms !== undefined && wallTimeMs > ceiling.wall_time_ms) {
    return { ok: false, reason: `run paused: wall-time ceiling ${ceiling.wall_time_ms}ms exceeded after ${wallTimeMs}ms` };
  }
  if (ceiling?.tokens !== undefined && effectiveTokens > ceiling.tokens) {
    return { ok: false, reason: `run paused: token ceiling ${ceiling.tokens} exceeded after ${effectiveTokens} effective tokens` };
  }
  return { ok: true };
}

async function captureDiff(
  repoRoot: string,
  worktreePath: string,
  taskId: string,
  baseCommit: string
): Promise<{ ok: true; value: { diffPath: string; changedFiles: number } } | { ok: false; reason: string }> {
  const diffResult = await captureWorktreeDiff(worktreePath, baseCommit, { excludeUntracked: [agentLogPath] });
  if (!diffResult.ok) {
    return diffResult;
  }

  const patchDir = path.join(repoRoot, ".hivemind", "patches", taskId);
  const diffPath = path.join(patchDir, "diff.patch");
  await writeFileAtomic(diffPath, diffResult.value.diff);

  return {
    ok: true,
    value: {
      diffPath,
      changedFiles: diffResult.value.changedFiles
    }
  };
}

async function verifyRunWorktreeClean(worktreePath: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const statusResult = await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!statusResult.ok) {
    return statusResult;
  }

  const dirtyPaths = parseStatusPaths(statusResult.stdout).filter((entry) => normalizeGitPath(entry) !== agentLogPath);
  if (dirtyPaths.length > 0) {
    return {
      ok: false,
      reason: `worktree .hivemind/worktrees/${taskId} has existing changes (${dirtyPaths.join(", ")}); remove it or reset before rerun`
    };
  }

  return { ok: true };
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
    return { ok: true, stdout: result.stdout };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function parseStatusPaths(statusOutput: string): string[] {
  return statusOutput
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(3));
}
