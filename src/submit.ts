import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "./atomic.js";
import { loadAndValidateContract } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { appendEvent, readEvents } from "./events.js";
import { findGitRoot } from "./repo.js";
import { latestTaskRunState } from "./run-state.js";
import { resolveTaskAuthoringBase } from "./task-authoring-base.js";

const bundleFiles = [
  "diff.patch",
  "summary.md",
  "files_changed.json",
  "symbols_changed.json",
  "tests_run.json",
  "risks.md",
  "memory_proposals.json"
] as const;
const advisoryFiles = bundleFiles.filter((fileName) => fileName !== "diff.patch");
const submitUntrackedExcludes = ["agent.log", ...bundleFiles];
const execFileAsync = promisify(execFile);

export interface SubmitResult {
  task_id: string;
  bundle_path: string;
  files: string[];
}

export async function submitCommand(cwd: string, args: string[]): Promise<number> {
  const [taskId, ...rest] = args;
  if (!taskId || rest.length > 0) {
    console.error("error: usage: hivemind submit <id>");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const daemonResult = await callDaemonIfConfigured<SubmitResult>(repoRoot, "/submit", { task_id: taskId });
  const result = daemonResult.routed ? daemonResult : await submitTask(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function submitTask(repoRoot: string, taskId: string): Promise<{ ok: true; value: SubmitResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const completedRun = await requireCompletedRunWithBundle(repoRoot, taskId);
  if (!completedRun.ok) {
    return completedRun;
  }

  const worktreePath = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  const worktreeResult = await statIfExists(worktreePath);
  if (!worktreeResult.ok) {
    return { ok: false, reason: `worktree not found: .hivemind/worktrees/${taskId}` };
  }
  if (!worktreeResult.value.isDirectory()) {
    return { ok: false, reason: `.hivemind/worktrees/${taskId} is not a directory` };
  }

  const authoringBase = await resolveTaskAuthoringBase(repoRoot, contractResult.contract);
  if (!authoringBase.ok) {
    return authoringBase;
  }
  const head = await gitStdout(worktreePath, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout !== authoringBase.value.commit) {
    return {
      ok: false,
      reason: `task ${taskId} submit refused: worktree HEAD ${head.ok ? head.stdout : "unavailable"} does not match verified authoring base ${authoringBase.value.commit}`
    };
  }
  const diffResult = await captureWorktreeDiff(worktreePath, authoringBase.value.commit, {
    excludeUntracked: submitUntrackedExcludes
  });
  if (!diffResult.ok) {
    return diffResult;
  }

  const patchDir = path.join(repoRoot, ".hivemind", "patches", taskId);
  const writeDiffResult = await writeBundleFile(patchDir, "diff.patch", diffResult.value.diff);
  if (!writeDiffResult.ok) {
    return writeDiffResult;
  }

  for (const fileName of advisoryFiles) {
    const sourcePath = path.join(worktreePath, fileName);
    const sourceResult = await readAdvisoryFile(sourcePath, fileName);
    if (!sourceResult.ok) {
      return sourceResult;
    }

    const writeResult = await writeBundleFile(patchDir, fileName, sourceResult.content);
    if (!writeResult.ok) {
      return writeResult;
    }
  }

  await removeStaleBundleEntries(patchDir);

  const eventResult = await appendEvent(repoRoot, {
    type: "patch.submitted",
    task_id: taskId,
    data: {
      bundle_path: path.relative(repoRoot, patchDir).replaceAll("\\", "/"),
      files: [...bundleFiles],
      changed_files: diffResult.value.changedFiles
    }
  });
  if (!eventResult.ok) {
    return { ok: false, reason: `failed to append patch.submitted event: ${eventResult.reason}` };
  }

  return {
    ok: true,
    value: {
      task_id: taskId,
      bundle_path: patchDir,
      files: [...bundleFiles]
    }
  };
}

async function gitStdout(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}

async function requireCompletedRunWithBundle(repoRoot: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }

  const runState = latestTaskRunState(events.value, taskId);
  if (runState.state === "not_started") {
    return { ok: false, reason: `task ${taskId} has no completed worker run; submit_patch requires a task.completed event` };
  }
  if (runState.state === "running") {
    return { ok: false, reason: `task ${taskId} worker run is still running; submit_patch requires a task.completed event` };
  }
  if (runState.state === "failed") {
    const reason = typeof runState.failed.data.reason === "string" ? runState.failed.data.reason : "worker run failed";
    return { ok: false, reason: `task ${taskId} worker run failed; submit_patch refused: ${reason}` };
  }

  const diffPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
  const diff = await statIfExists(diffPath);
  if (!diff.ok || !diff.value.isFile()) {
    return { ok: false, reason: `task ${taskId} has task.completed but no patch bundle diff.patch; submit_patch refused` };
  }
  return { ok: true };
}

async function writeBundleFile(
  patchDir: string,
  fileName: (typeof bundleFiles)[number],
  content: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const targetPath = path.join(patchDir, fileName);
  const existing = await statIfExists(targetPath);
  if (existing.ok && existing.value.isDirectory()) {
    await rm(targetPath, { recursive: true, force: true });
  }
  await writeFileAtomic(targetPath, content);
  return { ok: true };
}

async function readAdvisoryFile(sourcePath: string, fileName: string): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const source = await statIfExists(sourcePath);
  if (!source.ok) {
    return { ok: true, content: "" };
  }
  if (!source.value.isFile()) {
    return { ok: false, reason: `advisory file ${fileName} is not a file in worktree` };
  }

  return { ok: true, content: await readFile(sourcePath, "utf8") };
}

async function removeStaleBundleEntries(patchDir: string): Promise<void> {
  const expected = new Set<string>(bundleFiles);
  const entries = await readdir(patchDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => !expected.has(entry.name))
      .map((entry) => rm(path.join(patchDir, entry.name), { recursive: true, force: true }))
  );
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
