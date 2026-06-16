import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CaptureWorktreeDiffOptions {
  excludeUntracked?: string[];
}

export interface CaptureWorktreeDiffResult {
  diff: string;
  changedFiles: number;
}

export async function captureWorktreeDiff(
  worktreePath: string,
  baseCommit: string,
  options: CaptureWorktreeDiffOptions = {}
): Promise<{ ok: true; value: CaptureWorktreeDiffResult } | { ok: false; reason: string }> {
  const untrackedResult = await makeUntrackedFilesDiffable(worktreePath, options.excludeUntracked ?? []);
  if (!untrackedResult.ok) {
    return untrackedResult;
  }

  const diffResult = await git(worktreePath, ["diff", baseCommit]);
  if (!diffResult.ok) {
    return diffResult;
  }

  const changedResult = await git(worktreePath, ["diff", "--name-only", "-z", baseCommit]);
  if (!changedResult.ok) {
    return changedResult;
  }

  return {
    ok: true,
    value: {
      diff: diffResult.stdout,
      changedFiles: countNullSeparatedEntries(changedResult.stdout)
    }
  };
}

async function makeUntrackedFilesDiffable(
  worktreePath: string,
  excludeUntracked: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const statusResult = await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!statusResult.ok) {
    return statusResult;
  }

  const excluded = new Set(excludeUntracked.map(normalizeGitPath));
  const untracked = statusResult.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter((entry) => !excluded.has(normalizeGitPath(entry)));

  if (untracked.length === 0) {
    return { ok: true };
  }

  return git(worktreePath, ["add", "--intent-to-add", "--", ...untracked]);
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

function countNullSeparatedEntries(value: string): number {
  return value.split("\0").filter((entry) => entry.length > 0).length;
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}
