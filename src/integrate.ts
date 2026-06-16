import { exec, execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeTask } from "./analyze.js";
import { writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";
import { validateRequestedTaskId } from "./task-id.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface IntegrationStatus {
  branch: string;
  applied: string[];
  tests: "pass" | "fail";
  report: string;
}

interface QueueEntry {
  task_id: string;
}

interface GateSummary {
  taskId: string;
  verdict: "accept" | "reject" | "escalate";
  reason: string;
}

export async function integrateCommand(cwd: string, args: string[]): Promise<number> {
  const [flag, ...rest] = args;
  if (flag !== "--shadow" || rest.length > 0) {
    console.error("error: usage: hivemind integrate --shadow");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await integrateShadow(repoRoot);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return result.value.tests === "pass" ? 0 : 1;
}

export async function integrateShadow(
  repoRoot: string
): Promise<{ ok: true; value: IntegrationStatus } | { ok: false; reason: string }> {
  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const queueResult = await loadIntegrationQueue(repoRoot);
  if (!queueResult.ok) {
    return queueResult;
  }
  if (queueResult.value.length === 0) {
    return { ok: false, reason: "integration queue is empty" };
  }
  if (configResult.config.test_command.trim() === "") {
    return { ok: false, reason: "config.test_command must not be empty for shadow integration" };
  }

  const mainResult = await git(repoRoot, ["rev-parse", "--verify", "main"]);
  if (!mainResult.ok) {
    return { ok: false, reason: "base branch main not found" };
  }

  const gateResult = await gateQueue(repoRoot, queueResult.value);
  if (!gateResult.ok) {
    return gateResult;
  }

  const accepted = gateResult.value.filter((summary) => summary.verdict === "accept").map((summary) => summary.taskId);
  if (accepted.length === 0) {
    return { ok: false, reason: "no accepted patches to integrate" };
  }

  const timestamp = integrationTimestamp();
  const branch = `integration/${timestamp}`;
  const worktreePath = path.join(repoRoot, ".hivemind", "integration", "worktrees", timestamp);
  let worktreeCreated = false;
  let status: IntegrationStatus | null = null;
  let outcome: { ok: true; value: IntegrationStatus } | { ok: false; reason: string } | null = null;
  let cleanupErrors: string[] = [];

  try {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const worktreeResult = await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "main"]);
    if (!worktreeResult.ok) {
      outcome = { ok: false, reason: worktreeResult.reason };
    } else {
      worktreeCreated = true;

      for (const taskId of accepted) {
        const applyResult = await git(worktreePath, ["apply", "--index", patchPath(repoRoot, taskId)]);
        if (!applyResult.ok) {
          const applyError = `failed to apply ${taskId}: ${applyResult.reason}`;
          status = {
            branch,
            applied: accepted.slice(0, accepted.indexOf(taskId)),
            tests: "fail",
            report: buildReport(gateResult.value, configResult.config.test_command, null, applyError)
          };
          await writeIntegrationStatus(repoRoot, status);
          outcome = { ok: true, value: status };
          break;
        }
      }

      if (outcome === null) {
        const testResult = await runTestCommand(worktreePath, configResult.config.test_command);
        status = {
          branch,
          applied: accepted,
          tests: testResult.exitCode === 0 ? "pass" : "fail",
          report: buildReport(gateResult.value, configResult.config.test_command, testResult, null)
        };
        await writeIntegrationStatus(repoRoot, status);
        outcome = { ok: true, value: status };
      }
    }
  } finally {
    cleanupErrors = await cleanupShadow(repoRoot, worktreePath, branch, worktreeCreated);
  }

  if (cleanupErrors.length > 0) {
    return { ok: false, reason: `shadow cleanup failed: ${cleanupErrors.join("; ")}` };
  }

  return outcome ?? { ok: false, reason: "shadow integration did not produce a result" };
}

async function loadIntegrationQueue(
  repoRoot: string
): Promise<{ ok: true; value: QueueEntry[] } | { ok: false; reason: string }> {
  const queuePath = path.join(repoRoot, ".hivemind", "integration", "queue.json");
  let raw: unknown;
  try {
    raw = await readJsonFile(queuePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: "integration queue not found: .hivemind/integration/queue.json" };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/integration/queue.json" };
    }
    throw error;
  }

  if (!Array.isArray(raw)) {
    return { ok: false, reason: "integration queue must be an array" };
  }

  const entries: QueueEntry[] = [];
  const problems: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.task_id !== "string") {
      problems.push(`queue[${index}].task_id must be a string`);
      continue;
    }
    const taskIdResult = validateRequestedTaskId(entry.task_id);
    if (!taskIdResult.ok) {
      problems.push(`queue[${index}].${taskIdResult.reason}`);
      continue;
    }
    entries.push({ task_id: entry.task_id });
  }

  return problems.length === 0 ? { ok: true, value: entries } : { ok: false, reason: problems.join("; ") };
}

async function gateQueue(repoRoot: string, queue: QueueEntry[]): Promise<{ ok: true; value: GateSummary[] } | { ok: false; reason: string }> {
  const summaries: GateSummary[] = [];
  for (const entry of queue) {
    const result = await analyzeTask(repoRoot, entry.task_id);
    if (!result.ok) {
      return { ok: false, reason: `failed to analyze ${entry.task_id}: ${result.reason}` };
    }
    summaries.push({
      taskId: entry.task_id,
      verdict: result.value.verdict,
      reason: result.value.reason
    });
  }
  return { ok: true, value: summaries };
}

async function runTestCommand(
  cwd: string,
  command: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execAsync(command, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    return {
      exitCode: typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "",
      stderr: typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
    };
  }
}

function buildReport(
  gateSummaries: GateSummary[],
  testCommand: string,
  testResult: { exitCode: number; stdout: string; stderr: string } | null,
  applyError: string | null
): string {
  const lines = [
    "gate results:",
    ...gateSummaries.map((summary) => `- ${summary.taskId}: ${summary.verdict} (${summary.reason})`),
    `test command: ${testCommand}`
  ];

  if (applyError !== null) {
    lines.push(`apply: fail (${applyError})`);
  }
  if (testResult !== null) {
    lines.push(`test exit code: ${testResult.exitCode}`);
    lines.push(`stdout:\n${trimReportOutput(testResult.stdout)}`);
    lines.push(`stderr:\n${trimReportOutput(testResult.stderr)}`);
  }

  return `${lines.join("\n")}\n`;
}

function trimReportOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 8000 ? `${trimmed.slice(0, 8000)}\n[truncated]` : trimmed;
}

async function writeIntegrationStatus(repoRoot: string, status: IntegrationStatus): Promise<void> {
  await writeJsonAtomic(path.join(repoRoot, ".hivemind", "integration", "status.json"), status);
}

async function cleanupShadow(repoRoot: string, worktreePath: string, branch: string, worktreeCreated: boolean): Promise<string[]> {
  const errors: string[] = [];
  if (worktreeCreated) {
    const removeResult = await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (!removeResult.ok) {
      errors.push(removeResult.reason);
    }
  } else {
    await rm(worktreePath, { recursive: true, force: true });
  }

  const branchResult = await git(repoRoot, ["branch", "-D", branch]);
  if (!branchResult.ok && !branchResult.reason.includes("not found")) {
    errors.push(branchResult.reason);
  }

  return errors;
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

function patchPath(repoRoot: string, taskId: string): string {
  return path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
}

function integrationTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
