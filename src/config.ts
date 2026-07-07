import { realpath } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "./json.js";

export interface HivemindConfig {
  version: 1;
  stack: "typescript-node";
  repo_root: string;
  test_command: string;
  allowed_globs: string[];
  forbidden_globs: string[];
  low_globs?: string[];
  medium_globs?: string[];
  high_globs?: string[];
  critical_globs?: string[];
  resource_policy?: ResourcePolicy;
  manager_autonomy?: ManagerAutonomyPolicy;
}

export interface ResourcePolicy {
  run_ceiling?: RunCeiling;
}

export interface ManagerAutonomyPolicy {
  tier2_actions?: string[];
  cost_threshold?: ManagerCostThreshold;
  redirect_limit?: number;
}

export interface ManagerCostThreshold {
  estimated_requests?: number;
  wall_time_ms?: number;
}

export interface RunCeiling {
  requests?: number;
  wall_time_ms?: number;
}

export type LoadConfigResult = { ok: true; config: HivemindConfig } | { ok: false; reason: string };

export async function loadConfig(repoRoot: string): Promise<LoadConfigResult> {
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

  const config = normalizeConfig(raw);
  const rootProblem = await validateConfigRepoRoot(repoRoot, config.repo_root);
  if (rootProblem !== null) {
    return { ok: false, reason: rootProblem };
  }

  return { ok: true, config };
}

export function validateConfig(raw: unknown): string[] {
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
  for (const field of ["low_globs", "medium_globs", "high_globs", "critical_globs"] as const) {
    if (field in raw) {
      requireStringArray(raw, field, problems);
    }
  }
  if ("resource_policy" in raw) {
    validateResourcePolicy(raw.resource_policy, problems);
  }
  if ("manager_autonomy" in raw) {
    validateManagerAutonomyPolicy(raw.manager_autonomy, problems);
  }

  return problems;
}

export function normalizeConfig(raw: unknown): HivemindConfig {
  if (!isRecord(raw)) {
    throw new Error("cannot normalize invalid config");
  }

  return {
    version: 1,
    stack: "typescript-node",
    repo_root: String(raw.repo_root),
    test_command: String(raw.test_command),
    allowed_globs: normalizeStringArray(raw.allowed_globs),
    forbidden_globs: normalizeStringArray(raw.forbidden_globs),
    ...("low_globs" in raw ? { low_globs: normalizeStringArray(raw.low_globs) } : {}),
    ...("medium_globs" in raw ? { medium_globs: normalizeStringArray(raw.medium_globs) } : {}),
    ...("high_globs" in raw ? { high_globs: normalizeStringArray(raw.high_globs) } : {}),
    ...("critical_globs" in raw ? { critical_globs: normalizeStringArray(raw.critical_globs) } : {}),
    ...("resource_policy" in raw ? { resource_policy: normalizeResourcePolicy(raw.resource_policy) } : {}),
    ...("manager_autonomy" in raw ? { manager_autonomy: normalizeManagerAutonomyPolicy(raw.manager_autonomy) } : {})
  };
}

async function validateConfigRepoRoot(repoRoot: string, configRepoRoot: string): Promise<string | null> {
  let expected: string;
  let configured: string;
  try {
    expected = await realpath(repoRoot);
  } catch {
    return "repo root cannot be resolved";
  }
  try {
    configured = await realpath(configRepoRoot);
  } catch {
    return "repo_root cannot be resolved";
  }

  if (normalizeForComparison(expected) !== normalizeForComparison(configured)) {
    return "repo_root must match the current git repository root";
  }
  return null;
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

function validateResourcePolicy(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("resource_policy must be a JSON object");
    return;
  }
  if ("run_ceiling" in value) {
    validateRunCeiling(value.run_ceiling, problems);
  }
}

function validateRunCeiling(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("resource_policy.run_ceiling must be a JSON object");
    return;
  }
  for (const field of ["requests", "wall_time_ms"] as const) {
    if (field in value && (!Number.isSafeInteger(value[field]) || typeof value[field] !== "number" || value[field] < 0)) {
      problems.push(`resource_policy.run_ceiling.${field} must be a non-negative safe integer`);
    }
  }
}

function validateManagerAutonomyPolicy(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("manager_autonomy must be a JSON object");
    return;
  }
  if ("tier2_actions" in value) {
    requireStringArray(value, "tier2_actions", problems);
  }
  if ("cost_threshold" in value) {
    validateManagerCostThreshold(value.cost_threshold, problems);
  }
  if ("redirect_limit" in value && (!Number.isSafeInteger(value.redirect_limit) || typeof value.redirect_limit !== "number" || value.redirect_limit < 1)) {
    problems.push("manager_autonomy.redirect_limit must be a positive safe integer");
  }
}

function validateManagerCostThreshold(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("manager_autonomy.cost_threshold must be a JSON object");
    return;
  }
  for (const field of ["estimated_requests", "wall_time_ms"] as const) {
    if (field in value && (!Number.isSafeInteger(value[field]) || typeof value[field] !== "number" || value[field] < 0)) {
      problems.push(`manager_autonomy.cost_threshold.${field} must be a non-negative safe integer`);
    }
  }
}

function normalizeResourcePolicy(value: unknown): ResourcePolicy {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...("run_ceiling" in value ? { run_ceiling: normalizeRunCeiling(value.run_ceiling) } : {})
  };
}

function normalizeRunCeiling(value: unknown): RunCeiling {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...("requests" in value && typeof value.requests === "number" ? { requests: value.requests } : {}),
    ...("wall_time_ms" in value && typeof value.wall_time_ms === "number" ? { wall_time_ms: value.wall_time_ms } : {})
  };
}

function normalizeManagerAutonomyPolicy(value: unknown): ManagerAutonomyPolicy {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...("tier2_actions" in value ? { tier2_actions: normalizeStringArray(value.tier2_actions) } : {}),
    ...("cost_threshold" in value ? { cost_threshold: normalizeManagerCostThreshold(value.cost_threshold) } : {}),
    ...("redirect_limit" in value && typeof value.redirect_limit === "number" ? { redirect_limit: value.redirect_limit } : {})
  };
}

function normalizeManagerCostThreshold(value: unknown): ManagerCostThreshold {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...("estimated_requests" in value && typeof value.estimated_requests === "number" ? { estimated_requests: value.estimated_requests } : {}),
    ...("wall_time_ms" in value && typeof value.wall_time_ms === "number" ? { wall_time_ms: value.wall_time_ms } : {})
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForComparison(pathValue: string): string {
  const normalized = path.resolve(pathValue);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
