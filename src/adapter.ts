import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { loadAndValidateContract, TaskContract } from "./contract.js";
import { formatErrorDetail } from "./error-detail.js";
import { readJsonFile } from "./json.js";
import { assembleAgentPrompt, buildAgentPromptFromContract } from "./prompt-cache.js";
import { adapterOutputIndicatesThrottle, recordQuotaUsage } from "./resource-ledger.js";

export type PromptArgMode = "stdin" | "arg";
export type ProviderRoutingTier = "local" | "cheap" | "standard" | "strong";

export interface AdapterProfile {
  tool: string;
  invoke: string[];
  prompt_arg: PromptArgMode;
  verified_on: string;
  context_window: number;
  timeout_ms?: number;
  routing_tier?: ProviderRoutingTier;
  cost_rank?: number;
}

export interface InvokeAgentResult {
  exitCode: number;
  logPath: string;
  wallTimeMs: number;
  throttled: boolean;
  failureReason: string | null;
}

export interface AdapterStreamChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface InvokeAgentOptions {
  allowDangerousAdapter?: boolean;
  onStreamChunk?: (chunk: AdapterStreamChunk) => void;
}

export interface AdapterProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLogPath: string | null;
}

export interface AdapterProcessOptions {
  onStreamChunk?: (chunk: AdapterStreamChunk) => void;
  outputLogPath?: string;
}

export async function invokeAgent(
  repoRoot: string,
  taskId: string,
  tool: string,
  options: InvokeAgentOptions = {}
): Promise<{ ok: true; value: InvokeAgentResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }

  const dangerousArgs = findDangerousAdapterArgs(profileResult.profile.invoke);
  if (dangerousArgs.length > 0 && options.allowDangerousAdapter !== true) {
    return {
      ok: false,
      reason: `adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); rerun with --allow-dangerous-adapter only for approved disposable gate runs`
    };
  }

  const worktreePath = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  if (!(await exists(worktreePath))) {
    return { ok: false, reason: `worktree not found: .hivemind/worktrees/${taskId}` };
  }

  const promptResult = await assembleAgentPrompt(repoRoot, contractResult.contract);
  if (!promptResult.ok) {
    return promptResult;
  }
  const prompt = promptResult.value.full_prompt;
  const startedAt = Date.now();
  const logPath = path.join(worktreePath, "agent.log");
  const processResult = await runAdapterProcess(profileResult.profile, worktreePath, prompt, {
    onStreamChunk: options.onStreamChunk,
    outputLogPath: logPath
  });
  if (!processResult.ok) {
    return processResult;
  }
  const wallTimeMs = Date.now() - startedAt;
  const throttled = adapterOutputIndicatesThrottle(processResult.value.stdout, processResult.value.stderr, processResult.value.exitCode);
  const ledgerResult = await recordQuotaUsage(repoRoot, {
    provider: profileResult.profile.tool,
    input_text: prompt,
    output_text: `${processResult.value.stdout}\n${processResult.value.stderr}`,
    wall_time_ms: wallTimeMs,
    throttled
  });
  if (!ledgerResult.ok) {
    return { ok: false, reason: ledgerResult.reason };
  }

  return {
    ok: true,
    value: {
      exitCode: processResult.value.exitCode,
      logPath,
      wallTimeMs,
      throttled,
      failureReason:
        processResult.value.exitCode === 0
          ? null
          : formatAdapterProcessFailure(profileResult.profile.tool, processResult.value, "worker")
    }
  };
}

export async function loadAdapterProfile(
  repoRoot: string,
  tool: string
): Promise<{ ok: true; profile: AdapterProfile } | { ok: false; reason: string }> {
  const profilePath = path.join(repoRoot, ".hivemind", "adapters", `${tool}.profile.json`);
  let raw: unknown;
  try {
    raw = await readJsonFile(profilePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `adapter profile not found: .hivemind/adapters/${tool}.profile.json` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in .hivemind/adapters/${tool}.profile.json` };
    }
    throw error;
  }

  const problems = validateAdapterProfile(raw, tool);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, profile: raw as AdapterProfile };
}

export function validateAdapterProfile(raw: unknown, expectedTool?: string): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return ["adapter profile must be a JSON object"];
  }

  if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
    problems.push("tool is required");
  } else if (expectedTool !== undefined && raw.tool !== expectedTool) {
    problems.push(`tool must match requested adapter "${expectedTool}"`);
  }

  if (
    !Array.isArray(raw.invoke) ||
    raw.invoke.length === 0 ||
    !raw.invoke.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    problems.push("invoke must be a non-empty array of non-empty strings");
  }

  if (raw.prompt_arg !== "stdin" && raw.prompt_arg !== "arg") {
    problems.push("prompt_arg must be stdin or arg");
  }

  if (typeof raw.verified_on !== "string" || raw.verified_on.trim() === "") {
    problems.push("verified_on is required");
  }

  if (typeof raw.context_window !== "number" || !Number.isInteger(raw.context_window) || raw.context_window <= 0) {
    problems.push("context_window must be a positive integer");
  }

  if (
    "timeout_ms" in raw &&
    (typeof raw.timeout_ms !== "number" || !Number.isInteger(raw.timeout_ms) || raw.timeout_ms <= 0)
  ) {
    problems.push("timeout_ms must be a positive integer when provided");
  }
  if ("routing_tier" in raw && !isProviderRoutingTier(raw.routing_tier)) {
    problems.push("routing_tier must be one of local, cheap, standard, strong when provided");
  }
  if ("cost_rank" in raw && (typeof raw.cost_rank !== "number" || !Number.isInteger(raw.cost_rank) || raw.cost_rank <= 0)) {
    problems.push("cost_rank must be a positive integer when provided");
  }

  return problems;
}

export function normalizeProfileRoutingTier(profile: AdapterProfile): ProviderRoutingTier {
  return profile.routing_tier ?? "standard";
}

export function normalizeProfileCostRank(profile: AdapterProfile): number {
  return profile.cost_rank ?? 100;
}

export function findDangerousAdapterArgs(invoke: string[]): string[] {
  const dangerous = new Set<string>();
  for (const arg of invoke) {
    if (
      arg === "bypassPermissions" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "--allow-dangerously-skip-permissions" ||
      arg.includes("bypassPermissions") ||
      arg.includes("dangerously")
    ) {
      dangerous.add(arg);
    }
  }
  return [...dangerous];
}

export function buildAgentPrompt(contract: TaskContract): string {
  return buildAgentPromptFromContract(contract);
}

export function runAdapterProcess(
  profile: AdapterProfile,
  cwd: string,
  prompt: string,
  options: AdapterProcessOptions = {}
): Promise<{ ok: true; value: AdapterProcessResult } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const [command, ...baseArgs] = profile.invoke;
    const args = profile.prompt_arg === "arg" ? [...baseArgs, prompt] : baseArgs;
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failedToStart = false;
    let timedOut = false;
    let stdinError: NodeJS.ErrnoException | null = null;
    const timeout =
      profile.timeout_ms === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stderr.push(Buffer.from(`\nadapter timed out after ${profile.timeout_ms}ms\n`, "utf8"));
            terminateProcessTree(child.pid);
          }, profile.timeout_ms);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      options.onStreamChunk?.({ stream: "stdout", text: chunk.toString("utf8") });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      options.onStreamChunk?.({ stream: "stderr", text: chunk.toString("utf8") });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      stdinError = error;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failedToStart = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      void resolveStartFailure(profile.tool, error, options.outputLogPath, resolve);
    });
    child.on("close", (code) => {
      if (failedToStart) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      const capturedStderr = Buffer.concat(stderr).toString("utf8");
      const result: AdapterProcessResult = {
        exitCode: timedOut ? 124 : code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr:
          capturedStderr !== "" || stdinError === null
            ? capturedStderr
            : formatErrorDetail(stdinError, "adapter stdin failed"),
        timedOut,
        outputLogPath: options.outputLogPath ?? null
      };
      void resolveProcessResult(profile.tool, result, resolve);
    });

    if (profile.prompt_arg === "stdin") {
      child.stdin.end(prompt);
    }
  });
}

export function adapterRunLogPath(repoRoot: string, label: string): string {
  const safeLabel = label.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "adapter";
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".hivemind", "log", "runs", `${timestamp}-${safeLabel}-${randomUUID()}.adapter.log`);
}

export function formatAdapterProcessFailure(
  tool: string,
  result: AdapterProcessResult,
  role = "adapter"
): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no process output";
  const log = result.outputLogPath === null ? "" : `; output log: ${result.outputLogPath}`;
  const subject = role === "worker" ? `${role} ${tool}` : `${role} "${tool}"`;
  return `${subject} exited ${result.exitCode}${log}: ${detail}`;
}

async function resolveProcessResult(
  tool: string,
  result: AdapterProcessResult,
  resolve: (value: { ok: true; value: AdapterProcessResult } | { ok: false; reason: string }) => void
): Promise<void> {
  if (result.outputLogPath !== null) {
    try {
      await writeAdapterProcessLog(result.outputLogPath, tool, result);
    } catch (error: unknown) {
      resolve({
        ok: false,
        reason: `failed to write adapter output log ${result.outputLogPath}: ${formatErrorDetail(error, "unknown log write error")}`
      });
      return;
    }
  }
  resolve({ ok: true, value: result });
}

async function resolveStartFailure(
  tool: string,
  error: NodeJS.ErrnoException,
  outputLogPath: string | undefined,
  resolve: (value: { ok: true; value: AdapterProcessResult } | { ok: false; reason: string }) => void
): Promise<void> {
  const reason = formatSpawnError(tool, error);
  if (outputLogPath !== undefined) {
    try {
      await writeFileAtomic(
        outputLogPath,
        [
          "# Hivemind Adapter Run Log",
          `tool: ${tool}`,
          "exit_code: not-started",
          "timed_out: false",
          "",
          "## stdout",
          "",
          "## stderr",
          reason
        ].join("\n")
      );
    } catch (logError: unknown) {
      resolve({
        ok: false,
        reason: `${reason}; failed to write adapter output log ${outputLogPath}: ${formatErrorDetail(logError, "unknown log write error")}`
      });
      return;
    }
  }
  resolve({
    ok: false,
    reason: outputLogPath === undefined ? reason : `${reason}; output log: ${outputLogPath}`
  });
}

async function writeAdapterProcessLog(logPath: string, tool: string, result: AdapterProcessResult): Promise<void> {
  await writeFileAtomic(
    logPath,
    [
      "# Hivemind Adapter Run Log",
      `tool: ${tool}`,
      `exit_code: ${result.exitCode}`,
      `timed_out: ${result.timedOut}`,
      "",
      "## stdout",
      result.stdout,
      "## stderr",
      result.stderr
    ].join("\n")
  );
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    killer.on("error", () => undefined);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

function formatSpawnError(tool: string, error: NodeJS.ErrnoException): string {
  return `failed to start adapter "${tool}": ${formatErrorDetail(error, "unknown spawn error")}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderRoutingTier(value: unknown): value is ProviderRoutingTier {
  return value === "local" || value === "cheap" || value === "standard" || value === "strong";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
