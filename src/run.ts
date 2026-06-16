import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { invokeAgent } from "./adapter.js";
import { writeFileAtomic } from "./atomic.js";
import { loadAndValidateContract } from "./contract.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { findGitRoot } from "./repo.js";
import { createTaskWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
const agentLogPath = "agent.log";

export interface RunResult {
  task_id: string;
  diff_path: string;
  tool_exit: number;
  changed_files: number;
}

export interface RunTaskOptions {
  allowDangerousAdapter?: boolean;
}

export async function runCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, flag, tool, ...rest] = args;
  const allowDangerousAdapter = rest.length === 1 && rest[0] === "--allow-dangerous-adapter";
  if (!taskId || flag !== "--tool" || !tool || (rest.length > 0 && !allowDangerousAdapter)) {
    console.error("error: usage: hivemind run <id> --tool <tool> [--allow-dangerous-adapter]");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await runTask(repoRoot, taskId, tool, { allowDangerousAdapter });
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
  tool: string,
  options: RunTaskOptions = {}
): Promise<{ ok: true; value: RunResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const worktreeResult = await createTaskWorktree(repoRoot, taskId);
  if (!worktreeResult.ok) {
    return worktreeResult;
  }

  const cleanResult = await verifyRunWorktreeClean(worktreeResult.value.worktree, taskId);
  if (!cleanResult.ok) {
    return cleanResult;
  }

  const invokeResult = await invokeAgent(repoRoot, taskId, tool, options);
  if (!invokeResult.ok) {
    return invokeResult;
  }

  const diffResult = await captureDiff(repoRoot, worktreeResult.value.worktree, taskId, contractResult.contract.base_commit);
  if (!diffResult.ok) {
    return diffResult;
  }

  return {
    ok: true,
    value: {
      task_id: taskId,
      diff_path: diffResult.value.diffPath,
      tool_exit: invokeResult.value.exitCode,
      changed_files: diffResult.value.changedFiles
    }
  };
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
