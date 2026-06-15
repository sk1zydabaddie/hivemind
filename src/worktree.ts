import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadContract, normalizeContract, validateContract } from "./contract.js";
import { findGitRoot } from "./repo.js";

const execFileAsync = promisify(execFile);

export interface WorktreeResult {
  worktree: string;
  branch: string;
}

export async function worktreeCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, flag, ...rest] = args;
  if (!taskId || (flag !== undefined && flag !== "--remove") || rest.length > 0) {
    console.error("error: usage: hivemind worktree <id> [--remove]");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = flag === "--remove" ? await removeTaskWorktree(repoRoot, taskId) : await createTaskWorktree(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function createTaskWorktree(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: WorktreeResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const value = getWorktreeResult(repoRoot, taskId);
  if (await exists(value.worktree)) {
    return { ok: true, value };
  }

  await mkdir(path.dirname(value.worktree), { recursive: true });
  const gitResult = await git(repoRoot, [
    "worktree",
    "add",
    path.join(".hivemind", "worktrees", taskId),
    "-b",
    value.branch,
    contractResult.contract.base_commit
  ]);
  if (!gitResult.ok) {
    return { ok: false, reason: gitResult.reason };
  }

  return { ok: true, value };
}

export async function removeTaskWorktree(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: WorktreeResult } | { ok: false; reason: string }> {
  const value = getWorktreeResult(repoRoot, taskId);
  if (await exists(value.worktree)) {
    const removeResult = await git(repoRoot, ["worktree", "remove", path.join(".hivemind", "worktrees", taskId)]);
    if (!removeResult.ok) {
      return { ok: false, reason: removeResult.reason };
    }
  }

  const branchResult = await git(repoRoot, ["branch", "-D", value.branch]);
  if (!branchResult.ok && !branchResult.reason.includes("not found")) {
    return { ok: false, reason: branchResult.reason };
  }

  return { ok: true, value };
}

function getWorktreeResult(repoRoot: string, taskId: string): WorktreeResult {
  return {
    worktree: path.join(repoRoot, ".hivemind", "worktrees", taskId),
    branch: `hivemind/${taskId}`
  };
}

async function loadAndValidateContract(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; contract: ReturnType<typeof normalizeContract> } | { ok: false; reason: string }> {
  const loaded = await loadContract(repoRoot, taskId);
  if (!loaded.ok) {
    return loaded;
  }

  const problems = validateContract(loaded.raw);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, contract: normalizeContract(loaded.raw) };
}

async function git(cwd: string, args: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await execFileAsync("git", args, { cwd, windowsHide: true });
    return { ok: true };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
