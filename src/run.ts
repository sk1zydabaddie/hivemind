import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { invokeAgent } from "./adapter.js";
import { writeFileAtomic } from "./atomic.js";
import { loadConfig, type RunCeiling } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { appendEvent, readEvents, type HivemindEvent, type HivemindEventInput } from "./events.js";
import { verifyLeaseCoverage } from "./lease.js";
import { appendTaskOutput, type TaskOutputRecord, type TaskOutputInput } from "./output-stream.js";
import { requireTaskDependenciesIntegrated } from "./plan.js";
import { findGitRoot } from "./repo.js";
import { requirePassedWriteIntent } from "./intent.js";
import { routeTaskProvider } from "./routing.js";
import { latestTaskRunState } from "./run-state.js";
import { requireActiveSpecRatified } from "./spec.js";
import { createTaskWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
const agentLogPath = "agent.log";

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
  status: "failed" | "already_completed";
  reason?: string;
}

export interface RunTaskOptions {
  allowDangerousAdapter?: boolean;
  onEvent?: (event: HivemindEvent) => void;
  onOutput?: (record: TaskOutputRecord) => void;
}

interface PreparedRun {
  taskId: string;
  tool: string;
  worktree: string;
  baseCommit: string;
  ceiling: RunCeiling | undefined;
  allowDangerousAdapter?: boolean;
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
    await emitRunFailure(repoRoot, prepared.value, error instanceof Error ? error.message : "unexpected run failure");
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
  if (state.state === "failed") {
    const existingReason = typeof state.failed.data.reason === "string" ? state.failed.data.reason : undefined;
    return { ok: true, value: { task_id: taskId, status: "failed", ...(existingReason === undefined ? {} : { reason: existingReason }) } };
  }

  const event = await appendEvent(repoRoot, {
    type: "task.failed",
    task_id: taskId,
    data: {
      reason,
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

  const dependencyResult = await requireTaskDependenciesIntegrated(repoRoot, specResult.value.spec_id, taskId);
  if (!dependencyResult.ok && !dependencyResult.reason.includes("tentative plan not found")) {
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

  const ceiling = configResult.config.resource_policy?.run_ceiling;
  const preflightResult = checkRunCeilingPreflight(ceiling, routeResult.value.profile);
  if (!preflightResult.ok) {
    return preflightResult;
  }

  const worktreeResult = await createTaskWorktree(repoRoot, taskId);
  if (!worktreeResult.ok) {
    return worktreeResult;
  }

  const cleanResult = await verifyRunWorktreeClean(worktreeResult.value.worktree, taskId);
  if (!cleanResult.ok) {
    return cleanResult;
  }

  const acceptedEvent = await emitRunEvent(
    repoRoot,
    {
      type: "task.run_accepted",
      task_id: taskId,
      data: { tool: routeResult.value.tool, worktree: worktreeResult.value.worktree }
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
      data: { tool: routeResult.value.tool, worktree: worktreeResult.value.worktree }
    },
    options.onEvent
  );
  if (!startedEvent.ok) {
    return startedEvent;
  }

  return {
    ok: true,
    value: {
      taskId,
      tool: routeResult.value.tool,
      worktree: worktreeResult.value.worktree,
      baseCommit: contractResult.contract.base_commit,
      ceiling,
      allowDangerousAdapter: options.allowDangerousAdapter,
      onEvent: options.onEvent,
      onOutput: options.onOutput
    }
  };
}

async function finishPreparedRun(
  repoRoot: string,
  prepared: PreparedRun
): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const streamOutputWrites: Array<Promise<{ ok: true } | { ok: false; reason: string }>> = [];
  let streamOutputTail: Promise<{ ok: true } | { ok: false; reason: string }> = Promise.resolve({ ok: true });
  const invokeResult = await invokeAgent(repoRoot, prepared.taskId, prepared.tool, {
    allowDangerousAdapter: prepared.allowDangerousAdapter,
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
  const streamOutputResults = await Promise.all(streamOutputWrites);
  const failedStreamOutput = streamOutputResults.find((result) => !result.ok);
  if (failedStreamOutput !== undefined && !failedStreamOutput.ok) {
    await emitRunFailure(repoRoot, prepared, failedStreamOutput.reason);
    return failedStreamOutput;
  }
  if (!invokeResult.ok) {
    await emitRunFailure(repoRoot, prepared, invokeResult.reason);
    return invokeResult;
  }

  const postRunResult = checkRunCeilingPostRun(prepared.ceiling, invokeResult.value.wallTimeMs);
  if (!postRunResult.ok) {
    await emitRunFailure(repoRoot, prepared, postRunResult.reason, invokeResult.value.exitCode);
    return postRunResult;
  }

  const diffResult = await captureDiff(repoRoot, prepared.worktree, prepared.taskId, prepared.baseCommit);
  if (!diffResult.ok) {
    await emitRunFailure(repoRoot, prepared, diffResult.reason, invokeResult.value.exitCode);
    return diffResult;
  }

  if (invokeResult.value.exitCode !== 0) {
    const reason = `worker ${prepared.tool} exited ${invokeResult.value.exitCode}; diff captured at .hivemind/patches/${prepared.taskId}/diff.patch with ${diffResult.value.changedFiles} changed file(s)`;
    await emitRunFailure(repoRoot, prepared, reason, invokeResult.value.exitCode, diffResult.value.diffPath, diffResult.value.changedFiles);
    return {
      ok: false,
      reason
    };
  }

  const value: RunResult = {
    task_id: prepared.taskId,
    status: "completed",
    tool: prepared.tool,
    diff_path: diffResult.value.diffPath,
    tool_exit: invokeResult.value.exitCode,
    changed_files: diffResult.value.changedFiles
  };
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
      data: { ...value }
    },
    prepared.onEvent
  );
  return completed.ok ? { ok: true, value } : completed;
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
  changedFiles?: number
): Promise<void> {
  await emitRunEvent(
    repoRoot,
    {
      type: "task.failed",
      task_id: prepared.taskId,
      data: {
        tool: prepared.tool,
        reason,
        ...(toolExit === undefined ? {} : { tool_exit: toolExit }),
        ...(diffPath === undefined ? {} : { diff_path: diffPath }),
        ...(changedFiles === undefined ? {} : { changed_files: changedFiles })
      }
    },
    prepared.onEvent
  );
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
  wallTimeMs: number
): { ok: true } | { ok: false; reason: string } {
  if (ceiling?.wall_time_ms !== undefined && wallTimeMs > ceiling.wall_time_ms) {
    return { ok: false, reason: `run paused: wall-time ceiling ${ceiling.wall_time_ms}ms exceeded after ${wallTimeMs}ms` };
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
