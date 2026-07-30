import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  recordAdapterUsage,
  runAdapterProcess
} from "./adapter.js";
import {
  validateCharacterizationCandidate,
  type CharacterizationCandidateArtifact
} from "./characterization.js";
import { withDetachedCheckout } from "./changeset.js";
import { loadConfig, type VerificationCheckConfig } from "./config.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { contextPackRelativePath, loadContextPackForContract } from "./context-pack.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { readEvents, type HivemindEvent } from "./events.js";

export interface CharacterizationGenerationResult {
  task_id: string;
  candidate_id: string;
  tool: string;
  check_id: string;
  session_id: string;
  adapter: {
    exit_code: number;
    wall_time_ms: number;
    output_log: string | null;
    effective_tokens: number;
    accounting_source: "provider_reported" | "self_measured";
  };
  disposer: "M7.6c validateCharacterizationCandidate";
  candidate: CharacterizationCandidateArtifact;
}

export type CharacterizationGenerationOutcome =
  | { ok: true; value: CharacterizationGenerationResult }
  | { ok: false; reason: string; budget_exceeded?: true };

interface CharacterizationEvidence {
  changedFiles: string[];
  structuralOracle: Record<string, unknown>;
  runtimeCoverage: Record<string, unknown>;
}

export async function generateCharacterizationCandidate(
  repoRoot: string,
  taskId: string,
  tool: string,
  requestedCheckId?: string
): Promise<CharacterizationGenerationOutcome> {
  const configResult = await loadConfig(repoRoot);
  if (!configResult.ok) {
    return configResult;
  }
  const testPaths = configResult.config.verification?.test_paths ?? [];
  if (testPaths.length === 0) {
    return { ok: false, reason: "no configured test paths: verification.test_paths is unset or empty" };
  }
  const checkResult = selectCheck(configResult.config.verification?.checks ?? [], requestedCheckId);
  if (!checkResult.ok) {
    return checkResult;
  }
  const contractResult = await loadAndValidateContract(repoRoot, taskId);
  if (!contractResult.ok) {
    return contractResult;
  }
  const taskPatchResult = await readTaskPatch(repoRoot, taskId);
  if (!taskPatchResult.ok) {
    return taskPatchResult;
  }
  const evidenceResult = await loadTaskVerificationEvidence(repoRoot, taskId);
  if (!evidenceResult.ok) {
    return evidenceResult;
  }
  const contextPackResult = await loadContextPackForContract(repoRoot, contractResult.contract);
  if (!contextPackResult.ok) {
    return contextPackResult;
  }
  const profileResult = await loadAdapterProfile(repoRoot, tool);
  if (!profileResult.ok) {
    return profileResult;
  }
  const dangerousArgs = findDangerousAdapterArgs(profileResult.profile.invoke);
  if (dangerousArgs.length > 0) {
    return {
      ok: false,
      reason: `characterization adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); candidate generation must use a confined writable profile`
    };
  }

  const candidateId = `C-${taskId}-${randomUUID()}`;
  const sessionId = `characterization-${taskId}`;
  const prompt = buildCharacterizationPrompt({
    contract: contractResult.contract,
    taskPatch: taskPatchResult.value,
    check: checkResult.value,
    inventory: configResult.config.verification?.checks ?? [],
    testPaths,
    evidence: evidenceResult.value,
    contextPack:
      contextPackResult.value === null
        ? null
        : {
            ref: contextPackRelativePath(taskId),
            markdown: contextPackResult.value.markdown
          }
  });
  const outputLogPath = adapterRunLogPath(repoRoot, `characterize-${taskId}`);
  const checkoutResult = await withDetachedCheckout(
    repoRoot,
    contractResult.contract.base_commit,
    async (checkoutPath): Promise<CharacterizationGenerationOutcome> => {
      const startedAt = Date.now();
      const processResult = await runAdapterProcess(
        repoRoot,
        profileResult.profile,
        checkoutPath,
        prompt,
        {
          outputLogPath,
          usageSessionId: sessionId
        }
      );
      if (!processResult.ok) {
        return processResult;
      }
      const wallTimeMs = Date.now() - startedAt;
      const ledgerResult = await recordAdapterUsage(
        repoRoot,
        profileResult.profile,
        prompt,
        processResult.value,
        wallTimeMs
      );
      if (!ledgerResult.ok) {
        return ledgerResult;
      }
      if (processResult.value.exitCode !== 0) {
        return {
          ok: false,
          reason: formatAdapterProcessFailure(tool, processResult.value, "characterization adapter")
        };
      }

      const diffResult = await captureWorktreeDiff(checkoutPath, contractResult.contract.base_commit);
      if (!diffResult.ok) {
        return diffResult;
      }
      if (diffResult.value.diff.trim() === "") {
        return {
          ok: false,
          reason: `characterization adapter "${tool}" produced no candidate patch`
        };
      }

      const validation = await validateCharacterizationCandidate(repoRoot, {
        candidate_id: candidateId,
        task_id: taskId,
        check_id: checkResult.value.id,
        patch: diffResult.value.diff
      });
      if (!validation.ok) {
        return validation;
      }

      return {
        ok: true,
        value: {
          task_id: taskId,
          candidate_id: candidateId,
          tool: profileResult.profile.tool,
          check_id: checkResult.value.id,
          session_id: sessionId,
          adapter: {
            exit_code: processResult.value.exitCode,
            wall_time_ms: wallTimeMs,
            output_log: processResult.value.outputLogPath,
            effective_tokens: ledgerResult.value.last_request?.effective_tokens ?? 0,
            accounting_source: ledgerResult.value.last_request?.accounting_source ?? "self_measured"
          },
          disposer: "M7.6c validateCharacterizationCandidate",
          candidate: validation.value
        }
      };
    }
  );

  return checkoutResult.ok ? checkoutResult.value : checkoutResult;
}

function selectCheck(
  inventory: VerificationCheckConfig[],
  requestedCheckId: string | undefined
): { ok: true; value: VerificationCheckConfig } | { ok: false; reason: string } {
  if (inventory.length === 0) {
    return { ok: false, reason: "verification.checks is empty; no named check can validate a candidate" };
  }
  if (requestedCheckId !== undefined) {
    const selected = inventory.find((check) => check.id === requestedCheckId);
    return selected === undefined
      ? { ok: false, reason: `verification check not found: ${requestedCheckId}` }
      : { ok: true, value: selected };
  }
  return inventory.length === 1
    ? { ok: true, value: inventory[0] }
    : {
        ok: false,
        reason: `multiple verification checks are configured; select one with --check <id> (${inventory.map((check) => check.id).join(", ")})`
      };
}

async function readTaskPatch(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  const relativePath = `.hivemind/patches/${taskId}/diff.patch`;
  try {
    const patch = await readFile(path.join(repoRoot, relativePath), "utf8");
    return patch.trim() === ""
      ? { ok: false, reason: `task patch is empty: ${relativePath}` }
      : { ok: true, value: patch };
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { ok: false, reason: `task patch not found: ${relativePath}` }
      : { ok: false, reason: `task patch could not be read: ${errorMessage(error)}` };
  }
}

async function loadTaskVerificationEvidence(
  repoRoot: string,
  taskId: string
): Promise<{ ok: true; value: CharacterizationEvidence } | { ok: false; reason: string }> {
  const eventsResult = await readEvents(repoRoot);
  if (!eventsResult.ok) {
    return eventsResult;
  }
  let event: HivemindEvent | undefined;
  for (let index = eventsResult.value.length - 1; index >= 0; index -= 1) {
    const entry = eventsResult.value[index];
    if (
      entry.type === "verification.completed" &&
      Array.isArray(entry.data.task_ids) &&
      entry.data.task_ids.every((value: unknown) => typeof value === "string") &&
      entry.data.task_ids.includes(taskId)
    ) {
      event = entry;
      break;
    }
  }
  if (event === undefined) {
    return {
      ok: false,
      reason: `no task-bound verification.completed evidence found for ${taskId}; run shadow verification before characterization generation`
    };
  }
  if (
    !Array.isArray(event.data.changed_files) ||
    !event.data.changed_files.every((value: unknown) => typeof value === "string") ||
    !isRecord(event.data.structural_oracle) ||
    !isRecord(event.data.runtime_coverage)
  ) {
    return {
      ok: false,
      reason: `verification.completed evidence for ${taskId} is incomplete or malformed`
    };
  }
  return {
    ok: true,
    value: {
      changedFiles: event.data.changed_files,
      structuralOracle: event.data.structural_oracle,
      runtimeCoverage: event.data.runtime_coverage
    }
  };
}

function buildCharacterizationPrompt(input: {
  contract: TaskContract;
  taskPatch: string;
  check: VerificationCheckConfig;
  inventory: VerificationCheckConfig[];
  testPaths: string[];
  evidence: CharacterizationEvidence;
  contextPack: { ref: string; markdown: string } | null;
}): string {
  return [
    "You are Hivemind's characterization-test proposer.",
    "This checkout is a disposable checkout at the task's exact pre-change base commit.",
    "Create a substantive test that characterizes existing behavior and helps exercise the uncovered impact.",
    "You PROPOSE only. Hivemind's independent M7.6c harness decides validity after you exit.",
    "Do not claim that the candidate passes, is valid, fixes coverage, is integrated, or is promoted.",
    "Modify files only inside the repository-authored test paths listed below.",
    "Do not modify source, configuration, canon, .hivemind state, or any existing task worktree.",
    "Do not apply the task patch. It is supplied only so you can understand the proposed change.",
    `The exact validation check will be: ${input.check.id} -> ${input.check.command}`,
    "Finish after writing the candidate test files. Your prose output is advisory and is not parsed as authority.",
    "",
    "Task contract and grounded scope:",
    JSON.stringify(input.contract, null, 2),
    "",
    "Repository-authored test-only paths:",
    JSON.stringify(input.testPaths, null, 2),
    "",
    "Verification inventory:",
    JSON.stringify(input.inventory, null, 2),
    "",
    "Task-bound M7.6a structural impact evidence:",
    JSON.stringify(input.evidence.structuralOracle, null, 2),
    "",
    "Task-bound M7.6b runtime changed-line evidence:",
    JSON.stringify(input.evidence.runtimeCoverage, null, 2),
    "",
    "Changed-file manifest:",
    JSON.stringify(input.evidence.changedFiles, null, 2),
    "",
    "Task patch under evaluation (reference only):",
    fenced(input.taskPatch),
    "",
    `Context-pack reference: ${input.contextPack?.ref ?? "(none)"}`,
    input.contextPack?.markdown ?? "Context pack: (none)"
  ].join("\n");
}

function fenced(value: string): string {
  return ["```diff", value.replace(/\r\n/gu, "\n").trimEnd(), "```"].join("\n");
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
