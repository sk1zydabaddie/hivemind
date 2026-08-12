import type { ChangesetOpType } from "./changeset.js";
import { canonicalize } from "./canonicalize.js";
import type { HivemindConfig } from "./config.js";
import type { TaskContract } from "./contract.js";
import { matchesAny, type MatchOptions } from "./glob.js";
import { pathCaseBehaviour } from "./path-identity.js";
import { workerProtectedPathReason } from "./worker-protected-paths.js";

export type DecisionVerdict = "pass" | "reject" | "escalate";

/* Why a verdict was reached. The verdict alone was the whole answer until now,
 * which meant the gate could say a change was refused but never say why -- so
 * every surface downstream rendered "rejected add src/ledger.js" and left the
 * person to infer the rest. The cause is decided here, where it is known, and
 * carried out rather than reconstructed later from the path.
 */
export type DecisionCause =
  | "allowed"
  | "unknown_operation"
  | "unresolvable_path"
  | "protected_path"
  | "outside_allowed_files"
  | "delete_forbidden_path"
  | "delete_critical_path"
  | "symlink"
  | "mode_or_metadata_change"
  | "git_behavior_file"
  | "dependency_file";

export interface DecisionOutcome {
  verdict: DecisionVerdict;
  cause: DecisionCause;
}

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

/** The verdict only. Kept so existing callers and the M1.3 table read unchanged. */
export async function decideOp(
  op: DecisionOp,
  contract: TaskContract,
  config: DecisionConfig
): Promise<DecisionVerdict> {
  return (await decideOpOutcome(op, contract, config)).verdict;
}

/* The same decision table, returning the cause alongside the verdict. The order
   of the checks is the decision table and must not be reordered: the first rule
   that matches is the reason, and callers render it as such. */
export async function decideOpOutcome(
  op: DecisionOp,
  contract: TaskContract,
  config: DecisionConfig
): Promise<DecisionOutcome> {
  if (!knownOps.has(op.op as ChangesetOpType)) {
    return { verdict: "reject", cause: "unknown_operation" };
  }

  const canonical = await canonicalize(config.repo_root, op.path);
  if (!canonical.ok) {
    return { verdict: "reject", cause: "unresolvable_path" };
  }

  const resolvedPath = canonical.resolved;

  /* The same filesystem fact answers two questions with OPPOSITE safe defaults,
     so it is read once and applied twice rather than folded globally.
     Widening what is allowed on a guess would let a genuinely different file
     through on a case-sensitive volume, so `allowed` folds only when the
     filesystem is PROVEN to be case-insensitive. Narrowing what is forbidden on
     a guess would let a worker evade a forbidden entry by shifting a letter, so
     `forbidden` and `critical` fold unless the filesystem is proven sensitive.
     Both directions refuse when unsure; neither invents a new failure mode. */
  const behaviour = await pathCaseBehaviour(config.repo_root);
  const allowMatch: MatchOptions = { caseInsensitive: behaviour === "case-insensitive" };
  const denyMatch: MatchOptions = { caseInsensitive: behaviour !== "case-sensitive" };

  if (workerProtectedPathReason(resolvedPath) !== null) {
    return { verdict: "reject", cause: "protected_path" };
  }
  if (!isAllowedPath(resolvedPath, contract, config, allowMatch)) {
    return { verdict: "reject", cause: "outside_allowed_files" };
  }

  if (op.op === "delete" && isForbiddenPath(resolvedPath, contract, config, denyMatch)) {
    return { verdict: "reject", cause: "delete_forbidden_path" };
  }
  if (op.op === "delete" && isCriticalPath(resolvedPath, config, denyMatch)) {
    return { verdict: "reject", cause: "delete_critical_path" };
  }

  if (op.op === "symlink") {
    return { verdict: "reject", cause: "symlink" };
  }

  if (op.op === "chmod" || op.op === "submodule" || op.op === "gitattr") {
    return { verdict: "escalate", cause: "mode_or_metadata_change" };
  }
  if (isGitBehaviorPath(resolvedPath)) {
    return { verdict: "escalate", cause: "git_behavior_file" };
  }
  if (isDependencyPath(resolvedPath)) {
    return { verdict: "escalate", cause: "dependency_file" };
  }

  return { verdict: "pass", cause: "allowed" };
}

/* One sentence in the voice every user-facing surface uses. This is written
   where the decision is made, because only here is the cause known without
   guessing. It never contains an internal term: `plain_reason` is read straight
   onto a primary surface, so anything unsayable here is unsayable there. */
export function plainDecisionReason(cause: DecisionCause, op: DecisionOp): string {
  const file = op.path;
  switch (cause) {
    case "unknown_operation":
      return `It tried to make a kind of change to ${file} that is not allowed.`;
    case "unresolvable_path":
      return `It tried to change ${file}, which is not a real file inside this project.`;
    case "protected_path":
      return `It tried to change ${file}, which only you can change.`;
    case "outside_allowed_files":
      return op.op === "add"
        ? `It tried to create ${file}, which is not one of the files this task was given.`
        : `It tried to edit ${file}, which is not one of the files this task was given.`;
    case "delete_forbidden_path":
      return `It tried to delete ${file}, which this task was told to leave alone.`;
    case "delete_critical_path":
      return `It tried to delete ${file}, which is too important to remove automatically.`;
    case "symlink":
      return `It tried to add a shortcut to another file at ${file}, which is not allowed.`;
    case "mode_or_metadata_change":
      return `It tried to change how ${file} is stored rather than what is in it, which needs your say-so.`;
    case "git_behavior_file":
      return `It tried to change ${file}, which affects the whole project, so it needs your say-so.`;
    case "dependency_file":
      return `It tried to change ${file}, which adds or updates a package, so it needs your say-so.`;
    case "allowed":
      return `This task was given ${file}, so the change is fine.`;
  }
}

function isAllowedPath(
  pathValue: string,
  contract: TaskContract,
  config: DecisionConfig,
  match: MatchOptions
): boolean {
  return (
    matchesAny(pathValue, contract.allowed_files, match) ||
    matchesAny(pathValue, config.allowed_globs, match)
  );
}

function isForbiddenPath(
  pathValue: string,
  contract: TaskContract,
  config: DecisionConfig,
  match: MatchOptions
): boolean {
  return (
    matchesAny(pathValue, contract.forbidden_files, match) ||
    matchesAny(pathValue, config.forbidden_globs, match)
  );
}

function isCriticalPath(pathValue: string, config: DecisionConfig, match: MatchOptions): boolean {
  return matchesAny(pathValue, config.critical_globs ?? [], match);
}

function isGitBehaviorPath(pathValue: string): boolean {
  return pathValue === ".gitattributes" || pathValue === ".gitignore" || pathValue === ".gitmodules";
}

function isDependencyPath(pathValue: string): boolean {
  return dependencyFiles.has(pathValue.split("/").at(-1) ?? "");
}
