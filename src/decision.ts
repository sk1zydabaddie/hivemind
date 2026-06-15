import type { ChangesetOpType } from "./changeset.js";
import { canonicalize } from "./canonicalize.js";
import type { TaskContract } from "./contract.js";
import type { HivemindConfig } from "./init.js";

export type DecisionVerdict = "pass" | "reject" | "escalate";

export interface DecisionConfig extends HivemindConfig {
  critical_globs?: string[];
}

export interface DecisionOp {
  path: string;
  op: string;
}

const knownOps = new Set<ChangesetOpType>(["add", "modify", "delete", "chmod", "symlink", "submodule", "gitattr"]);
const dependencyFiles = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
]);

export async function decideOp(
  op: DecisionOp,
  contract: TaskContract,
  config: DecisionConfig
): Promise<DecisionVerdict> {
  if (!knownOps.has(op.op as ChangesetOpType)) {
    return "reject";
  }

  const canonical = await canonicalize(config.repo_root, op.path);
  if (!canonical.ok) {
    return "reject";
  }

  const resolvedPath = canonical.resolved;
  if (!isAllowedPath(resolvedPath, contract, config)) {
    return "reject";
  }

  if (op.op === "delete" && (isForbiddenPath(resolvedPath, contract, config) || isCriticalPath(resolvedPath, config))) {
    return "reject";
  }

  if (op.op === "symlink") {
    return "reject";
  }

  if (
    op.op === "chmod" ||
    op.op === "submodule" ||
    op.op === "gitattr" ||
    isGitBehaviorPath(resolvedPath) ||
    isDependencyPath(resolvedPath)
  ) {
    return "escalate";
  }

  return "pass";
}

function isAllowedPath(pathValue: string, contract: TaskContract, config: DecisionConfig): boolean {
  return matchesAny(pathValue, contract.allowed_files) || matchesAny(pathValue, config.allowed_globs);
}

function isForbiddenPath(pathValue: string, contract: TaskContract, config: DecisionConfig): boolean {
  return matchesAny(pathValue, contract.forbidden_files) || matchesAny(pathValue, config.forbidden_globs);
}

function isCriticalPath(pathValue: string, config: DecisionConfig): boolean {
  return matchesAny(pathValue, config.critical_globs ?? []);
}

function isGitBehaviorPath(pathValue: string): boolean {
  return pathValue === ".gitattributes" || pathValue === ".gitignore" || pathValue === ".gitmodules";
}

function isDependencyPath(pathValue: string): boolean {
  return dependencyFiles.has(pathValue.split("/").at(-1) ?? "");
}

function matchesAny(pathValue: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(pathValue, pattern));
}

function matchesPattern(pathValue: string, pattern: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedPattern.includes("*")) {
    return pathValue === normalizedPattern;
  }

  return globToRegExp(normalizedPattern).test(pathValue);
}

function normalizePattern(pattern: string): string {
  return pattern.replaceAll("\\", "/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
