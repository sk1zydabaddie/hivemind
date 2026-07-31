import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "./atomic.js";
import { withDetachedCheckout } from "./changeset.js";
import { loadConfig, type HivemindConfig } from "./config.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { captureWorktreeDiff } from "./diff-capture.js";
import { appendEvent } from "./events.js";
import { runGate, type GateResult } from "./gate.js";
import {
  runShadowVerification,
  type VerificationRunResult
} from "./integrate.js";
import {
  loadAdmittedValueQualityRun,
  type AdmittedValueQualityRun
} from "./value-quality.js";
import { finalizeQualityRunCancellation, qualityRunCancelled } from "./quality-control.js";

const execFileAsync = promisify(execFile);
const draftIdPattern = /^D-(00[1-3])$/u;
const refinementId = "R-001";

export interface SpeculativeDraftOutput {
  stream: "stdout" | "stderr";
  text: string;
}

export interface SpeculativeDraftProvenance {
  source: "adapter";
  tool: string;
  provider_tier: "local" | "cheap" | "standard" | "strong";
  profile_verified_on: string;
  usage_session_id: string;
  exit_code: number | null;
  wall_time_ms: number;
  effective_tokens: number | null;
  accounting_source: "provider_reported" | "self_measured" | null;
  provider_usage_status: "captured" | "not_available" | "expected_but_unparseable" | null;
}

export type SpeculativeDraftProducerResult =
  | {
      status: "completed";
      output?: SpeculativeDraftOutput[];
      provenance?: SpeculativeDraftProvenance;
    }
  | {
      status: "crashed" | "timed_out" | "cancelled";
      reason: string;
      output?: SpeculativeDraftOutput[];
      provenance?: SpeculativeDraftProvenance;
    };

export type SpeculativeDraftProducer = (
  checkoutPath: string
) => Promise<SpeculativeDraftProducerResult>;

export interface SpeculativeDraftRequest {
  quality_run_id: string;
  draft_id: string;
}

export type SpeculativeDraftOutcome =
  | "eligible"
  | "empty"
  | "gate_rejected"
  | "shadow_failed"
  | "producer_crashed"
  | "producer_timed_out"
  | "producer_cancelled"
  | "producer_exception"
  | "indeterminate";

export interface DraftGateEvidence {
  disposer: "runGate";
  status: "not_run" | "accept" | "reject" | "escalate";
  reason: string;
  result: GateResult | null;
}

export interface DraftShadowEvidence {
  disposer: "runVerification";
  status: "not_run" | "pass" | "fail" | "indeterminate";
  reason: string;
  result: VerificationRunResult | null;
}

export interface SpeculativeDraftArtifact {
  version: 1;
  quality_run_id: string;
  draft_id: string;
  task_id: string;
  artifact_path: string;
  outcome: SpeculativeDraftOutcome;
  eligible_for_selection: boolean;
  reason: string;
  changed_files: string[];
  diff_sha256: string;
  checkout_instance_id: string;
  checkout_path_sha256: string;
  base_commit: string;
  provenance: SpeculativeDraftProvenance | null;
  gate: DraftGateEvidence;
  shadow: DraftShadowEvidence;
}

export type SpeculativeDraftResult =
  | { ok: true; value: SpeculativeDraftArtifact }
  | { ok: false; reason: string };

interface CheckoutExecution {
  outcome: SpeculativeDraftOutcome;
  reason: string;
  changedFiles: string[];
  diff: string;
  output: SpeculativeDraftOutput[];
  checkoutInstanceId: string;
  checkoutPathSha256: string;
  provenance: SpeculativeDraftProvenance | null;
  gate: DraftGateEvidence;
  shadow: DraftShadowEvidence;
}

export async function disposeSpeculativeDraft(
  repoRoot: string,
  request: SpeculativeDraftRequest,
  producer: SpeculativeDraftProducer
): Promise<SpeculativeDraftResult> {
  const admitted = await loadAdmittedValueQualityRun(repoRoot, request.quality_run_id);
  if (!admitted.ok) {
    return admitted;
  }
  const identityReason = validateDraftIdentity(admitted.value, request.draft_id);
  if (identityReason !== null) {
    return { ok: false, reason: identityReason };
  }
  const contract = await loadAndValidateContract(repoRoot, admitted.value.task_id);
  if (!contract.ok) {
    return contract;
  }
  const config = await loadConfig(repoRoot);
  if (!config.ok) {
    return config;
  }
  const baseCommit = await resolveCommit(repoRoot, contract.contract.base_commit);
  if (!baseCommit.ok) {
    return baseCommit;
  }

  const qualityRoot = path.join(
    repoRoot,
    ".hivemind",
    "resource",
    "quality-runs",
    request.quality_run_id
  );
  const draftsRoot = path.join(qualityRoot, "drafts");
  const finalArtifactPath = path.join(draftsRoot, request.draft_id);
  if (await pathExists(finalArtifactPath)) {
    return { ok: false, reason: `speculative draft artifact already exists: ${artifactRelativePath(repoRoot, finalArtifactPath)}` };
  }
  await ensureQualityRunManifest(qualityRoot, admitted.value, baseCommit.value);
  await mkdir(draftsRoot, { recursive: true });

  const tempArtifactPath = path.join(
    draftsRoot,
    `.${request.draft_id}.${process.pid}.${randomUUID()}.tmp`
  );
  await mkdir(tempArtifactPath);
  const patchPath = path.join(tempArtifactPath, "diff.patch");
  let execution: CheckoutExecution;

  const started = await appendEvent(repoRoot, {
    type: "quality.draft_started",
    task_id: admitted.value.task_id,
    data: {
      version: 1,
      quality_run_id: request.quality_run_id,
      draft_id: request.draft_id,
      base_commit: baseCommit.value,
      advisory_only: true
    }
  });
  if (!started.ok) {
    await rm(tempArtifactPath, { recursive: true, force: true });
    return started;
  }

  try {
    execution = await executeInDetachedCheckout(
      repoRoot,
      baseCommit.value,
      admitted.value,
      request.draft_id,
      patchPath,
      contract.contract,
      config.config,
      producer
    );
    await writeDraftArtifact(
      tempArtifactPath,
      admitted.value,
      request.draft_id,
      baseCommit.value,
      execution
    );
    await rename(tempArtifactPath, finalArtifactPath);
  } catch (error: unknown) {
    await rm(tempArtifactPath, { recursive: true, force: true });
    return { ok: false, reason: `speculative draft disposal failed: ${errorMessage(error)}` };
  }

  const artifact: SpeculativeDraftArtifact = {
    version: 1,
    quality_run_id: request.quality_run_id,
    draft_id: request.draft_id,
    task_id: admitted.value.task_id,
    artifact_path: artifactRelativePath(repoRoot, finalArtifactPath),
    outcome: execution.outcome,
    eligible_for_selection: execution.outcome === "eligible",
    reason: execution.reason,
    changed_files: execution.changedFiles,
    diff_sha256: hashText(execution.diff),
    checkout_instance_id: execution.checkoutInstanceId,
    checkout_path_sha256: execution.checkoutPathSha256,
    base_commit: baseCommit.value,
    provenance: execution.provenance,
    gate: execution.gate,
    shadow: execution.shadow
  };
  const disposed = await appendEvent(repoRoot, {
    type: "quality.draft_disposed",
    task_id: admitted.value.task_id,
    data: {
      ...artifact,
      advisory_only: true
    }
  });
  if (!disposed.ok) {
    return { ok: false, reason: `draft artifact was written but quality.draft_disposed could not be appended: ${disposed.reason}` };
  }
  if (await qualityRunCancelled(repoRoot, request.quality_run_id)) {
    const finalized = await finalizeQualityRunCancellation(repoRoot, request.quality_run_id);
    if (!finalized.ok) return finalized;
  }
  return { ok: true, value: artifact };
}

async function executeInDetachedCheckout(
  repoRoot: string,
  baseCommit: string,
  admitted: AdmittedValueQualityRun,
  draftId: string,
  patchPath: string,
  contract: TaskContract,
  config: HivemindConfig,
  producer: SpeculativeDraftProducer
): Promise<CheckoutExecution> {
  const checkoutInstanceId = randomUUID();
  try {
    const checkout = await withDetachedCheckout(repoRoot, baseCommit, async (checkoutPath) => {
      const checkoutPathSha256 = hashText(path.resolve(checkoutPath));
      const head = await gitOutput(checkoutPath, ["rev-parse", "HEAD"]);
      if (head.trim() !== baseCommit) {
        return indeterminateExecution(
          checkoutInstanceId,
          checkoutPathSha256,
          `detached checkout HEAD ${head.trim()} does not match canonical base ${baseCommit}`
        );
      }

      let produced: SpeculativeDraftProducerResult;
      try {
        produced = validateProducerResult(await producer(checkoutPath));
      } catch (error: unknown) {
        const partial = await captureWorktreeDiff(checkoutPath, baseCommit);
        const diff = partial.ok ? partial.value.diff : "";
        await writeFile(patchPath, diff, "utf8");
        return {
          ...indeterminateExecution(
            checkoutInstanceId,
            checkoutPathSha256,
            `draft producer threw: ${errorMessage(error)}`
          ),
          outcome: "producer_exception" as const,
          changedFiles: await changedFiles(checkoutPath, baseCommit),
          diff
        };
      }

      const headAfterProducer = await gitOutput(checkoutPath, ["rev-parse", "HEAD"]);
      if (headAfterProducer.trim() !== baseCommit) {
        return indeterminateExecution(
          checkoutInstanceId,
          checkoutPathSha256,
          `draft producer changed detached checkout HEAD from canonical base ${baseCommit} to ${headAfterProducer.trim()}`,
          produced.output ?? [],
          produced.provenance ?? null
        );
      }
      const captured = await captureWorktreeDiff(checkoutPath, baseCommit);
      if (!captured.ok) {
        return indeterminateExecution(
          checkoutInstanceId,
          checkoutPathSha256,
          captured.reason,
          produced.output ?? [],
          produced.provenance ?? null
        );
      }
      await writeFile(patchPath, captured.value.diff, "utf8");
      const files = await changedFiles(checkoutPath, baseCommit);
      if (produced.status !== "completed") {
        return {
          outcome: produced.status === "crashed"
            ? "producer_crashed" as const
            : produced.status === "cancelled"
              ? "producer_cancelled" as const
              : "producer_timed_out" as const,
          reason: produced.reason,
          changedFiles: files,
          diff: captured.value.diff,
          output: produced.output ?? [],
          checkoutInstanceId,
          checkoutPathSha256,
          provenance: produced.provenance ?? null,
          gate: notRunGate(`draft producer ${produced.status}`),
          shadow: notRunShadow(`draft producer ${produced.status}`)
        };
      }
      if (captured.value.diff.trim() === "") {
        return {
          outcome: "empty" as const,
          reason: "speculative draft is empty",
          changedFiles: files,
          diff: captured.value.diff,
          output: produced.output ?? [],
          checkoutInstanceId,
          checkoutPathSha256,
          provenance: produced.provenance ?? null,
          gate: notRunGate("empty drafts are ineligible"),
          shadow: notRunShadow("empty drafts are ineligible")
        };
      }

      const gateResult = await runGate(baseCommit, patchPath, contract, config);
      const gate: DraftGateEvidence = {
        disposer: "runGate",
        status: gateResult.verdict,
        reason: gateResult.reason,
        result: gateResult
      };
      if (gateResult.verdict !== "accept" || gateResult.reason === "no changes") {
        return {
          outcome: "gate_rejected" as const,
          reason: `speculative draft scope gate ${gateResult.verdict}: ${gateResult.reason}`,
          changedFiles: files,
          diff: captured.value.diff,
          output: produced.output ?? [],
          checkoutInstanceId,
          checkoutPathSha256,
          provenance: produced.provenance ?? null,
          gate,
          shadow: notRunShadow("scope gate did not accept the draft")
        };
      }

      const verification = await runShadowVerification(
        repoRoot,
        checkoutPath,
        config,
        [admitted.task_id],
        files,
        {
          quality_run_id: admitted.quality_run_id,
          draft_id: draftId,
          task_id: admitted.task_id
        }
      );
      const shadow: DraftShadowEvidence = verification.ok
        ? {
            disposer: "runVerification",
            status: verification.value.tests,
            reason: verification.value.tests === "pass"
              ? "existing shadow verification passed"
              : "existing shadow verification failed",
            result: verification.value
          }
        : {
            disposer: "runVerification",
            status: "indeterminate",
            reason: verification.reason,
            result: null
          };
      return {
        outcome: shadow.status === "pass" ? "eligible" as const : "shadow_failed" as const,
        reason: shadow.reason,
        changedFiles: files,
        diff: captured.value.diff,
        output: produced.output ?? [],
        checkoutInstanceId,
        checkoutPathSha256,
        provenance: produced.provenance ?? null,
        gate,
        shadow
      };
    });
    return checkout.ok
      ? checkout.value
      : indeterminateExecution(checkoutInstanceId, "", checkout.reason);
  } catch (error: unknown) {
    return {
      ...indeterminateExecution(checkoutInstanceId, "", `detached checkout execution failed: ${errorMessage(error)}`),
      outcome: "producer_exception"
    };
  }
}

async function writeDraftArtifact(
  tempArtifactPath: string,
  admitted: AdmittedValueQualityRun,
  draftId: string,
  baseCommit: string,
  execution: CheckoutExecution
): Promise<void> {
  const diffSha256 = hashText(execution.diff);
  await writeFile(path.join(tempArtifactPath, "diff.patch"), execution.diff, "utf8");
  await writeFile(
    path.join(tempArtifactPath, "output.jsonl"),
    execution.output.map((entry, sequence) => JSON.stringify({ sequence, ...entry })).join("\n") +
      (execution.output.length === 0 ? "" : "\n"),
    "utf8"
  );
  await writeJsonAtomic(path.join(tempArtifactPath, "manifest.json"), {
    version: 1,
    quality_run_id: admitted.quality_run_id,
    draft_id: draftId,
    task_id: admitted.task_id,
    strategy: admitted.strategy,
    base_commit: baseCommit,
    canonical_contract_ref: `.hivemind/tasks/${admitted.task_id}.contract.json`,
    checkout: {
      detached: true,
      branch: null,
      instance_id: execution.checkoutInstanceId,
      path_sha256: execution.checkoutPathSha256
    },
    diff_sha256: diffSha256,
    changed_files: execution.changedFiles,
    outcome: execution.outcome,
    provenance: execution.provenance,
    advisory_only: true
  });
  await writeJsonAtomic(path.join(tempArtifactPath, "gate-result.json"), execution.gate);
  await writeJsonAtomic(path.join(tempArtifactPath, "shadow-result.json"), execution.shadow);
  await writeJsonAtomic(path.join(tempArtifactPath, "selection-evidence.json"), {
    version: 1,
    quality_run_id: admitted.quality_run_id,
    draft_id: draftId,
    eligible_for_selection: execution.outcome === "eligible",
    reason: execution.reason,
    gate_status: execution.gate.status,
    shadow_status: execution.shadow.status,
    advisory_only: true
  });
}

async function ensureQualityRunManifest(
  qualityRoot: string,
  admitted: AdmittedValueQualityRun,
  baseCommit: string
): Promise<void> {
  await mkdir(qualityRoot, { recursive: true });
  const manifestPath = path.join(qualityRoot, "manifest.json");
  const manifest = {
    version: 1,
    quality_run_id: admitted.quality_run_id,
    task_id: admitted.task_id,
    strategy: admitted.strategy,
    draft_count: admitted.draft_count,
    base_commit: baseCommit,
    canonical_contract_ref: `.hivemind/tasks/${admitted.task_id}.contract.json`,
    sequential_v1: true,
    advisory_only: true
  };
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
      throw new Error("existing quality-run manifest does not match the admitted durable run");
    }
    return;
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  const tempPath = path.join(qualityRoot, `.manifest.${process.pid}.${randomUUID()}.tmp`);
  await writeJsonAtomic(tempPath, manifest);
  try {
    await rename(tempPath, manifestPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function validateProducerResult(value: SpeculativeDraftProducerResult): SpeculativeDraftProducerResult {
  if (value.status !== "completed" && value.status !== "crashed" && value.status !== "timed_out" && value.status !== "cancelled") {
    throw new Error("draft producer returned an unsupported status");
  }
  if (value.status !== "completed" && (typeof value.reason !== "string" || value.reason.trim() === "")) {
    throw new Error("failed draft producer result must include a reason");
  }
  if (value.output !== undefined) {
    for (const entry of value.output) {
      if (
        (entry.stream !== "stdout" && entry.stream !== "stderr") ||
        typeof entry.text !== "string"
      ) {
        throw new Error("draft producer output must contain normalized stdout/stderr text records");
      }
    }
  }
  if (value.provenance !== undefined) {
    validateProducerProvenance(value.provenance);
  }
  return value;
}

function validateProducerProvenance(value: SpeculativeDraftProvenance): void {
  if (
    value.source !== "adapter" ||
    typeof value.tool !== "string" ||
    value.tool.trim() === "" ||
    (value.provider_tier !== "local" &&
      value.provider_tier !== "cheap" &&
      value.provider_tier !== "standard" &&
      value.provider_tier !== "strong") ||
    typeof value.profile_verified_on !== "string" ||
    value.profile_verified_on.trim() === "" ||
    typeof value.usage_session_id !== "string" ||
    value.usage_session_id.trim() === "" ||
    (value.exit_code !== null &&
      (!Number.isSafeInteger(value.exit_code) || Number(value.exit_code) < 0)) ||
    !Number.isSafeInteger(value.wall_time_ms) ||
    value.wall_time_ms < 0 ||
    (value.effective_tokens !== null &&
      (!Number.isSafeInteger(value.effective_tokens) || value.effective_tokens < 0)) ||
    (value.accounting_source !== null &&
      value.accounting_source !== "provider_reported" &&
      value.accounting_source !== "self_measured") ||
    (value.provider_usage_status !== null &&
      value.provider_usage_status !== "captured" &&
      value.provider_usage_status !== "not_available" &&
      value.provider_usage_status !== "expected_but_unparseable")
  ) {
    throw new Error("draft producer provenance is invalid");
  }
}

function validateDraftIdentity(
  admitted: AdmittedValueQualityRun,
  draftId: string
): string | null {
  const draftNumber = parseDraftId(draftId);
  if (admitted.strategy === "best_of_n") {
    if (draftNumber === null) {
      return "best-of-N draft_id must use D-001, D-002, or D-003";
    }
    if (admitted.draft_count !== null && draftNumber > admitted.draft_count) {
      return `draft ${draftNumber} exceeds admitted best-of-N count ${admitted.draft_count}`;
    }
    return null;
  }
  if (draftId !== "D-001" && draftId !== refinementId) {
    return "draft-refine artifact identity must use D-001 or R-001";
  }
  return null;
}

function parseDraftId(value: string): number | null {
  const match = value.match(draftIdPattern);
  return match === null ? null : Number(match[1]);
}

function notRunGate(reason: string): DraftGateEvidence {
  return { disposer: "runGate", status: "not_run", reason, result: null };
}

function notRunShadow(reason: string): DraftShadowEvidence {
  return { disposer: "runVerification", status: "not_run", reason, result: null };
}

function indeterminateExecution(
  checkoutInstanceId: string,
  checkoutPathSha256: string,
  reason: string,
  output: SpeculativeDraftOutput[] = [],
  provenance: SpeculativeDraftProvenance | null = null
): CheckoutExecution {
  return {
    outcome: "indeterminate",
    reason,
    changedFiles: [],
    diff: "",
    output,
    checkoutInstanceId,
    checkoutPathSha256,
    provenance,
    gate: notRunGate(reason),
    shadow: notRunShadow(reason)
  };
}

async function changedFiles(checkoutPath: string, baseCommit: string): Promise<string[]> {
  const output = await gitOutput(checkoutPath, ["diff", "--name-only", "-z", baseCommit]);
  return output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.replaceAll("\\", "/"))
    .sort((left, right) => left.localeCompare(right));
}

async function resolveCommit(
  repoRoot: string,
  commit: string
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: (await gitOutput(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`])).trim() };
  } catch (error: unknown) {
    return { ok: false, reason: `canonical base commit could not be resolved: ${errorMessage(error)}` };
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
  return result.stdout;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(path.join(filePath, "manifest.json"));
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function artifactRelativePath(repoRoot: string, artifactPath: string): string {
  return path.relative(repoRoot, artifactPath).replaceAll("\\", "/");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("stderr" in error && String(error.stderr).trim() !== "") {
      return String(error.stderr).trim();
    }
    if ("stdout" in error && String(error.stdout).trim() !== "") {
      return String(error.stdout).trim();
    }
  }
  return error instanceof Error && error.message.trim() !== "" ? error.message : "unknown error";
}
