import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadContract, normalizeContract, TaskContract, validateContract } from "./contract.js";

export type PromptArgMode = "stdin" | "arg";

export interface AdapterProfile {
  tool: string;
  invoke: string[];
  prompt_arg: PromptArgMode;
  verified_on: string;
  context_window: number;
}

export interface InvokeAgentResult {
  exitCode: number;
  logPath: string;
}

export async function invokeAgent(
  repoRoot: string,
  taskId: string,
  tool: string
): Promise<{ ok: true; value: InvokeAgentResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }

  const worktreePath = path.join(repoRoot, ".hivemind", "worktrees", taskId);
  if (!(await exists(worktreePath))) {
    return { ok: false, reason: `worktree not found: .hivemind/worktrees/${taskId}` };
  }

  const prompt = buildAgentPrompt(contractResult.contract);
  const processResult = await runAdapter(profileResult.profile, worktreePath, prompt);
  const logPath = path.join(worktreePath, "agent.log");
  await writeAgentLog(logPath, profileResult.profile.tool, processResult);

  return { ok: true, value: { exitCode: processResult.exitCode, logPath } };
}

export async function loadAdapterProfile(
  repoRoot: string,
  tool: string
): Promise<{ ok: true; profile: AdapterProfile } | { ok: false; reason: string }> {
  const profilePath = path.join(repoRoot, ".hivemind", "adapters", `${tool}.profile.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(profilePath, "utf8"));
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

  if (!Array.isArray(raw.invoke) || raw.invoke.length === 0 || !raw.invoke.every((entry) => typeof entry === "string")) {
    problems.push("invoke must be a non-empty array of strings");
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

  return problems;
}

export function buildAgentPrompt(contract: TaskContract): string {
  return [
    "You are a Hivemind AI worker running one scoped task.",
    "Submit a diff only. Do not commit, push, rename unrelated files, or edit outside the contract.",
    "",
    `Task ID: ${contract.task_id}`,
    `Title: ${contract.title}`,
    `Agent role: ${contract.agent_role}`,
    `Base commit: ${contract.base_commit}`,
    "",
    formatList("Allowed files", contract.allowed_files),
    formatList("Read-only files", contract.read_only_files),
    formatList("Forbidden files", contract.forbidden_files),
    formatList("Allowed symbols", contract.allowed_symbols),
    formatList("Forbidden symbols", contract.forbidden_symbols),
    formatList("Must not change", contract.must_not_change),
    formatList("Required tests", contract.required_tests),
    formatList("Patch requirements", contract.patch_requirements),
    "",
    "Stop when the required tests pass."
  ].join("\n");
}

async function loadAndValidateContract(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; contract: TaskContract } | { ok: false; reason: string }> {
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

function runAdapter(
  profile: AdapterProfile,
  cwd: string,
  prompt: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...baseArgs] = profile.invoke;
    const args = profile.prompt_arg === "arg" ? [...baseArgs, prompt] : baseArgs;
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });

    if (profile.prompt_arg === "stdin") {
      child.stdin.end(prompt);
    }
  });
}

async function writeAgentLog(
  logPath: string,
  tool: string,
  result: { exitCode: number; stdout: string; stderr: string }
): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(
    logPath,
    [
      "# Hivemind Agent Log",
      `tool: ${tool}`,
      `exit_code: ${result.exitCode}`,
      "",
      "## stdout",
      result.stdout,
      "## stderr",
      result.stderr
    ].join("\n"),
    "utf8"
  );
}

function formatList(label: string, values: string[]): string {
  if (values.length === 0) {
    return `${label}:\n- (none)`;
  }
  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
