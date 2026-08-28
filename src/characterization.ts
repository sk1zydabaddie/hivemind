import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "./atomic.js";
import { runNamedCheck, type NamedCheckResult } from "./check-runner.js";
import {
  applyPatchToCheckout,
  withResolvedChangesetCheckouts
} from "./changeset.js";
import { loadConfig, type HivemindConfig } from "./config.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { runGate, type GateResult } from "./gate.js";
import { validateTaskId } from "./task-id.js";
import { resolveTaskAuthoringBase } from "./task-authoring-base.js";

const execFileAsync = promisify(execFile);
const allowedCandidateFields = new Set(["candidate_id", "task_id", "check_id", "patch"]);
const semanticInterpretation =
  "A post-change failure is a behavior-flip signal. It may be a regression or an intended behavior change; only a human decides.";

export type CharacterizationClassification =
  | "rejected"
  | "regression_signal"
  | "valid_characterization"
  | "indeterminate";

export interface CharacterizationCandidateInput {
  candidate_id: string;
  task_id: string;
  check_id: string;
  patch: string;
}

export interface CheckoutIdentity {
  head_commit: string;
  index_tree: string;
  status_hash: string;
  worktree_content_hash: string;
}

export interface CharacterizationAttempt {
  tree: "base_with_candidate" | "post_change_with_candidate";
  check_id: string;
  command: string;
  runs: NamedCheckResult[];
  identity_before: CheckoutIdentity;
  identity_after: CheckoutIdentity;
}

export interface CharacterizationValidation {
  version: 1;
  candidate_id: string;
  task_id: string;
  classification: CharacterizationClassification;
  reason: string;
  advisory_only: true;
  semantic_interpretation: string;
  base_commit: string;
  task_patch_sha256: string;
  candidate_patch_sha256: string;
  test_scope_source: "verification.test_paths";
  configured_test_paths: string[];
  gate: GateResult;
  check_id: string;
  check_command: string;
  same_check_both_trees: true;
  attempts: CharacterizationAttempt[];
}

export interface CharacterizationCandidateArtifact {
  candidate_id: string;
  artifact_path: string;
  classification: CharacterizationClassification;
  reason: string;
  validation: CharacterizationValidation;
}

export type ValidateCharacterizationResult =
  | { ok: true; value: CharacterizationCandidateArtifact }
  | { ok: false; reason: string };

interface ValidatedCandidateContext {
  candidate: CharacterizationCandidateInput;
  config: HivemindConfig;
  contract: TaskContract;
  check: { id: string; command: string };
  testPaths: string[];
  resolvedBaseCommit: string;
  taskPatchPath: string;
  taskPatch: string;
}

interface ClassificationResult {
  classification: CharacterizationClassification;
  reason: string;
  attempts: CharacterizationAttempt[];
}

export async function validateCharacterizationCandidate(
  repoRoot: string,
  rawCandidate: unknown
): Promise<ValidateCharacterizationResult> {
  const contextResult = await loadCandidateContext(repoRoot, rawCandidate);
  if (!contextResult.ok) {
    return contextResult;
  }
  const context = contextResult.value;
  const candidateRoot = path.join(repoRoot, ".hivemind", "resource", "oracle-candidates");
  const finalArtifactPath = path.join(candidateRoot, context.candidate.candidate_id);
  if (await exists(finalArtifactPath)) {
    return {
      ok: false,
      reason: `characterization candidate already exists: .hivemind/resource/oracle-candidates/${context.candidate.candidate_id}`
    };
  }

  await mkdir(candidateRoot, { recursive: true });
  const tempArtifactPath = path.join(
    candidateRoot,
    `.${context.candidate.candidate_id}.${process.pid}.${randomUUID()}.tmp`
  );
  await mkdir(tempArtifactPath);

  try {
    const candidatePatchPath = path.join(tempArtifactPath, "candidate.patch");
    await writeFile(candidatePatchPath, context.candidate.patch, "utf8");
    const candidatePatchSha256 = hashText(context.candidate.patch);
    const taskPatchSha256 = hashText(context.taskPatch);
    const gate = await runCandidateGate(context, candidatePatchPath);
    let classification: ClassificationResult;

    if (gate.verdict !== "accept" || gate.reason === "no changes") {
      classification = {
        classification: "rejected",
        reason: gate.reason === "no changes" ? "candidate patch is empty" : `candidate scope gate ${gate.verdict}: ${gate.reason}`,
        attempts: []
      };
    } else {
      classification = await classifyCandidate(context, candidatePatchPath);
    }

    const currentTaskPatch = await readFile(context.taskPatchPath, "utf8").catch(() => null);
    if (currentTaskPatch === null || hashText(currentTaskPatch) !== taskPatchSha256) {
      classification = {
        classification: "indeterminate",
        reason: "task patch changed during characterization validation",
        attempts: classification.attempts
      };
    }

    const validation: CharacterizationValidation = {
      version: 1,
      candidate_id: context.candidate.candidate_id,
      task_id: context.candidate.task_id,
      classification: classification.classification,
      reason: classification.reason,
      advisory_only: true,
      semantic_interpretation: semanticInterpretation,
      base_commit: context.resolvedBaseCommit,
      task_patch_sha256: taskPatchSha256,
      candidate_patch_sha256: candidatePatchSha256,
      test_scope_source: "verification.test_paths",
      configured_test_paths: context.testPaths,
      gate,
      check_id: context.check.id,
      check_command: context.check.command,
      same_check_both_trees: true,
      attempts: classification.attempts
    };
    const manifest = {
      version: 1,
      candidate_id: context.candidate.candidate_id,
      task_id: context.candidate.task_id,
      base_commit: context.resolvedBaseCommit,
      check_id: context.check.id,
      check_command: context.check.command,
      test_scope_source: "verification.test_paths",
      configured_test_paths: context.testPaths,
      candidate_patch_sha256: candidatePatchSha256,
      task_patch_ref: `.hivemind/patches/${context.candidate.task_id}/diff.patch`,
      task_patch_sha256: taskPatchSha256
    };

    await writeJsonAtomic(path.join(tempArtifactPath, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(tempArtifactPath, "validation.json"), validation);
    await rename(tempArtifactPath, finalArtifactPath);
    return {
      ok: true,
      value: {
        candidate_id: context.candidate.candidate_id,
        artifact_path: path.relative(repoRoot, finalArtifactPath).replaceAll("\\", "/"),
        classification: validation.classification,
        reason: validation.reason,
        validation
      }
    };
  } catch (error: unknown) {
    return { ok: false, reason: `characterization validation failed: ${errorMessage(error)}` };
  } finally {
    await rm(tempArtifactPath, { recursive: true, force: true });
  }
}

async function loadCandidateContext(
  repoRoot: string,
  rawCandidate: unknown
): Promise<{ ok: true; value: ValidatedCandidateContext } | { ok: false; reason: string }> {
  const candidateResult = validateCandidateInput(rawCandidate);
  if (!candidateResult.ok) {
    return candidateResult;
  }
  const candidate = candidateResult.value;
  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }
  const testPaths = configResult.config.verification?.test_paths ?? [];
  if (testPaths.length === 0) {
    return { ok: false, reason: "no configured test paths: verification.test_paths is unset or empty" };
  }
  const check = configResult.config.verification?.checks.find((entry) => entry.id === candidate.check_id);
  if (check === undefined) {
    return { ok: false, reason: `verification check not found: ${candidate.check_id}` };
  }
  const contractResult = await loadAndValidateContract(repoRoot, candidate.task_id);
  if (!contractResult.ok) {
    return contractResult;
  }
  const authoringBase = await resolveTaskAuthoringBase(repoRoot, contractResult.contract);
  if (!authoringBase.ok) {
    return { ok: false, reason: `base tree identity could not be established: ${authoringBase.reason}` };
  }
  const taskPatchPath = path.join(repoRoot, ".hivemind", "patches", candidate.task_id, "diff.patch");
  let taskPatch: string;
  try {
    taskPatch = await readFile(taskPatchPath, "utf8");
  } catch (error: unknown) {
    return {
      ok: false,
      reason: isNodeError(error, "ENOENT")
        ? `task patch not found: .hivemind/patches/${candidate.task_id}/diff.patch`
        : `task patch could not be read: ${errorMessage(error)}`
    };
  }
  if (taskPatch.trim() === "") {
    return { ok: false, reason: `task patch is empty: .hivemind/patches/${candidate.task_id}/diff.patch` };
  }

  return {
    ok: true,
    value: {
      candidate,
      config: configResult.config,
      contract: contractResult.contract,
      check: { id: check.id, command: check.command },
      testPaths,
      resolvedBaseCommit: authoringBase.value.commit,
      taskPatchPath,
      taskPatch
    }
  };
}

function validateCandidateInput(
  rawCandidate: unknown
): { ok: true; value: CharacterizationCandidateInput } | { ok: false; reason: string } {
  if (!isRecord(rawCandidate)) {
    return { ok: false, reason: "characterization candidate must be a JSON object" };
  }
  const unsupported = Object.keys(rawCandidate).filter((field) => !allowedCandidateFields.has(field));
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `unsupported characterization candidate fields: ${unsupported.sort().join(", ")}`
    };
  }
  for (const field of allowedCandidateFields) {
    if (typeof rawCandidate[field] !== "string" || rawCandidate[field].trim() === "") {
      return { ok: false, reason: `${field} must be a non-empty string` };
    }
  }
  const candidateId = String(rawCandidate.candidate_id);
  const candidateIdProblem = validateTaskId(candidateId);
  if (candidateIdProblem !== null) {
    return { ok: false, reason: `invalid candidate id "${candidateId}": ${candidateIdProblem}` };
  }
  const taskId = String(rawCandidate.task_id);
  const taskIdProblem = validateTaskId(taskId);
  if (taskIdProblem !== null) {
    return { ok: false, reason: `invalid task id "${taskId}": ${taskIdProblem}` };
  }
  return {
    ok: true,
    value: {
      candidate_id: candidateId,
      task_id: taskId,
      check_id: String(rawCandidate.check_id).trim(),
      patch: String(rawCandidate.patch)
    }
  };
}

async function runCandidateGate(context: ValidatedCandidateContext, patchPath: string): Promise<GateResult> {
  const candidateContract: TaskContract = {
    task_id: context.candidate.task_id,
    title: "Characterization candidate",
    agent_role: "reviewer",
    routing_task_type: "testing",
    base_commit: context.resolvedBaseCommit,
    acceptance_criterion: "Candidate remains inside repository-configured test paths.",
    allowed_files: context.testPaths,
    allowed_file_intents: Object.fromEntries(context.testPaths.map((entry) => [entry, "modify"])),
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: [context.check.command],
    patch_requirements: ["test-only characterization candidate"]
  };
  return runGate(context.resolvedBaseCommit, patchPath, candidateContract, {
    ...context.config,
    allowed_globs: []
  });
}

async function classifyCandidate(
  context: ValidatedCandidateContext,
  candidatePatchPath: string
): Promise<ClassificationResult> {
  const checkouts = await withResolvedChangesetCheckouts(
    context.config.repo_root,
    context.resolvedBaseCommit,
    candidatePatchPath,
    async ({ baseCheckoutPath, appliedCheckoutPath }) => {
      const attempts: CharacterizationAttempt[] = [];
      const baseAttempt = await runRepeatedCheck(
        appliedCheckoutPath,
        "base_with_candidate",
        context.check.id,
        context.check.command
      );
      attempts.push(baseAttempt);
      const baseIdentityProblem = identityProblem(baseAttempt, context.resolvedBaseCommit);
      if (baseIdentityProblem !== null) {
        return indeterminate(baseIdentityProblem, attempts);
      }
      const baseOutcome = stableOutcome(baseAttempt.runs);
      if (baseOutcome === null) {
        return indeterminate("candidate check was non-deterministic on the pre-change base", attempts);
      }
      if (baseOutcome === "fail") {
        return {
          classification: "rejected" as const,
          reason: "candidate check fails on the pre-change base",
          attempts
        };
      }

      const taskApply = await applyPatchToCheckout(baseCheckoutPath, context.taskPatchPath);
      if (!taskApply.ok) {
        return indeterminate("post-change tree identity could not be established: task patch does not apply to declared base", attempts);
      }
      const candidateApply = await applyPatchToCheckout(baseCheckoutPath, candidatePatchPath);
      if (!candidateApply.ok) {
        return indeterminate("post-change tree identity could not be established: candidate patch does not apply after task patch", attempts);
      }

      const postAttempt = await runRepeatedCheck(
        baseCheckoutPath,
        "post_change_with_candidate",
        context.check.id,
        context.check.command
      );
      attempts.push(postAttempt);
      const postIdentityProblem = identityProblem(postAttempt, context.resolvedBaseCommit);
      if (postIdentityProblem !== null) {
        return indeterminate(postIdentityProblem, attempts);
      }
      const postOutcome = stableOutcome(postAttempt.runs);
      if (postOutcome === null) {
        return indeterminate("candidate check was non-deterministic on the post-change tree", attempts);
      }
      return postOutcome === "fail"
        ? {
            classification: "regression_signal" as const,
            reason: "candidate passes on base and fails after the task patch; behavior-flip signal recorded for human interpretation",
            attempts
          }
        : {
            classification: "valid_characterization" as const,
            reason: "candidate passes on both the pre-change base and post-change tree",
            attempts
          };
    }
  );

  return checkouts.ok
    ? checkouts.value
    : {
        classification: "indeterminate",
        reason: `tree identity could not be established: ${checkouts.reason}`,
        attempts: []
      };
}

async function runRepeatedCheck(
  checkoutPath: string,
  tree: CharacterizationAttempt["tree"],
  checkId: string,
  command: string
): Promise<CharacterizationAttempt> {
  const identityBefore = await readCheckoutIdentity(checkoutPath);
  const runs = [
    await runNamedCheck(checkoutPath, checkId, command),
    await runNamedCheck(checkoutPath, checkId, command)
  ];
  const identityAfter = await readCheckoutIdentity(checkoutPath);
  return {
    tree,
    check_id: checkId,
    command,
    runs,
    identity_before: identityBefore,
    identity_after: identityAfter
  };
}

async function readCheckoutIdentity(checkoutPath: string): Promise<CheckoutIdentity> {
  const head = await gitOutput(checkoutPath, ["rev-parse", "HEAD"]);
  const tree = await gitOutput(checkoutPath, ["write-tree"]);
  const status = await gitOutput(checkoutPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const contentHash = await hashCheckoutContent(checkoutPath);
  return {
    head_commit: head.trim(),
    index_tree: tree.trim(),
    status_hash: hashText(status),
    worktree_content_hash: contentHash
  };
}

function identityProblem(attempt: CharacterizationAttempt, expectedHead: string): string | null {
  if (attempt.identity_before.head_commit !== expectedHead || attempt.identity_after.head_commit !== expectedHead) {
    return `${attempt.tree} HEAD does not match the declared base commit`;
  }
  if (
    attempt.identity_before.index_tree !== attempt.identity_after.index_tree ||
    attempt.identity_before.status_hash !== attempt.identity_after.status_hash ||
    attempt.identity_before.worktree_content_hash !== attempt.identity_after.worktree_content_hash
  ) {
    return `${attempt.tree} changed while its check was running`;
  }
  return null;
}

async function hashCheckoutContent(checkoutPath: string): Promise<string> {
  const trackedDiff = await gitOutput(checkoutPath, ["diff", "--binary", "--no-ext-diff", "HEAD"]);
  const untrackedOutput = await gitOutput(checkoutPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const digest = createHash("sha256");
  digest.update(trackedDiff);
  for (const relativePath of untrackedOutput.split("\0").filter((entry) => entry !== "").sort()) {
    const absolutePath = path.join(checkoutPath, relativePath);
    const file = await lstat(absolutePath);
    digest.update(`\0${relativePath}\0${file.isSymbolicLink() ? "symlink" : file.isFile() ? "file" : "other"}\0`);
    if (file.isFile()) {
      digest.update(await readFile(absolutePath));
    }
  }
  return digest.digest("hex");
}

function stableOutcome(runs: NamedCheckResult[]): "pass" | "fail" | null {
  const outcomes = new Set(runs.map((run) => run.exit_code === 0 ? "pass" : "fail"));
  return outcomes.size === 1 ? [...outcomes][0] as "pass" | "fail" : null;
}

function indeterminate(reason: string, attempts: CharacterizationAttempt[]): ClassificationResult {
  return { classification: "indeterminate", reason, attempts };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
  return result.stdout;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "unknown error";
}
