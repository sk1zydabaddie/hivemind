import { realpath } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "./json.js";
import { normalizeRepoPathPattern, validateRepoRelativePathOrGlob } from "./path-pattern.js";

export const DEFAULT_RUN_TOKEN_CEILING = 150_000;
export const DEFAULT_SESSION_TOKEN_CEILING = 500_000;

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
  verification?: VerificationConfig;
}

export interface VerificationConfig {
  graph_enabled?: boolean;
  checks: VerificationCheckConfig[];
  coverage?: VerificationCoverageConfig;
  test_paths?: string[];
}

export interface VerificationCheckConfig {
  id: string;
  command: string;
  entry_files: string[];
}

export interface VerificationCoverageConfig {
  command: string;
  report_path: string;
  format: "lcov";
}

export interface ResourcePolicy {
  run_ceiling?: RunCeiling;
  session_ceiling?: SessionCeiling;
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
  tokens?: number;
}

export interface SessionCeiling {
  tokens?: number;
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
  if ("verification" in raw) {
    validateVerificationConfig(raw.verification, problems);
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
    resource_policy: normalizeResourcePolicy(raw.resource_policy),
    ...("manager_autonomy" in raw ? { manager_autonomy: normalizeManagerAutonomyPolicy(raw.manager_autonomy) } : {}),
    ...("verification" in raw ? { verification: normalizeVerificationConfig(raw.verification) } : {})
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
  if ("session_ceiling" in value) {
    validateSessionCeiling(value.session_ceiling, problems);
  }
}

function validateRunCeiling(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("resource_policy.run_ceiling must be a JSON object");
    return;
  }
  for (const field of ["requests", "wall_time_ms", "tokens"] as const) {
    if (field in value && (!Number.isSafeInteger(value[field]) || typeof value[field] !== "number" || value[field] < 0)) {
      problems.push(`resource_policy.run_ceiling.${field} must be a non-negative safe integer`);
    }
  }
}

function validateSessionCeiling(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("resource_policy.session_ceiling must be a JSON object");
    return;
  }
  if ("tokens" in value && (!Number.isSafeInteger(value.tokens) || typeof value.tokens !== "number" || value.tokens < 0)) {
    problems.push("resource_policy.session_ceiling.tokens must be a non-negative safe integer");
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

function validateVerificationConfig(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("verification must be a JSON object");
    return;
  }
  if ("graph_enabled" in value && typeof value.graph_enabled !== "boolean") {
    problems.push("verification.graph_enabled must be a boolean");
  }
  if ("coverage" in value) {
    validateVerificationCoverageConfig(value.coverage, problems);
  }
  if ("test_paths" in value) {
    validateVerificationTestPaths(value.test_paths, problems);
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    problems.push("verification.checks must be a non-empty array");
    return;
  }
  const ids = new Set<string>();
  for (const [index, check] of value.checks.entries()) {
    if (!isRecord(check)) {
      problems.push(`verification.checks[${index}] must be a JSON object`);
      continue;
    }
    const id = typeof check.id === "string" ? check.id.trim() : "";
    if (id === "") {
      problems.push(`verification.checks[${index}].id must be a non-empty string`);
    } else if (ids.has(id)) {
      problems.push(`verification.checks contains duplicate id "${id}"`);
    } else {
      ids.add(id);
    }
    if (typeof check.command !== "string" || check.command.trim() === "") {
      problems.push(`verification.checks[${index}].command must be a non-empty string`);
    }
    if (
      !Array.isArray(check.entry_files) ||
      check.entry_files.length === 0 ||
      check.entry_files.some((entry) => typeof entry !== "string" || entry.trim() === "")
    ) {
      problems.push(`verification.checks[${index}].entry_files must be a non-empty array of non-empty strings`);
    }
  }
}

function validateVerificationCoverageConfig(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("verification.coverage must be a JSON object");
    return;
  }
  if (typeof value.command !== "string" || value.command.trim() === "") {
    problems.push("verification.coverage.command must be a non-empty string");
  }
  if (typeof value.report_path !== "string" || normalizeRepoRelativePath(value.report_path) === null) {
    problems.push("verification.coverage.report_path must be a confined repository-relative path");
  }
  if (value.format !== "lcov") {
    problems.push('verification.coverage.format must be "lcov"');
  }
}

function validateVerificationTestPaths(value: unknown, problems: string[]): void {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    problems.push("verification.test_paths must be an array of strings");
    return;
  }
  for (const [index, pattern] of value.entries()) {
    const pathProblem = validateRepoRelativePathOrGlob(pattern);
    if (pathProblem !== null) {
      problems.push(`verification.test_paths[${index}] is invalid: ${pathProblem}`);
      continue;
    }
    if (!isExplicitTestPathPattern(pattern)) {
      problems.push(
        `verification.test_paths[${index}] must be confined to an explicit test/spec directory or *.test.*/*.spec.* file pattern`
      );
    }
  }
}

function normalizeResourcePolicy(value: unknown): ResourcePolicy {
  if (!isRecord(value)) {
    return defaultResourcePolicy();
  }
  return {
    run_ceiling: normalizeRunCeiling(value.run_ceiling),
    session_ceiling: normalizeSessionCeiling(value.session_ceiling)
  };
}

function normalizeRunCeiling(value: unknown): RunCeiling {
  if (!isRecord(value)) {
    return { tokens: DEFAULT_RUN_TOKEN_CEILING };
  }
  return {
    ...("requests" in value && typeof value.requests === "number" ? { requests: value.requests } : {}),
    ...("wall_time_ms" in value && typeof value.wall_time_ms === "number" ? { wall_time_ms: value.wall_time_ms } : {}),
    tokens: "tokens" in value && typeof value.tokens === "number" ? value.tokens : DEFAULT_RUN_TOKEN_CEILING
  };
}

function normalizeSessionCeiling(value: unknown): SessionCeiling {
  if (!isRecord(value)) {
    return { tokens: DEFAULT_SESSION_TOKEN_CEILING };
  }
  return {
    tokens: "tokens" in value && typeof value.tokens === "number" ? value.tokens : DEFAULT_SESSION_TOKEN_CEILING
  };
}

function defaultResourcePolicy(): ResourcePolicy {
  return {
    run_ceiling: { tokens: DEFAULT_RUN_TOKEN_CEILING },
    session_ceiling: { tokens: DEFAULT_SESSION_TOKEN_CEILING }
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

function normalizeVerificationConfig(value: unknown): VerificationConfig {
  if (!isRecord(value) || !Array.isArray(value.checks)) {
    return { checks: [] };
  }
  return {
    ...("graph_enabled" in value && typeof value.graph_enabled === "boolean" ? { graph_enabled: value.graph_enabled } : {}),
    ...("test_paths" in value && Array.isArray(value.test_paths)
      ? {
          test_paths: [...new Set(
            value.test_paths
              .filter((entry): entry is string => typeof entry === "string")
              .map(normalizeRepoPathPattern)
          )]
        }
      : {}),
    ...("coverage" in value && isRecord(value.coverage)
      ? {
          coverage: {
            command: typeof value.coverage.command === "string" ? value.coverage.command.trim() : "",
            report_path: typeof value.coverage.report_path === "string"
              ? normalizeRepoRelativePath(value.coverage.report_path) ?? ""
              : "",
            format: "lcov" as const
          }
        }
      : {}),
    checks: value.checks.filter(isRecord).map((check) => ({
      id: typeof check.id === "string" ? check.id.trim() : "",
      command: typeof check.command === "string" ? check.command.trim() : "",
      entry_files: normalizeStringArray(check.entry_files).map((entry) => entry.trim())
    }))
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function isExplicitTestPathPattern(value: string): boolean {
  const normalized = normalizeRepoPathPattern(value).toLowerCase();
  const parts = normalized.split("/");
  const hasTestDirectory = parts.some((part) =>
    part === "test" ||
    part === "tests" ||
    part === "__tests__" ||
    part === "spec" ||
    part === "specs"
  );
  const fileName = parts.at(-1) ?? "";
  return hasTestDirectory || /\.(?:test|spec)(?:\.|$)/u.test(fileName);
}

function normalizeRepoRelativePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  const segments = normalized.split("/");
  const canonical = path.posix.normalize(normalized);
  return normalized === "" ||
    segments.includes("..") ||
    canonical === "." ||
    canonical === ".." ||
    canonical.startsWith("../") ||
    path.posix.isAbsolute(canonical) ||
    /^[A-Za-z]:\//u.test(canonical)
    ? null
    : canonical;
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
