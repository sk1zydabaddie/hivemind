import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { invokeAgent } from "./adapter.js";
import { writeFileAtomic } from "./atomic.js";
import { loadConfig, type RunCeiling } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { findGitRoot } from "./repo.js";
import { verifyLeaseCoverage } from "./lease.js";
import { routeTaskProvider } from "./routing.js";
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

export interface RunTaskOptions {
  allowDangerousAdapter?: boolean;
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

  const daemonResult = await callDaemonIfConfigured<RunResult>(repoRoot, "/run", {
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
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const leaseResult = await verifyLeaseCoverage(repoRoot, taskId, contractResult.contract.allowed_files);
  if (!leaseResult.ok) {
    return leaseResult;
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

  const invokeResult = await invokeAgent(repoRoot, taskId, routeResult.value.tool, options);
  if (!invokeResult.ok) {
    return invokeResult;
  }

  const postRunResult = checkRunCeilingPostRun(ceiling, invokeResult.value.wallTimeMs);
  if (!postRunResult.ok) {
    return postRunResult;
  }

  const diffResult = await captureDiff(repoRoot, worktreeResult.value.worktree, taskId, contractResult.contract.base_commit);
  if (!diffResult.ok) {
    return diffResult;
  }

  return {
    ok: true,
    value: {
      task_id: taskId,
      status: "completed",
      tool: routeResult.value.tool,
      diff_path: diffResult.value.diffPath,
      tool_exit: invokeResult.value.exitCode,
      changed_files: diffResult.value.changedFiles
    }
  };
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
