import { execFile } from "node:child_process";
import { chmod, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent } from "./events.js";
import { runGate, type GateResult } from "./gate.js";
import { findGitRoot } from "./repo.js";
import { resolveTaskAuthoringBase } from "./task-authoring-base.js";
import { prepareReadonlyWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
const agentLogPath = "agent.log";

export async function analyzeCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, ...rest] = args;
  if (!taskId || rest.length > 0) {
    console.error("error: usage: hivemind analyze <id>");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<GateResult>(repoRoot, "/analyze", { task_id: taskId });
  const result = daemonResult.routed ? daemonResult : await analyzeTask(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return result.value.verdict === "accept" ? 0 : 1;
}

export async function analyzeTask(
  repoRoot: string,
  taskId: string,
  options: { emitEvent?: boolean } = {}
): Promise<{ ok: true; value: GateResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const patchPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
  if (!(await exists(patchPath))) {
    return { ok: false, reason: `patch not found: .hivemind/patches/${taskId}/diff.patch` };
  }

  const patch = await readFile(patchPath, "utf8");
  const authoringBase = await resolveTaskAuthoringBase(repoRoot, contractResult.contract);
  if (!authoringBase.ok) return authoringBase;
  const gateResult: GateResult =
    patch.trim() === ""
      ? {
          verdict: "reject",
          reason: "empty patch: no changes to analyze",
          plain_reason: "It finished without changing anything."
        }
      : await runGate(authoringBase.value.commit, patchPath, contractResult.contract, configResult.config);
  if (options.emitEvent !== false) {
    const eventType = gateResult.verdict === "accept" ? "patch.accepted" : "patch.rejected";
    const eventResult = await appendEvent(repoRoot, {
      type: eventType,
      task_id: taskId,
      data: {
        verdict: gateResult.verdict,
        /* `reason` stays exactly as it is -- it is evidence, and things match on
           it. `plain_reason` is the sibling every user-facing surface reads. */
        reason: gateResult.reason,
        plain_reason: gateResult.plain_reason
      }
    });
    if (!eventResult.ok) {
      return { ok: false, reason: `failed to append ${eventType} event: ${eventResult.reason}` };
    }
    if (gateResult.verdict === "reject") {
      const resetResult = await resetRejectedTaskWorktree(repoRoot, taskId, authoringBase.value.commit);
      if (!resetResult.ok) {
        return resetResult;
      }
    }
  }

  return {
    ok: true,
    value: gateResult
  };
}

async function resetRejectedTaskWorktree(
  repoRoot: string,
  taskId: string,
  authoringBaseCommit: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const worktreePath = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  const worktree = await statIfExists(worktreePath);
  if (!worktree.ok) {
    return { ok: true };
  }
  if (!worktree.value.isDirectory()) {
    return { ok: false, reason: `.hivemind/worktrees/${taskId} is not a directory` };
  }

  const rootResult = await git(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    return { ok: false, reason: `rejected patch cleanup could not inspect .hivemind/worktrees/${taskId}: ${rootResult.reason}` };
  }
  const [expectedRoot, actualRoot] = await Promise.all([realpath(worktreePath), realpath(rootResult.stdout.trim())]);
  if (normalizePath(expectedRoot) !== normalizePath(actualRoot)) {
    return {
      ok: false,
      reason: `rejected patch cleanup refused unexpected worktree root for ${taskId}: ${rootResult.stdout.trim()}`
    };
  }

  const headResult = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (!headResult.ok) {
    return { ok: false, reason: `rejected patch cleanup could not inspect ${taskId} HEAD: ${headResult.reason}` };
  }
  const baseResult = await git(worktreePath, ["rev-parse", authoringBaseCommit]);
  if (!baseResult.ok) {
    return { ok: false, reason: `rejected patch cleanup could not resolve ${taskId} base commit: ${baseResult.reason}` };
  }
  if (headResult.stdout.trim() !== baseResult.stdout.trim()) {
    return {
      ok: false,
      reason: `rejected patch cleanup refused .hivemind/worktrees/${taskId}: HEAD ${headResult.stdout.trim()} is not verified authoring base ${baseResult.stdout.trim()}`
    };
  }

  const writableResult = await restoreTrackedFileWrites(worktreePath);
  if (!writableResult.ok) {
    return { ok: false, reason: `failed to prepare rejected patch worktree ${taskId} for reset: ${writableResult.reason}` };
  }
  const resetResult = await git(worktreePath, ["reset", "--hard", baseResult.stdout.trim()]);
  if (!resetResult.ok) {
    return { ok: false, reason: `failed to reset rejected patch worktree ${taskId}: ${resetResult.reason}` };
  }
  const cleanResult = await git(worktreePath, ["clean", "-fd", "-e", agentLogPath, "--", "."]);
  if (!cleanResult.ok) {
    return { ok: false, reason: `failed to clean rejected patch worktree ${taskId}: ${cleanResult.reason}` };
  }
  const prepResult = await prepareReadonlyWorktree(repoRoot, worktreePath, taskId);
  if (!prepResult.ok) {
    return { ok: false, reason: `failed to restore read-only prep after rejected patch cleanup for ${taskId}: ${prepResult.reason}` };
  }

  return { ok: true };
}

async function restoreTrackedFileWrites(worktreePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const trackedResult = await git(worktreePath, ["ls-files", "-z"]);
  if (!trackedResult.ok) {
    return { ok: false, reason: trackedResult.reason };
  }

  for (const repoPath of parseNullSeparated(trackedResult.stdout)) {
    const fullPath = path.join(worktreePath, repoPath);
    const fileStat = await stat(fullPath);
    if (!fileStat.isDirectory()) {
      await chmod(fullPath, fileStat.mode | 0o200);
    }
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

async function statIfExists(filePath: string) {
  try {
    return { ok: true as const, value: await stat(filePath) };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false as const };
    }
    throw error;
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function parseNullSeparated(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
