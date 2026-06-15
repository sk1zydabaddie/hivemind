import { stat } from "node:fs/promises";
import path from "node:path";
import { loadContract, normalizeContract, validateContract } from "./contract.js";
import type { DecisionConfig } from "./decision.js";
import { runGate, type GateResult } from "./gate.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";

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

  const result = await analyzeTask(repoRoot, taskId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return result.value.verdict === "accept" ? 0 : 1;
}

export async function analyzeTask(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: GateResult } | { ok: false; reason: string }> {
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }

  const configResult = await loadAndValidateConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }

  const patchPath = path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch");
  if (!(await exists(patchPath))) {
    return { ok: false, reason: `patch not found: .hivemind/patches/${taskId}/diff.patch` };
  }

  return {
    ok: true,
    value: await runGate(contractResult.contract.base_commit, patchPath, contractResult.contract, configResult.config)
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

  const problems = validateContract(loaded.raw, taskId);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, contract: normalizeContract(loaded.raw) };
}

async function loadAndValidateConfig(
  repoRoot: string
): Promise<{ ok: true; config: DecisionConfig } | { ok: false; reason: string }> {
  const configPath = path.join(repoRoot, ".hivemind", "config.json");
  let raw: unknown;
  try {
    raw = await readJsonFile(configPath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: "config not found: .hivemind/config.json" };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/config.json" };
    }
    throw error;
  }

  const problems = validateConfig(raw);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  return { ok: true, config: raw as DecisionConfig };
}

function validateConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return ["config must be a JSON object"];
  }

  if (raw.version !== 1) {
    problems.push("version must be 1");
  }
  if (raw.stack !== "typescript-node") {
    problems.push("stack must be typescript-node");
  }
  requireString(raw, "repo_root", problems);
  requireString(raw, "test_command", problems);
  requireStringArray(raw, "allowed_globs", problems);
  requireStringArray(raw, "forbidden_globs", problems);
  if ("critical_globs" in raw) {
    requireStringArray(raw, "critical_globs", problems);
  }

  return problems;
}

function requireString(raw: Record<string, unknown>, field: string, problems: string[]): void {
  if (typeof raw[field] !== "string") {
    problems.push(`${field} must be a string`);
  }
}

function requireStringArray(raw: Record<string, unknown>, field: string, problems: string[]): void {
  const value = raw[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    problems.push(`${field} must be an array of strings`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
