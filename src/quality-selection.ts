import { isRecord } from "./json.js";
import { isNodeError } from "./error-detail.js";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./events.js";
import { writeImmutableJsonArtifact } from "./immutable-artifact.js";
import { findGitRoot } from "./repo.js";
import { loadAdmittedValueQualityRun } from "./value-quality.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

const selectionRuleId = "minimal_verified_change_surface_v1";
const selectionOrder = [
  "fewest changed files",
  "fewest changed patch lines",
  "smallest UTF-8 patch byte length",
  "lexical draft_id"
] as const;

interface QualityRunManifest {
  version: 1;
  quality_run_id: string;
  task_id: string;
  strategy: "best_of_n" | "draft_refine";
  draft_count: number | null;
  base_commit: string;
}

interface DraftSelectionInput {
  draft_id: string;
  artifact_path: string;
  eligible: boolean;
  eligibility_reason: string;
  outcome: string;
  diff_sha256: string;
  changed_files: string[];
  changed_file_count: number;
  changed_line_count: number;
  patch_bytes: number;
  gate_status: string;
  gate_reason: string;
  shadow_status: string;
  shadow_reason: string;
}

export interface QualitySelectionArtifact {
  version: 1;
  quality_run_id: string;
  task_id: string;
  strategy: "best_of_n" | "draft_refine";
  selection_rule: {
    id: typeof selectionRuleId;
    order: readonly string[];
    rationale: string;
  };
  candidates: DraftSelectionInput[];
  eligible_draft_ids: string[];
  selected_draft_id: string | null;
  selected_draft_artifact: string | null;
  no_winner_reason: string | null;
  advisory_only: true;
  automatic_adoption: false;
}

export type QualitySelectionResult =
  | { ok: true; value: QualitySelectionArtifact }
  | { ok: false; reason: string };

export async function selectQualityWinner(
  repoRoot: string,
  qualityRunId: string
): Promise<QualitySelectionResult> {
  const admitted = await loadAdmittedValueQualityRun(repoRoot, qualityRunId);
  if (!admitted.ok) {
    return admitted;
  }
  const qualityRoot = path.join(
    repoRoot,
    ".hivemind",
    "resource",
    "quality-runs",
    qualityRunId
  );
  const selectionPath = path.join(qualityRoot, "selection.json");
  if (await pathExists(selectionPath)) {
    return {
      ok: false,
      reason: `immutable quality selection already exists: ${relativePath(repoRoot, selectionPath)}`
    };
  }

  const runManifest = await readJsonRecord(path.join(qualityRoot, "manifest.json"));
  if (!runManifest.ok) {
    return runManifest;
  }
  const validatedRun = validateQualityRunManifest(
    runManifest.value,
    qualityRunId,
    admitted.value.task_id,
    admitted.value.strategy,
    admitted.value.draft_count
  );
  if (!validatedRun.ok) {
    return validatedRun;
  }

  const draftIds = admitted.value.strategy === "best_of_n"
    ? Array.from(
        { length: admitted.value.draft_count ?? 0 },
        (_, index) => `D-${String(index + 1).padStart(3, "0")}`
      )
    : ["D-001", "R-001"];
  const draftDirectoryCheck = await validateDraftDirectories(
    path.join(qualityRoot, "drafts"),
    draftIds
  );
  if (!draftDirectoryCheck.ok) {
    return draftDirectoryCheck;
  }

  const candidates: DraftSelectionInput[] = [];
  for (const draftId of draftIds) {
    const loaded = await loadDraftSelectionInput(
      repoRoot,
      qualityRoot,
      qualityRunId,
      admitted.value.task_id,
      admitted.value.strategy,
      validatedRun.value.base_commit,
      draftId
    );
    if (!loaded.ok) {
      return loaded;
    }
    candidates.push(loaded.value);
  }

  const eligible = candidates.filter((candidate) => candidate.eligible).sort(compareCandidates);
  const selected = eligible[0] ?? null;
  const artifact: QualitySelectionArtifact = {
    version: 1,
    quality_run_id: qualityRunId,
    task_id: admitted.value.task_id,
    strategy: admitted.value.strategy,
    selection_rule: {
      id: selectionRuleId,
      order: selectionOrder,
      rationale:
        "When deterministic gate and shadow evidence tie, prefer the smallest verified change surface; lexical draft_id is the final stable tie-break."
    },
    candidates,
    eligible_draft_ids: eligible.map((candidate) => candidate.draft_id),
    selected_draft_id: selected?.draft_id ?? null,
    selected_draft_artifact: selected?.artifact_path ?? null,
    no_winner_reason:
      selected === null
        ? "no draft had a non-empty patch accepted by runGate and passing shadow verification"
        : null,
    advisory_only: true,
    automatic_adoption: false
  };

  try {
    await writeImmutableJsonArtifact(selectionPath, artifact);
  } catch (error: unknown) {
    return { ok: false, reason: `quality selection could not be finalized: ${errorMessage(error)}` };
  }

  const recorded = await appendEvent(repoRoot, {
    type: "quality.selection_decided",
    task_id: admitted.value.task_id,
    data: {
      version: 1,
      quality_run_id: qualityRunId,
      strategy: artifact.strategy,
      selection_artifact: relativePath(repoRoot, selectionPath),
      selection_rule: artifact.selection_rule,
      candidates: artifact.candidates,
      eligible_draft_ids: artifact.eligible_draft_ids,
      selected_draft_id: artifact.selected_draft_id,
      no_winner_reason: artifact.no_winner_reason,
      advisory_only: true,
      automatic_adoption: false
    }
  });
  return recorded.ok
    ? { ok: true, value: artifact }
    : {
        ok: false,
        reason: `selection artifact was written but quality.selection_decided could not be appended: ${recorded.reason}`
      };
}

export async function qualitySelectionCommand(cwd: string, args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "select" || args[1].trim() === "") {
    console.error("error: usage: hivemind quality select <quality-run-id>");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }
  const result = await selectQualityWinner(repoRoot, args[1]);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

async function loadDraftSelectionInput(
  repoRoot: string,
  qualityRoot: string,
  qualityRunId: string,
  taskId: string,
  strategy: QualitySelectionArtifact["strategy"],
  baseCommit: string,
  draftId: string
): Promise<{ ok: true; value: DraftSelectionInput } | { ok: false; reason: string }> {
  const draftRoot = path.join(qualityRoot, "drafts", draftId);
  const manifestResult = await readJsonRecord(path.join(draftRoot, "manifest.json"));
  const gateResult = await readJsonRecord(path.join(draftRoot, "gate-result.json"));
  const shadowResult = await readJsonRecord(path.join(draftRoot, "shadow-result.json"));
  if (!manifestResult.ok) {
    return manifestResult;
  }
  if (!gateResult.ok) {
    return gateResult;
  }
  if (!shadowResult.ok) {
    return shadowResult;
  }

  const manifest = manifestResult.value;
  const changedFiles = stringArray(manifest.changed_files);
  const gated = checkFormatVersion(manifest, formatVersions.qualityDraftManifest, `draft ${draftId} manifest`);
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (
    manifest.quality_run_id !== qualityRunId ||
    manifest.draft_id !== draftId ||
    manifest.task_id !== taskId ||
    manifest.strategy !== strategy ||
    manifest.base_commit !== baseCommit ||
    typeof manifest.outcome !== "string" ||
    changedFiles === null ||
    typeof manifest.diff_sha256 !== "string"
  ) {
    return { ok: false, reason: `invalid or mismatched immutable draft manifest: ${draftId}` };
  }

  let patch: string;
  try {
    patch = await readFile(path.join(draftRoot, "diff.patch"), "utf8");
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `could not read immutable draft patch ${draftId}: ${errorMessage(error)}`
    };
  }
  const patchHash = hashText(patch);
  if (patchHash !== manifest.diff_sha256) {
    return {
      ok: false,
      reason: `immutable draft patch hash does not match manifest for ${draftId}`
    };
  }

  const gateStatus = typeof gateResult.value.status === "string"
    ? gateResult.value.status
    : "invalid";
  const gateReason = typeof gateResult.value.reason === "string"
    ? gateResult.value.reason
    : "gate evidence is malformed";
  const gateAccepted =
    gateResult.value.disposer === "runGate" &&
    gateStatus === "accept" &&
    gateReason !== "no changes" &&
    isRecord(gateResult.value.result) &&
    gateResult.value.result.verdict === "accept" &&
    gateResult.value.result.reason !== "no changes";

  const shadowStatus = typeof shadowResult.value.status === "string"
    ? shadowResult.value.status
    : "invalid";
  const shadowReason = typeof shadowResult.value.reason === "string"
    ? shadowResult.value.reason
    : "shadow evidence is malformed";
  const shadowPassed =
    shadowResult.value.disposer === "runVerification" &&
    shadowStatus === "pass" &&
    isRecord(shadowResult.value.result) &&
    shadowResult.value.result.tests === "pass";
  const nonEmpty = patch.trim() !== "";
  const outcomeEligible = manifest.outcome === "eligible";
  const eligible = nonEmpty && outcomeEligible && gateAccepted && shadowPassed;

  return {
    ok: true,
    value: {
      draft_id: draftId,
      artifact_path: relativePath(repoRoot, draftRoot),
      eligible,
      eligibility_reason: eligibilityReason(
        nonEmpty,
        String(manifest.outcome),
        gateStatus,
        gateReason,
        shadowStatus,
        shadowReason,
        eligible
      ),
      outcome: manifest.outcome,
      diff_sha256: patchHash,
      changed_files: changedFiles,
      changed_file_count: changedFiles.length,
      changed_line_count: countChangedLines(patch),
      patch_bytes: Buffer.byteLength(patch, "utf8"),
      gate_status: gateStatus,
      gate_reason: gateReason,
      shadow_status: shadowStatus,
      shadow_reason: shadowReason
    }
  };
}

function eligibilityReason(
  nonEmpty: boolean,
  outcome: string,
  gateStatus: string,
  gateReason: string,
  shadowStatus: string,
  shadowReason: string,
  eligible: boolean
): string {
  if (eligible) {
    return "non-empty patch passed runGate and shadow verification";
  }
  if (!nonEmpty) {
    return "empty patch is ineligible";
  }
  if (gateStatus === "escalate") {
    return `scope gate escalation requires human handling and is not auto-eligible: ${gateReason}`;
  }
  if (gateStatus !== "accept" || gateReason === "no changes") {
    return `scope gate ${gateStatus}: ${gateReason}`;
  }
  if (shadowStatus !== "pass") {
    return `shadow verification ${shadowStatus}: ${shadowReason}`;
  }
  return `draft outcome ${outcome} is not eligible`;
}

function compareCandidates(left: DraftSelectionInput, right: DraftSelectionInput): number {
  return (
    left.changed_file_count - right.changed_file_count ||
    left.changed_line_count - right.changed_line_count ||
    left.patch_bytes - right.patch_bytes ||
    left.draft_id.localeCompare(right.draft_id)
  );
}

function countChangedLines(patch: string): number {
  return patch.split(/\r?\n/u).filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  ).length;
}

async function validateDraftDirectories(
  draftsRoot: string,
  expectedDraftIds: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const entries = await readdir(draftsRoot, { withFileTypes: true });
    const actual = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expectedDraftIds].sort())) {
      return {
        ok: false,
        reason: `quality run draft set is incomplete or unexpected: expected ${expectedDraftIds.join(", ")}, found ${actual.join(", ") || "(none)"}`
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: `could not read quality-run drafts: ${errorMessage(error)}` };
  }
}

function validateQualityRunManifest(
  value: Record<string, unknown>,
  qualityRunId: string,
  taskId: string,
  strategy: QualitySelectionArtifact["strategy"],
  draftCount: number | null
): { ok: true; value: QualityRunManifest } | { ok: false; reason: string } {
  const gated = checkFormatVersion(value, formatVersions.qualitySelection, "the quality run manifest");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (
    value.quality_run_id !== qualityRunId ||
    value.task_id !== taskId ||
    value.strategy !== strategy ||
    value.draft_count !== draftCount ||
    typeof value.base_commit !== "string" ||
    value.base_commit.trim() === ""
  ) {
    return { ok: false, reason: "quality-run manifest does not match the admitted durable run" };
  }
  return { ok: true, value: value as unknown as QualityRunManifest };
}

async function readJsonRecord(
  filePath: string
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, reason: `JSON artifact is not an object: ${filePath}` };
  } catch (error: unknown) {
    return { ok: false, reason: `could not read JSON artifact ${filePath}: ${errorMessage(error)}` };
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  const strings = value as string[];
  return new Set(strings).size === strings.length ? strings : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function relativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unexpected error";
}
