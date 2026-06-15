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
  critical_globs?: string[];
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
  if ("critical_globs" in raw) {
    requireStringArray(raw, "critical_globs", problems);
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
    ...("critical_globs" in raw ? { critical_globs: normalizeStringArray(raw.critical_globs) } : {})
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
